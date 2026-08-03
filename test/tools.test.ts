import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { readFileTool } from '../src/tools/fs.js';
import type { ToolContext } from '../src/kernel/types.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  home: homedir(),
  signal: new AbortController().signal,
  ask: async () => true,
};

test('read_file full content when no range', async () => {
  const out = await readFileTool().execute({ path: 'package.json' }, ctx);
  assert.ok(out.includes('ringzero'));
});

test('read_file range returns numbered slice', async () => {
  const out = await readFileTool().execute(
    { path: 'package.json', start_line: 1, end_line: 3 },
    ctx,
  );
  assert.ok(out.startsWith('1: {'));
  assert.ok(out.includes('"name": "ringzero"'));
  assert.ok(out.includes('lines total; showing 1-3'));
});

test('read_file range clamps to file length', async () => {
  const out = await readFileTool().execute(
    { path: 'package.json', start_line: 1, end_line: 9999 },
    ctx,
  );
  assert.ok(out.includes('lines total'));
});

test('read_file rejects start > end', async () => {
  const out = await readFileTool().execute(
    { path: 'package.json', start_line: 5, end_line: 2 },
    ctx,
  );
  assert.ok(out.startsWith('error:'));
});
