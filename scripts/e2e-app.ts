/**
 * E2E: have the real agent BUILD a small, realistic app (a Node.js todo CLI) in a
 * temp dir — writing files and running commands — then VERIFY the app actually
 * works by exercising it end to end (add / list / done / remove).
 *
 * Requires API_KEY / API_URL / MODEL in .env.
 * Run: npm run e2e   (or: node dist/scripts/e2e-app.js)
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv } from '../src/config/env.js';
import { createDefaultProvider } from '../src/providers/registry.js';
import { Agent } from '../src/kernel/agent.js';
import { defaultTools } from '../src/tools/index.js';
import { PermissionGate } from '../src/permission/gate.js';
import type { TokenUsage } from '../src/kernel/types.js';

const env = loadEnv();
if (!env.apiKey) {
  console.error('no API_KEY in .env — cannot run the e2e build test');
  process.exit(2);
}
const provider = createDefaultProvider(env);
console.log(`provider=${provider.id} model=${env.model} base=${env.apiUrl}`);

const dir = mkdtempSync(join(tmpdir(), 'rz-e2e-'));
console.log(`workdir: ${dir}\n`);

// The agent may read/write/search and run commands to build + verify the app.
const gate = new PermissionGate({
  rules: {
    read_file: 'allow',
    write_file: 'allow',
    edit_file: 'allow',
    glob: 'allow',
    grep: 'allow',
    bash: 'allow',
    task: 'allow',
  },
  ask: async () => 'no' as const,
});

const SPEC = `在目前目錄建立一個 Node.js 的 todo 命令列應用（不用 npm install、不要任何外部依賴、不要 package.json）：

- 唯一檔案：todo.js，用 \`node todo.js <command>\` 執行。
- 指令介面（必須完全符合）：
  - \`node todo.js add <text>\`：加入一筆 todo，輸出 \`added <id>\`（id 從 1 開始遞增）。
  - \`node todo.js list\`：每行輸出 \`<id> <text>\`；已完成的在該行開頭加 \`x\`（例如 \`x 1 buy milk\`）。
  - \`node todo.js done <id>\`：把該筆標記為完成，輸出 \`done <id>\`。
  - \`node todo.js remove <id>\`：刪除該筆，輸出 \`removed <id>\`。
- 資料持久化到 todos.json（用 node:fs 的 readFileSync/writeFileSync，簡單的 JSON array）。

完成後，執行一次 \`node todo.js add test-task\` 和 \`node todo.js list\` 確認能跑，然後回報完成的摘要。`;

function fail(msg: string): never {
  console.error(`\nE2E FAIL: ${msg}`);
  process.exit(1);
}

function runNode(args: string[], cwd: string): string {
  try {
    return execFileSync(process.execPath, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    fail(`node ${args.join(' ')} exited ${err.status}: ${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

let passed = false;
try {
  // --- Let the agent build the app ---
  const agent = new Agent({
    provider,
    tools: defaultTools(),
    permission: gate,
    cwd: dir,
    home: tmpdir(),
    maxSteps: 20,
  });
  let usage: TokenUsage | undefined;
  console.log('=== building app (real agent loop) ===');
  for await (const ev of agent.run(SPEC)) {
    if (ev.type === 'text') process.stdout.write(ev.text);
    else if (ev.type === 'tool_start') console.log(`\n[tool] ${ev.name} ${ev.args.slice(0, 100)}`);
    else if (ev.type === 'tool_result')
      console.log(`       → ${ev.output.replace(/\n/g, ' ').slice(0, 120)}`);
    else if (ev.type === 'finish') {
      usage = ev.usage;
      console.log(`\n[finish] steps=${ev.steps}`);
    }
  }
  if (usage) {
    const cached = usage.cacheRead ?? 0;
    console.log(
      `[session usage] in=${usage.input} out=${usage.output} cached=${cached} (paid input ≈ ${Math.max(0, usage.input - cached)})`,
    );
  }

  // --- Verify the app actually works end to end ---
  console.log('\n=== verifying the built app ===');
  if (!existsSync(join(dir, 'todo.js'))) fail('todo.js was not created');
  // Reset to a clean state: the agent may have left its own test data behind, and
  // the spec requires the app to start from an empty list when todos.json is gone.
  rmSync(join(dir, 'todos.json'), { force: true });

  const out1 = runNode(['todo.js', 'add', 'buy milk'], dir);
  if (!/added\s+1/i.test(out1)) fail(`add #1 output unexpected: ${out1}`);
  const out2 = runNode(['todo.js', 'add', 'walk dog'], dir);
  if (!/added\s+2/i.test(out2)) fail(`add #2 output unexpected: ${out2}`);

  const list1 = runNode(['todo.js', 'list'], dir);
  if (!list1.includes('buy milk') || !list1.includes('walk dog'))
    fail(`list missing items:\n${list1}`);

  const doneOut = runNode(['todo.js', 'done', '1'], dir);
  if (!/done\s*1/i.test(doneOut)) fail(`done output unexpected: ${doneOut}`);

  const list2 = runNode(['todo.js', 'list'], dir);
  if (!/x\s*1/.test(list2)) fail(`item 1 not marked done after \`done 1\`:\n${list2}`);

  const remOut = runNode(['todo.js', 'remove', '2'], dir);
  if (!/removed\s*2/i.test(remOut)) fail(`remove output unexpected: ${remOut}`);

  const list3 = runNode(['todo.js', 'list'], dir);
  if (list3.includes('walk dog')) fail(`item 2 should be removed:\n${list3}`);

  console.log(`\nlist after add+done+remove:\n${list1}\n---\n${list2}\n---\n${list3}`);
  passed = true;
  console.log('\nE2E PASS — the agent built a working todo app, verified end to end.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(passed ? 0 : 1);
