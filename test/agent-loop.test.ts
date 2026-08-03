import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, type AgentEvent } from '../src/kernel/agent.js';
import { PermissionGate } from '../src/permission/gate.js';
import { countTokens } from '../src/kernel/tokenizer.js';
import { newId } from '../src/kernel/id.js';
import { readFileTool, editFileTool } from '../src/tools/fs.js';
import { grepTool, globTool } from '../src/tools/search.js';
import { createTaskTool } from '../src/tools/task.js';
import type {
  Provider,
  ProviderMessage,
  Tool,
  ToolCall,
  SessionMessage,
  ChatRequest,
} from '../src/kernel/types.js';

/** Build a fake tool whose execute() runs `fn`. */
function makeTool(name: string, fn: (args: Record<string, unknown>) => number | string): Tool {
  return {
    definition: { name, description: name, inputSchema: { type: 'object', properties: {} } },
    execute: async (args) => String(fn(args)),
  };
}

const add = makeTool('add', (a) => (a.a as number) + (a.b as number));

type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };

/**
 * A provider that "reasons": it inspects the whole conversation so far and
 * decides its next move (request tools, then answer). This is what lets us
 * exercise real multi-turn tool loops without a network model.
 */
function makeScripted(respond: (req: ChatRequest) => Reply): Provider {
  return {
    id: 'scripted',
    countTokens: (t) => countTokens(t),
    async *chat(req) {
      const r = respond(req);
      if (r.calls) {
        yield {
          type: 'tool_calls',
          calls: r.calls.map((c): ToolCall => ({
            id: newId('call'),
            name: c.name,
            args: JSON.stringify(c.args),
          })),
        };
      }
      if (r.text) yield { type: 'text', text: r.text };
      yield { type: 'finish', usage: { input: 10, output: 10 } };
    },
  };
}

/** respond receives just the messages (most tests). */
function scriptedProvider(respond: (messages: ProviderMessage[]) => Reply): Provider {
  return makeScripted((req) => respond(req.messages));
}

/** respond receives the full ChatRequest — lets sub-agent tests branch on req.system. */
function scriptedByRole(respond: (req: ChatRequest) => Reply): Provider {
  return makeScripted(respond);
}

const lastTool = (msgs: ProviderMessage[]): ProviderMessage | undefined => {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === 'tool') return msgs[i];
  return undefined;
};

/** Run one turn and collect every event + the joined final assistant text. */
async function run(
  agent: Agent,
  prompt: string,
): Promise<{ events: AgentEvent[]; finalText: string }> {
  const events: AgentEvent[] = [];
  for await (const ev of agent.run(prompt)) events.push(ev);
  const finalText = events
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text)
    .join('');
  return { events, finalText };
}

const allowAll = new PermissionGate({ rules: {}, ask: async () => 'yes' as const });

test('agent completes a task requiring one tool call', async () => {
  const provider = scriptedProvider((msgs) => {
    // After the tool result comes back, the model answers from it.
    const last = lastTool(msgs);
    if (last) return { text: `answer: ${last.content}` };
    return { calls: [{ name: 'add', args: { a: 2, b: 3 } }] };
  });
  const agent = new Agent({ provider, tools: [add], permission: allowAll });
  const { events, finalText } = await run(agent, 'what is 2+3?');
  assert.equal(finalText, 'answer: 5');
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'add'));
  const res = events.find((e) => e.type === 'tool_result') as
    Extract<AgentEvent, { type: 'tool_result' }> | undefined;
  assert.equal(res?.output, '5');
  assert.equal(events[events.length - 1]!.type, 'finish');
});

