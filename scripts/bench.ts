#!/usr/bin/env node
/**
 * Token-efficiency benchmark (P3.1): runs every recorded fixture twice — with
 * compaction on and off — and reports token/context usage per fixture, plus
 * the savings compaction achieves. Offline: no network, no cost.
 *
 * Usage: npm run bench
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/kernel/agent.js';
import { PermissionGate } from '../src/permission/gate.js';
import { defaultTools } from '../src/tools/index.js';
import { createTaskTool } from '../src/tools/task.js';
import {
  createScriptedProvider,
  type ScriptedConversation,
  type ScriptedStats,
} from '../test/util/scripted.js';
import type { Provider, Tool } from '../src/kernel/types.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);

interface FixtureSpec {
  name: string;
  file: string;
  prompt: string;
  makeTools: (provider: Provider) => Tool[];
  contextBudget?: number;
  preserveRecentTokens?: number;
  maxSteps?: number;
  system?: string[];
  setup?: (dir: string) => void;
}

const allowAll = new PermissionGate({ rules: {}, ask: async () => 'yes' as const });

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

const FIXTURE_SPECS: FixtureSpec[] = [
  {
    name: 'explore',
    file: 'explore.json',
    prompt: 'explore the project',
    makeTools: () => defaultTools(),
    setup: (dir) => {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'export function helper() { return 1; }\n');
    },
  },
  {
    name: 'compact',
    file: 'compact.json',
    prompt: 'summarize the full history',
    makeTools: () => [nopTool('x'.repeat(400))],
    contextBudget: 600,
    preserveRecentTokens: 200,
    maxSteps: 24,
    system: ['you are a test'],
  },
  {
    name: 'fanout',
    file: 'fanout.json',
    prompt: 'research the codebase',
    makeTools: (provider) => [
      createTaskTool({ provider, permission: allowAll, cwd: process.cwd(), home: process.cwd() }),
    ],
    maxSteps: 12,
  },
];

function loadFixture(file: string): { convos: ScriptedConversation[] } {
  return JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as {
    convos: ScriptedConversation[];
  };
}

async function runOnce(
  spec: FixtureSpec,
  compact: boolean,
): Promise<{ stats: ScriptedStats; compacted: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'rz-bench-'));
  try {
    spec.setup?.(dir);
    const { provider, stats } = createScriptedProvider(loadFixture(spec.file).convos);
    const agent = new Agent({
      provider,
      tools: spec.makeTools(provider),
      permission: allowAll,
      cwd: dir,
      home: dir,
      system: spec.system,
      contextBudget: spec.contextBudget ?? 32_000,
      preserveRecentTokens: spec.preserveRecentTokens ?? 8_000,
      maxSteps: spec.maxSteps ?? 24,
      compact,
    });
    let compacted = false;
    for await (const ev of agent.run(spec.prompt)) {
      if (ev.type === 'compacting') compacted = true;
    }
    return { stats, compacted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows: {
  name: string;
  on: ScriptedStats;
  off: ScriptedStats;
  onCompacted: boolean;
  offCompacted: boolean;
}[] = [];

for (const spec of FIXTURE_SPECS) {
  const on = await runOnce(spec, true);
  const off = await runOnce(spec, false);
  rows.push({
    name: spec.name,
    on: on.stats,
    off: off.stats,
    onCompacted: on.compacted,
    offCompacted: off.compacted,
  });
}

console.log('\n## RingZero token benchmark (recorded fixtures, offline)\n');
console.log(
  '| fixture | compaction | model calls | input tok | output tok | compacted | final context tok |',
);
console.log('| --- | --- | ---: | ---: | ---: | --- | ---: |');
for (const r of rows) {
  for (const [label, s] of [
    ['on', r.on],
    ['off', r.off],
  ] as const) {
    const compacted = label === 'on' ? r.onCompacted : r.offCompacted;
    console.log(
      `| ${r.name} | ${label} | ${s.requests} | ${s.input.toLocaleString()} | ${s.output.toLocaleString()} | ${compacted ? 'yes' : 'no'} | ${s.lastInput.toLocaleString()} |`,
    );
  }
}

console.log('\n| fixture | input w/ compaction | input w/o compaction | saved |');
console.log('| --- | ---: | ---: | ---: |');
for (const r of rows) {
  const saved = r.off.input > 0 ? Math.round((1 - r.on.input / r.off.input) * 100) : 0;
  console.log(
    `| ${r.name} | ${r.on.input.toLocaleString()} | ${r.off.input.toLocaleString()} | ${saved}% |`,
  );
}
console.log('');
