/**
 * End-to-end tests driven by recorded provider responses (P3.2): each fixture
 * is a scripted conversation; the Agent runs against it offline and we assert
 * the resulting behavior. Deterministic, fast, and free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentEvent } from '../src/kernel/agent.js';
import { PermissionGate } from '../src/permission/gate.js';
import { defaultTools } from '../src/tools/index.js';
import { createTaskTool } from '../src/tools/task.js';
import { createScriptedProvider, type ScriptedConversation } from './util/scripted.js';
import type { Tool } from '../src/kernel/types.js';
import { repoRoot } from './root.js';

const FIXTURES = join(repoRoot(), 'test', 'fixtures');

function loadFixture(name: string): { convos: ScriptedConversation[] } {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    convos: ScriptedConversation[];
  };
}

const allowAll = new PermissionGate({ rules: {}, ask: async () => 'yes' as const });

/** A real tool the scripted provider can call; big results drive context growth. */
function nopTool(seed: string): Tool {
  return {
    definition: {
      name: 'nop',
      description: 'no-op',
      inputSchema: { type: 'object', properties: {} },
    },
    execute: async () => seed,
  };
}

async function runAgent(
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

test('e2e: explore fixture — glob + read_file round-trip on a real project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-e2e-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function helper() { return 1; }\n');
    const { provider, stats } = createScriptedProvider(loadFixture('explore').convos);
    const agent = new Agent({
      provider,
      tools: defaultTools(),
      permission: allowAll,
      cwd: dir,
      home: dir,
    });
    const { events, finalText } = await runAgent(agent, 'explore the project');
    assert.ok(finalText.includes('Found file src/a.ts'), finalText);
    assert.equal(events[events.length - 1]!.type, 'finish');
    assert.equal(stats.requests, 3);
    assert.ok(stats.input > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: compact fixture — repeated compaction keeps total input flat', async () => {
  const { provider, stats } = createScriptedProvider(loadFixture('compact').convos);
  const agent = new Agent({
    provider,
    tools: [nopTool('x'.repeat(400))], // ~100 tokens of tool result per step
    permission: allowAll,
    system: ['you are a test'],
    contextBudget: 600,
    preserveRecentTokens: 200,
    maxSteps: 24,
  });
  const { events } = await runAgent(agent, 'summarize the full history');
  assert.ok(
    events.some((e) => e.type === 'compacting'),
    'compaction should have run',
  );
  assert.equal(events[events.length - 1]!.type, 'finish');
  // Without compaction, 24 requests with ever-growing history would send
  // roughly 30k+ input tokens; compaction should keep it well below that.
  assert.ok(stats.input > 3_000, `input ${stats.input} looks too small`);
  assert.ok(stats.input < 20_000, `input ${stats.input} should be compacted`);
  assert.ok(stats.requests >= 20, `expected a long multi-step run, got ${stats.requests}`);
});

test('e2e: fanout fixture — parallel sub-agents merge into the parent report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-e2e-'));
  try {
    const { provider, stats } = createScriptedProvider(loadFixture('fanout').convos);
    const agent = new Agent({
      provider,
      tools: [
        createTaskTool({
          provider,
          permission: allowAll,
          cwd: dir,
          home: dir,
        }),
      ],
      permission: allowAll,
      cwd: dir,
      home: dir,
    });
    const { events, finalText } = await runAgent(agent, 'research the codebase');
    assert.ok(finalText.includes('merged findings'), finalText);
    assert.ok(finalText.includes('summary A'), finalText);
    assert.ok(finalText.includes('summary B'), finalText);
    assert.equal(events[events.length - 1]!.type, 'finish');
    // 1 parent call → 2 sub-agent calls (parallel) → 1 parent call.
    assert.ok(stats.requests >= 4, `expected >=4 requests, got ${stats.requests}`);
    // Sub-agent transcripts never enter the parent context.
    const sub = stats.lastInput;
    assert.ok(sub < 2_000, `final context ${sub} should not include sub-agent transcripts`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