test('agent chains two tool calls, feeding the previous result into the next', async () => {
  const square = makeTool('square', (a) => (a.x as number) ** 2);
  const provider = scriptedProvider((msgs) => {
    const toolResults = msgs.filter((m) => m.role === 'tool');
    if (toolResults.length === 0) return { calls: [{ name: 'square', args: { x: 4 } }] };
    if (toolResults.length === 1) {
      // "reason": use square(4)=16 as input for the next step
      const val = Number(toolResults[0]!.content);
      return { calls: [{ name: 'add', args: { a: val, b: 1 } }] };
    }
    return { text: `final: ${toolResults[1]!.content}` };
  });
  const agent = new Agent({ provider, tools: [square, add], permission: allowAll });
  const { events, finalText } = await run(agent, 'compute (4^2)+1');
  assert.equal(finalText, 'final: 17');
  const results = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  assert.deepEqual(
    results.map((r) => r.output),
    ['16', '17'],
  );
  const finish = events[events.length - 1] as Extract<AgentEvent, { type: 'finish' }>;
  assert.ok(finish.steps >= 2, `expected >=2 steps, got ${finish.steps}`);
});

test('tool failure is fed back and the model adapts', async () => {
  const boom = makeTool('boom', () => {
    throw new Error('disk full');
  });
  const provider = scriptedProvider((msgs) => {
    const last = lastTool(msgs);
    if (last) return { text: `recovered: ${last.content}` };
    return { calls: [{ name: 'boom', args: {} }] };
  });
  const agent = new Agent({ provider, tools: [boom], permission: allowAll });
  const { events, finalText } = await run(agent, 'try it');
  assert.ok(finalText.includes('error: disk full'), `got: ${finalText}`);
  const res = events.find((e) => e.type === 'tool_result') as Extract<
    AgentEvent,
    { type: 'tool_result' }
  >;
  assert.equal(res.output, 'error: disk full');
});

test('stateful multi-step work: counter tool called 3 times', async () => {
  let count = 0;
  const bump = makeTool('bump', () => ++count);
  const provider = scriptedProvider((msgs) => {
    const done = msgs.filter((m) => m.role === 'tool').length;
    if (done < 3) return { calls: [{ name: 'bump', args: {} }] };
    return { text: `count is ${count}` };
  });
  const agent = new Agent({ provider, tools: [bump], permission: allowAll });
  const { events, finalText } = await run(agent, 'bump it three times');
  assert.equal(finalText, 'count is 3');
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 3);
});

test('runaway tool loop stops at maxSteps', async () => {
  const provider = scriptedProvider(() => ({ calls: [{ name: 'add', args: { a: 1, b: 2 } }] }));
  const agent = new Agent({ provider, tools: [add], permission: allowAll, maxSteps: 3 });
  const { events } = await run(agent, 'loop forever');
  const finish = events[events.length - 1] as Extract<AgentEvent, { type: 'finish' }>;
  assert.equal(finish.type, 'finish');
  assert.equal(finish.steps, 3);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 3);
});

test('permission-denied tool result is fed back to the model', async () => {
  const gate = new PermissionGate({ rules: { write: 'deny' }, ask: async () => 'no' as const });
  const provider = scriptedProvider((msgs) => {
    const last = lastTool(msgs);
    if (last) return { text: `model saw: ${last.content}` };
    return { calls: [{ name: 'write', args: { path: '/tmp/x' } }] };
  });
  const agent = new Agent({
    provider,
    tools: [add, makeTool('write', () => 'wrote')],
    permission: gate,
  });
  const { events, finalText } = await run(agent, 'write a file');
  assert.ok(
    events.some((e) => e.type === 'permission' && e.name === 'write' && e.allowed === false),
  );
  assert.ok(finalText.includes('[permission denied by user]'), `got: ${finalText}`);
});

test('unknown tool is reported back to the model', async () => {
  const provider = scriptedProvider((msgs) => {
    const last = lastTool(msgs);
    if (last) return { text: `model saw: ${last.content}` };
    return { calls: [{ name: 'ghost', args: {} }] };
  });
  const agent = new Agent({ provider, tools: [add], permission: allowAll });
  const { events, finalText } = await run(agent, 'use ghost');
  const res = events.find((e) => e.type === 'tool_result') as Extract<
    AgentEvent,
    { type: 'tool_result' }
  >;
  assert.equal(res.output, 'unknown tool: ghost');
  assert.ok(finalText.includes('unknown tool: ghost'));
});

