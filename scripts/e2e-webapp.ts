/**
 * Complex E2E: a real agent (with sub-agents) BUILDS a full-stack Next.js +
 * Tailwind (shadcn-style) web app in a temp dir — implementing UI components,
 * a client page, a full-stack API route — then iterates with Playwright until
 * the e2e suite is green. We then independently verify: the app builds and the
 * Playwright suite passes.
 *
 * The orchestrator scaffolds the project + runs `npm install` so the agent
 * spends its budget on the actual app work and Playwright iteration. Playwright
 * drives an installed browser via `channel` (msedge on Windows) — no download.
 *
 * Requires API_KEY / API_URL / MODEL in .env. Run: npm run e2e:webapp
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv } from '../src/config/env.js';
import { createDefaultProvider } from '../src/providers/registry.js';
import { Agent } from '../src/kernel/agent.js';
import { defaultTools } from '../src/tools/index.js';
import { createTaskTool } from '../src/tools/task.js';
import { PermissionGate } from '../src/permission/gate.js';
import type { TokenUsage } from '../src/kernel/types.js';

const env = loadEnv();
if (!env.apiKey) {
  console.error('no API_KEY in .env — cannot run the webapp e2e');
  process.exit(2);
}
const provider = createDefaultProvider(env);
console.log(`provider=${provider.id} model=${env.model} base=${env.apiUrl}`);

const dir = mkdtempSync(join(tmpdir(), 'rz-e2e-web-'));
console.log(`workdir: ${dir}\n`);

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

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function sh(cmd: string, cwd: string, timeoutMs: number): string {
  try {
    return execFileSync(cmd, {
      cwd,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number; killed?: boolean };
    const detail = err.killed ? 'timed out' : `exit ${err.status}`;
    return `\n[shell ${detail}] ${cmd}\n${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
  }
}

function fail(msg: string): never {
  console.error(`\nE2E-WEB FAIL: ${msg}`);
  process.exit(1);
}

// ---- Scaffold a minimal, buildable Next.js + Tailwind project ------------------
const files: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'rz-webapp',
      private: true,
      version: '0.1.0',
      scripts: {
        dev: 'next dev -p 3000',
        build: 'next build',
        start: 'next start -p 3000',
        'test:e2e': 'playwright test',
      },
      dependencies: { clsx: '2.1.1', next: '14.2.15', react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: {
        '@playwright/test': '^1.48.0',
        '@types/node': '^20.14.0',
        '@types/react': '^18.3.0',
        '@types/react-dom': '^18.3.0',
        autoprefixer: '^10.4.20',
        postcss: '^8.4.47',
        tailwindcss: '^3.4.13',
        typescript: '^5.6.3',
      },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: { '@/*': ['./*'] },
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules'],
    },
    null,
    2,
  ),
  'next-env.d.ts': `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`,
  'tailwind.config.ts': `import type { Config } from "tailwindcss";\nconst config: Config = {\n  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],\n  theme: { extend: {} },\n  plugins: [],\n};\nexport default config;\n`,
  'postcss.config.js': `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`,
  'playwright.config.ts': `import { defineConfig } from "@playwright/test";\nexport default defineConfig({\n  testDir: "e2e",\n  timeout: 60_000,\n  use: { baseURL: "http://localhost:3000", channel: process.env.PW_CHANNEL || "msedge" },\n  webServer: {\n    command: "npm run start",\n    url: "http://localhost:3000",\n    reuseExistingServer: false,\n    timeout: 120_000,\n  },\n});\n`,
  'app/globals.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
  'app/layout.tsx': `import type { ReactNode } from "react";\nimport "./globals.css";\nexport const metadata = { title: "RZ Webapp" };\nexport default function RootLayout({ children }: { children: ReactNode }) {\n  return (\n    <html lang="en">\n      <body className="min-h-screen bg-slate-950 text-slate-100">{children}</body>\n    </html>\n  );\n}\n`,
  'app/page.tsx': `export default function Home() {\n  return (\n    <main className="p-8">\n      <h1 className="text-2xl font-bold">RZ Webapp</h1>\n    </main>\n  );\n}\n`,
};

for (const [rel, content] of Object.entries(files)) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

console.log('scaffolded next.js project; running npm install…');
const installOut = sh(`${npm} install --no-audit --no-fund`, dir, 600_000);
console.log(installOut.split('\n').slice(-4).join('\n'));
if (!existsSync(join(dir, 'node_modules', 'next')))
  fail('npm install did not produce node_modules/next');

// ---- Let the agent build the app with sub-agents + Playwright iteration -------
const SPEC = `請在目前目錄開發一個完整的 Next.js（App Router + TypeScript + Tailwind）fullstack web app。底層 scaffold（package.json、tsconfig、tailwind、playwright.config、app/layout.tsx、app/globals.css、空的 app/page.tsx）都已就緒且 dependencies 已安裝。不要修改 package.json 的 scripts、不要改任何 config 檔。

使用 shadcn 風格（手寫元件，不要執行 shadcn CLI）。請用 task 工具派子 agent 平行開發獨立的部分（彼此檔案不重疊）：
- 子 agent A：components/ 底下的 cn()（lib/utils.ts 或 components/cn.ts，用 clsx）+ shadcn 風格的 Button、Card、Input 元件（Tailwind class），以及 app/counter/page.tsx（client component 計數器：+/− 按鈕、顯示數字，用 Button/Card）。
- 子 agent B：app/api/todos/route.ts（GET 回傳 in-memory todo list、POST 新增並回 201 + 新 todo，用 NextResponse）+ app/todos/page.tsx（client：載入 fetch /api/todos，表單 Input + Add 按鈕 POST 上去並更新清單，用 Card 包起來）。
- 子 agent C：e2e/app.spec.ts（Playwright）覆蓋：首頁標題、/counter 按 + 數字從 0 變 1、/todos 輸入 "buy milk" 按 Add 後出現該項。

你自己負責：app/page.tsx 首頁（標題 + 連結到 /counter 和 /todos），然後：
1) 執行 \`npm run build\`，修到 build 通過（Next.js 需要 strict TypeScript 通過）。
2) 執行 \`npx playwright test\`（config 已用 msedge channel；若 msedge 起不來，設 PW_CHANNEL=chrome 重跑），修到 e2e 全綠。
3) 回報總結：建了哪些檔案、build 結果、playwright 結果。`;

let passed = false;
const subUsage: TokenUsage[] = [];
try {
  const taskTool = createTaskTool({
    provider,
    permission: gate,
    cwd: dir,
    home: tmpdir(),
    onUsage: (u) => subUsage.push(u),
  });
  const agent = new Agent({
    provider,
    tools: [...defaultTools(), taskTool],
    permission: gate,
    cwd: dir,
    home: tmpdir(),
    maxSteps: 40,
  });
  let parentUsage: TokenUsage | undefined;
  console.log('\n=== building full-stack web app (agent + sub-agents) ===');
  for await (const ev of agent.run(SPEC)) {
    if (ev.type === 'text') process.stdout.write(ev.text);
    else if (ev.type === 'tool_start') console.log(`\n[tool] ${ev.name} ${ev.args.slice(0, 110)}`);
    else if (ev.type === 'tool_result')
      console.log(`       → ${ev.output.replace(/\n/g, ' ').slice(0, 150)}`);
    else if (ev.type === 'finish') {
      parentUsage = ev.usage;
      console.log(`\n[finish] steps=${ev.steps} usage=${JSON.stringify(ev.usage)}`);
    }
  }
  {
    const sub = subUsage.reduce<TokenUsage>(
      (a, u) => ({
        input: a.input + u.input,
        output: a.output + u.output,
        cacheRead: (a.cacheRead ?? 0) + (u.cacheRead ?? 0),
      }),
      { input: 0, output: 0 },
    );
    const p = parentUsage ?? { input: 0, output: 0 };
    const total = {
      input: p.input + sub.input,
      output: p.output + sub.output,
      cacheRead: (p.cacheRead ?? 0) + (sub.cacheRead ?? 0),
    };
    const f = (u: TokenUsage): string =>
      `in=${u.input} out=${u.output}${u.cacheRead ? ` cached=${u.cacheRead}` : ''}`;
    console.log(
      `\n[usage] parent ${f(p)} · sub-agents ×${subUsage.length} ${f(sub)} · TOTAL ${f(total)}`,
    );
  }

  // ---- Independent verification: the app builds + playwright is green ----------
  console.log('\n=== verifying: next build ===');
  const buildOut = sh(`${npm} run build`, dir, 300_000);
  if (
    !/Compiled successfully|✓ Compiled/.test(buildOut) &&
    !buildOut.includes('Route (app)') &&
    buildOut.includes('error')
  ) {
    fail(`next build failed:\n${buildOut.slice(-2000)}`);
  }
  if (!existsSync(join(dir, '.next', 'BUILD_ID')))
    fail('next build did not produce .next/BUILD_ID');
  console.log('build OK (.next/BUILD_ID present)');

  for (const f of [
    'components/button.tsx',
    'components/card.tsx',
    'components/input.tsx',
    'app/counter/page.tsx',
    'app/api/todos/route.ts',
    'app/todos/page.tsx',
    'e2e/app.spec.ts',
  ]) {
    if (!existsSync(join(dir, f))) fail(`expected file not created: ${f}`);
  }
  console.log('all expected feature files present');

  console.log('\n=== verifying: playwright e2e ===');
  const pwOut = sh(`npx playwright test`, dir, 420_000);
  console.log(pwOut.slice(-1200));
  if (!/\d+ passed/.test(pwOut) && !/\d+ (passed|flaky)/.test(pwOut))
    fail(`playwright did not pass:\n${pwOut.slice(-1500)}`);

  passed = true;
  console.log(
    '\nE2E-WEB PASS — agent (with sub-agents) built a full-stack Next.js+shadcn app and Playwright is green.',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(passed ? 0 : 1);
