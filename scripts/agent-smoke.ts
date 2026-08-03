/**
 * Real-API smoke: multi-turn agent loop + multi sub-agent, against the configured
 * deepseek endpoint (packyapi from .env). Exercises the actual `Agent` loop with
 * real tools, then a parent agent delegating subtasks to sub-agents via `task`.
 *
 * Requires API_KEY / API_URL / MODEL in .env.
 * Run: npm run smoke:agent   (or: node dist/scripts/agent-smoke.js)
 */
import { homedir } from 'node:os';
import { loadEnv } from '../src/config/env.js';
import { createDefaultProvider } from '../src/providers/registry.js';
import { Agent } from '../src/kernel/agent.js';
import { defaultTools } from '../src/tools/index.js';
import { createTaskTool } from '../src/tools/task.js';
import { PermissionGate } from '../src/permission/gate.js';
import type { TokenUsage } from '../src/kernel/types.js';

function fmtUsage(u: TokenUsage): string {
  return `in=${u.input} out=${u.output}${u.cacheRead ? ` cached=${u.cacheRead}` : ''}`;
}
function sumUsage(list: TokenUsage[]): TokenUsage {
  return list.reduce<TokenUsage>(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      cacheRead: (acc.cacheRead ?? 0) + (u.cacheRead ?? 0),
    }),
    { input: 0, output: 0 },
  );
}

const env = loadEnv();
if (!env.apiKey) {
  console.error('no API_KEY in .env — cannot run the agent smoke');
  process.exit(2);
}
const provider = createDefaultProvider(env);
console.log(`provider=${provider.id} model=${env.model} base=${env.apiUrl}`);

// Read-only gate: the agent may inspect/read/search and delegate to sub-agents
// (task), but cannot mutate or exec. Sub-agents inherit this same gate.
const gate = new PermissionGate({
  rules: { read_file: 'allow', glob: 'allow', grep: 'allow', task: 'allow' },
  ask: async () => 'no' as const,
});

async function runAgent(
  label: string,
  agent: Agent,
  prompt: string,
  subUsage: TokenUsage[] = [],
): Promise<void> {
  console.log(`\n===== ${label} =====`);
  console.log(`task: ${prompt}`);
  let text = '';
  const toolStarts: string[] = [];
  let steps = 0;
  let usage: TokenUsage | undefined;
  for await (const ev of agent.run(prompt)) {
    if (ev.type === 'text') {
      text += ev.text;
      process.stdout.write(ev.text);
    } else if (ev.type === 'tool_start') {
      toolStarts.push(ev.name);
      console.log(`\n[tool] ${ev.name} ${ev.args.slice(0, 120)}`);
    } else if (ev.type === 'tool_result') {
      console.log(`       → ${ev.output.replace(/\n/g, ' ').slice(0, 140)}`);
    } else if (ev.type === 'permission') {
      console.log(`       (permission ${ev.name}: ${ev.allowed ? 'allow' : 'deny'})`);
    } else if (ev.type === 'compacting') {
      console.log('       (compacting…)');
    } else if (ev.type === 'finish') {
      steps = ev.steps;
      usage = ev.usage;
    }
  }
  const ok = text.trim().length > 0;
  const u = usage ?? { input: 0, output: 0 };
  const sub = sumUsage(subUsage);
  const total = {
    input: u.input + sub.input,
    output: u.output + sub.output,
    cacheRead: (u.cacheRead ?? 0) + (sub.cacheRead ?? 0),
  };
  console.log(
    `\n${ok ? 'OK' : 'FAIL'} — final answer ${text.trim().length} chars · ${toolStarts.length} tool call(s) [${toolStarts.join(', ')}] · steps=${steps}`,
  );
  console.log(
    `[usage] parent ${fmtUsage(u)}${subUsage.length ? ` · sub-agents ×${subUsage.length} ${fmtUsage(sub)}` : ''} · TOTAL ${fmtUsage(total)}`,
  );
  if (!ok) process.exitCode = 1;
}

// --- Scenario A: single agent, multi-turn reasoning + real tools -------------
{
  const agent = new Agent({
    provider,
    tools: defaultTools(),
    permission: gate,
    cwd: process.cwd(),
    home: homedir(),
    maxSteps: 12,
  });
  await runAgent(
    'Agent loop (multi-turn tool use)',
    agent,
    '用 glob 列出 src/config 目錄下的所有檔案，再用 read_file 讀取 config.ts，最後回報 contextBudget 的預設值是多少。',
  );
}

// --- Scenario B: parent delegates to sub-agents via the task tool ------------
{
  const subUsage: TokenUsage[] = [];
  const taskTool = createTaskTool({
    provider,
    permission: gate,
    cwd: process.cwd(),
    home: homedir(),
    onUsage: (u) => subUsage.push(u),
  });
  const agent = new Agent({
    provider,
    tools: [taskTool],
    permission: gate,
    cwd: process.cwd(),
    home: homedir(),
    maxSteps: 8,
  });
  await runAgent(
    'Multi sub-agent (parent delegates, sub-agents report back)',
    agent,
    '請分別派兩個子 agent（使用 task 工具）：第一個讀取 src/kernel/agent.ts 的前 30 行並摘要其用途，第二個讀取 src/kernel/tokenizer.ts 的前 30 行並摘要其用途。最後總結這兩個檔案的用途。',
    subUsage,
  );
}

// --- Scenario C: multi-step + concurrent reads ---------------------------------
{
  const agent = new Agent({
    provider,
    tools: defaultTools(),
    permission: gate,
    cwd: process.cwd(),
    home: homedir(),
    maxSteps: 16,
  });
  await runAgent(
    'Agent loop (multi-step + parallel reads)',
    agent,
    '請同時（並行）用 read_file 讀取 src/index.ts、README.md、package.json 三個檔案的開頭，然後總結這三個檔案各自的用途。',
  );
}

console.log('\nAGENT SMOKE DONE');
process.exit(process.exitCode ?? 0);