test('onBeforeTool plugin hook can block a tool', async () => {
  const provider = scriptedProvider((msgs) => {
    const last = lastTool(msgs);
    if (last) return { text: `model saw: ${last.content}` };
    return { calls: [{ name: 'add', args: { a: 1, b: 2 } }] };
  });
  const agent = new Agent({
    provider,
    tools: [add],
    permission: allowAll,
    onBeforeTool: async () => ({ allowed: false }),
  });
  const { events, finalText } = await run(agent, 'add');
  assert.ok(events.some((e) => e.type === 'permission' && e.name === 'add' && e.allowed === false));
  const res = events.find((e) => e.type === 'tool_result') as Extract<
    AgentEvent,
    { type: 'tool_result' }
  >;
  assert.equal(res.output, '[blocked by plugin]');
  assert.ok(finalText.includes('[blocked by plugin]'));
});

test('agent aggregates token usage across all model calls (not just the last)', async () => {
  const provider = scriptedProvider((msgs) => {
    const n = msgs.filter((m) => m.role === 'tool').length;
    if (n < 2) return { calls: [{ name: 'add', args: { a: 1, b: 2 } }] };
    return { text: 'done' };
  });
  const agent = new Agent({ provider, tools: [add], permission: allowAll });
  const { events } = await run(agent, 'add twice');
  const finish = events[events.length - 1] as Extract<AgentEvent, { type: 'finish' }>;
  // scriptedProvider reports {input:10, output:10} per chat; 3 model calls total
  assert.deepEqual(finish.usage, { input: 30, output: 30 });
});

test('onMessage records the full user/assistant/tool conversation', async () => {
  const recorded: SessionMessage[] = [];
  const provider = scriptedProvider((msgs) => {
    const last = lastTool(msgs);
    if (last) return { text: `answer: ${last.content}` };
    return { calls: [{ name: 'add', args: { a: 1, b: 2 } }] };
  });
  const agent = new Agent({
    provider,
    tools: [add],
    permission: allowAll,
    onMessage: (m) => recorded.push(m),
  });
  await run(agent, '1+2?');
  assert.deepEqual(
    recorded.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  // the last assistant message carries the tool result context
  const toolMsg = recorded[2]!;
  assert.equal(toolMsg.content, '3');
  assert.equal(recorded[3]!.content, 'answer: 3');
});

test('onCompact fires after auto-compaction and receives the trimmed history', async () => {
  const compacted: SessionMessage[][] = [];
  // ~100 tokens per message (400 chars), 30 messages ≈ 3k tokens > budget 500
  const history: SessionMessage[] = Array.from({ length: 30 }, (_, i) => ({
    id: newId('msg'),
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(400),
    ts: Date.now(),
  }));
  const provider = scriptedProvider(() => ({ text: 'done' }));
  const agent = new Agent({
    provider,
    tools: [add],
    permission: allowAll,
    history,
    contextBudget: 500,
    preserveRecentTokens: 100,
    onCompact: (msgs) => compacted.push(msgs),
  });
  const { events } = await run(agent, 'hello');
  assert.ok(events.some((e) => e.type === 'compacting'));
  assert.equal(compacted.length, 1);
  assert.ok(compacted[0]![0]!.content.includes('[compacted summary'));
  assert.ok(compacted[0]!.length < history.length);
});

// ---- Realistic scenarios: real fs tools + a temp project --------------------

test('realistic: debug-and-retry loop — read, edit, run tests, fix remaining bug, all pass', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-agent-'));
  try {
    mkdirSync(join(tmp, 'lib'));
    mkdirSync(join(tmp, 'test'));
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    // Two bugs: add() subtracts, mul() is off by one.
    writeFileSync(
      join(tmp, 'lib', 'math.js'),
      'export function add(a, b) {\n  return a - b; // bug 1\n}\n' +
        'export function mul(a, b) {\n  return a * b - 1; // bug 2\n}\n',
    );
    writeFileSync(
      join(tmp, 'test', 'math.test.js'),
      'import { add, mul } from "../lib/math.js";\n' +
        'let fails = 0;\n' +
        'if (add(2, 3) !== 5) { console.error("FAIL add"); fails++; }\n' +
        'if (mul(3, 4) !== 12) { console.error("FAIL mul"); fails++; }\n' +
        'if (fails) { console.error("test FAILED"); process.exit(1); }\n' +
        'console.log("ALL PASS");\n',
    );

    const runTest: Tool = {
      definition: {
        name: 'run_test',
        description: 'run the project test suite',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        try {
          const out = execFileSync(process.execPath, ['test/math.test.js'], {
            cwd: tmp,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return out.trim() || 'test passed (no output)';
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; status?: number };
          return `test FAILED (exit ${err.status ?? '?'}): ${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
        }
      },
    };

    // The model "reads" the source, fixes one bug, runs tests, sees the failure
    // output, fixes the second bug, and re-runs until green — a real debug loop.
    const provider = scriptedProvider((msgs) => {
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      const last = toolMsgs[toolMsgs.length - 1]?.content ?? '';
      if (toolMsgs.length === 0)
        return { calls: [{ name: 'read_file', args: { path: 'lib/math.js' } }] };
      if (last.startsWith('export function'))
        return {
          calls: [
            {
              name: 'edit_file',
              args: {
                path: 'lib/math.js',
                old_string: 'return a - b;',
                new_string: 'return a + b;',
              },
            },
          ],
        };
      if (last.startsWith('replaced')) return { calls: [{ name: 'run_test', args: {} }] };
      if (last.startsWith('test FAILED'))
        return {
          calls: [
            {
              name: 'edit_file',
              args: {
                path: 'lib/math.js',
                old_string: 'return a * b - 1;',
                new_string: 'return a * b;',
              },
            },
          ],
        };
      if (last.startsWith('ALL PASS')) return { text: 'Fixed both bugs; all tests pass.' };
      return { calls: [{ name: 'run_test', args: {} }] };
    });

    const agent = new Agent({
      provider,
      tools: [readFileTool(), editFileTool(), runTest],
      permission: allowAll,
      cwd: tmp,
    });
    const { events, finalText } = await run(agent, 'fix the math library so all tests pass');
    assert.equal(finalText, 'Fixed both bugs; all tests pass.');
    const testRuns = events.filter((e) => e.type === 'tool_start' && e.name === 'run_test');
    assert.equal(testRuns.length, 2, 'expected one failing run then a green run');
    const results = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && e.name === 'run_test',
    );
    assert.ok(results[0]!.output.includes('FAIL mul'), `first run output: ${results[0]!.output}`);
    assert.ok(results[1]!.output.includes('ALL PASS'), `second run output: ${results[1]!.output}`);
    // the file on disk was actually repaired
    const src = readFileSync(join(tmp, 'lib', 'math.js'), 'utf8');
    assert.ok(src.includes('return a + b;'));
    assert.ok(src.includes('return a * b;'));
    assert.ok(!src.includes('a - b;'));
    assert.ok(!src.includes('b - 1'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('realistic: explores a project with glob+grep+read_file to answer a question', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-explore-'));
  try {
    mkdirSync(join(tmp, 'data'));
    writeFileSync(join(tmp, 'data', 'a.txt'), 'hello world\n');
    writeFileSync(join(tmp, 'data', 'b.txt'), 'the secret is 42\n');
    writeFileSync(join(tmp, 'data', 'c.md'), 'docs\n');

    const provider = scriptedProvider((msgs) => {
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      const n = toolMsgs.length;
      const last = toolMsgs[n - 1]?.content ?? '';
      if (n === 0) return { calls: [{ name: 'glob', args: { pattern: '**/*' } }] };
      if (n === 1) {
        // glob listed the tree → narrow down with grep (or jump straight to the file)
        if (last.includes('b.txt'))
          return { calls: [{ name: 'grep', args: { pattern: 'secret' } }] };
        return { calls: [{ name: 'read_file', args: { path: 'data/b.txt' } }] };
      }
      if (n === 2) {
        // grep found the hit → read the file containing it
        return { calls: [{ name: 'read_file', args: { path: 'data/b.txt' } }] };
      }
      return { text: 'The answer is 42.' };
    });

    const agent = new Agent({
      provider,
      tools: [globTool(), grepTool(), readFileTool()],
      permission: allowAll,
      cwd: tmp,
    });
    const { events, finalText } = await run(agent, 'what is the secret?');
    assert.equal(finalText, 'The answer is 42.');
    assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'grep'));
    assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'glob'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('parallel: one turn requests two tool calls and both results feed back', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-para-'));
  try {
    writeFileSync(join(tmp, 'a.txt'), 'AAA\n');
    writeFileSync(join(tmp, 'b.txt'), 'BBB\n');
    const provider = scriptedProvider((msgs) => {
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      if (toolMsgs.length === 0) {
        return {
          calls: [
            { name: 'read_file', args: { path: 'a.txt' } },
            { name: 'read_file', args: { path: 'b.txt' } },
          ],
        };
      }
      const contents = toolMsgs.map((m) => m.content.trim()).join(' | ');
      return { text: `saw: ${contents}` };
    });
    const agent = new Agent({ provider, tools: [readFileTool()], permission: allowAll, cwd: tmp });
    const { events, finalText } = await run(agent, 'read both files');
    assert.equal(finalText, 'saw: AAA | BBB');
    const results = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r) => r.output.trim()),
      ['AAA', 'BBB'],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('concurrent: tools from one turn execute in parallel (overlap detected)', async () => {
  let active = 0;
  let maxActive = 0;
  const slow: Tool = {
    definition: {
      name: 'slow',
      description: 'slow tool',
      inputSchema: { type: 'object', properties: {} },
    },
    execute: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return 'ok';
    },
  };
  const provider = scriptedProvider((msgs) => {
    const n = msgs.filter((m) => m.role === 'tool').length;
    if (n === 0) {
      return {
        calls: [
          { name: 'slow', args: {} },
          { name: 'slow', args: {} },
          { name: 'slow', args: {} },
        ],
      };
    }
    return { text: `done ${n}` };
  });
  const agent = new Agent({ provider, tools: [slow], permission: allowAll });
  const { events, finalText } = await run(agent, 'run three in parallel');
  assert.equal(finalText, 'done 3');
  // if execution were sequential, maxActive would be 1; concurrency ⇒ 3
  assert.equal(maxActive, 3, `expected 3 concurrent executions, saw max ${maxActive}`);
  // emission order is preserved: all tool_starts precede the first tool_result
  const kinds = events.map((e) => e.type);
  const lastStart = kinds.lastIndexOf('tool_start');
  const firstResult = kinds.indexOf('tool_result');
  assert.ok(lastStart < firstResult, `starts should precede results: ${JSON.stringify(kinds)}`);
});

// ---- Multi sub-agent scenarios ----------------------------------------------

test('sub-agents: parent delegates two subtasks in parallel and uses both summaries', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-sub-'));
  try {
    writeFileSync(join(tmp, 'note-a.txt'), 'ALPHA\n');
    writeFileSync(join(tmp, 'note-b.txt'), 'BETA\n');

    const provider = scriptedByRole((req) => {
      const isSub = req.system?.some((s) => s.includes('sub-agent')) ?? false;
      const msgs = req.messages;
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      if (isSub) {
        // a sub-agent: read its target file, then summarize
        const taskText = msgs[0]?.content ?? '';
        const file = taskText.includes('A') ? 'note-a.txt' : 'note-b.txt';
        if (toolMsgs.length === 0) return { calls: [{ name: 'read_file', args: { path: file } }] };
        return { text: `subagent(${file}) saw: ${toolMsgs[toolMsgs.length - 1]!.content.trim()}` };
      }
      // the parent: delegate two subtasks in one turn, then combine the summaries
      if (toolMsgs.length === 0) {
        return {
          calls: [
            { name: 'task', args: { task: 'read note A' } },
            { name: 'task', args: { task: 'read note B' } },
          ],
        };
      }
      const summaries = toolMsgs.map((m) => m.content.trim());
      return { text: `parent: ${summaries.join(' | ')}` };
    });

    const taskTool = createTaskTool({ provider, permission: allowAll, cwd: tmp, home: tmpdir() });
    const agent = new Agent({ provider, tools: [taskTool], permission: allowAll, cwd: tmp });
    const { events, finalText } = await run(agent, 'read both notes via sub-agents');
    // both summaries carry the real file content read by the sub-agents
    assert.ok(finalText.includes('note-a.txt) saw: ALPHA'), `got: ${finalText}`);
    assert.ok(finalText.includes('note-b.txt) saw: BETA'), `got: ${finalText}`);
    const taskStarts = events.filter((e) => e.type === 'tool_start' && e.name === 'task');
    assert.equal(taskStarts.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sub-agents: parent chains a second subtask that depends on the first summary', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-chain-'));
  try {
    writeFileSync(join(tmp, 'config-a.txt'), '8080\n');
    writeFileSync(join(tmp, 'config-b.txt'), 'the server runs on port 8080\n');

    const provider = scriptedByRole((req) => {
      const isSub = req.system?.some((s) => s.includes('sub-agent')) ?? false;
      const msgs = req.messages;
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      if (isSub) {
        const taskText = msgs[0]?.content ?? '';
        const file = taskText.includes('b') ? 'config-b.txt' : 'config-a.txt';
        if (toolMsgs.length === 0) return { calls: [{ name: 'read_file', args: { path: file } }] };
        return { text: `subagent: ${toolMsgs[toolMsgs.length - 1]!.content.trim()}` };
      }
      if (toolMsgs.length === 0)
        return { calls: [{ name: 'task', args: { task: 'read config a' } }] };
      if (toolMsgs.length === 1) {
        // thread the first sub-agent's summary (the port) into the next subtask
        const port = toolMsgs[0]!.content.match(/\d+/)?.[0] ?? '?';
        return {
          calls: [
            { name: 'task', args: { task: `read config b and confirm it mentions ${port}` } },
          ],
        };
      }
      const summaries = toolMsgs.map((m) => m.content.trim());
      return { text: `parent: ${summaries.join(' | ')}` };
    });

    const taskTool = createTaskTool({ provider, permission: allowAll, cwd: tmp, home: tmpdir() });
    const agent = new Agent({ provider, tools: [taskTool], permission: allowAll, cwd: tmp });
    const { events, finalText } = await run(agent, 'read config a then verify config b');
    // the parent learned "8080" from the first sub-agent and used it in the second
    assert.ok(finalText.includes('8080'), `got: ${finalText}`);
    assert.equal(events.filter((e) => e.type === 'tool_start' && e.name === 'task').length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sub-agents: a failing subtask surfaces its error to the parent', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-subfail-'));
  try {
    const provider = scriptedByRole((req) => {
      const isSub = req.system?.some((s) => s.includes('sub-agent')) ?? false;
      const msgs = req.messages;
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      if (isSub) {
        if (toolMsgs.length === 0)
          return { calls: [{ name: 'read_file', args: { path: 'missing.txt' } }] };
        return { text: `subagent result: ${toolMsgs[toolMsgs.length - 1]!.content}` };
      }
      if (toolMsgs.length === 0)
        return { calls: [{ name: 'task', args: { task: 'read missing file' } }] };
      return { text: `parent handled: ${toolMsgs[toolMsgs.length - 1]!.content.trim()}` };
    });

    const taskTool = createTaskTool({ provider, permission: allowAll, cwd: tmp, home: tmpdir() });
    const agent = new Agent({ provider, tools: [taskTool], permission: allowAll, cwd: tmp });
    const { finalText } = await run(agent, 'delegate a read of a missing file');
    // the sub-agent's failed read (real fs error) propagates up through the summary
    assert.ok(finalText.includes('no such file'), `got: ${finalText}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
