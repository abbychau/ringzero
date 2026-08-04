import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { listDirTool, treeTool } from '../src/tools/explore.js';
import type { ToolContext } from '../src/kernel/types.js';

function makeTree(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'rz-explore-'));
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'two\n');
  mkdirSync(join(dir, 'sub', 'deep'));
  writeFileSync(join(dir, 'sub', 'deep', 'c.txt'), 'three\n');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'x.js'), 'ignored\n');
  const ctx: ToolContext = {
    cwd: dir,
    home: homedir(),
    workspace: dir,
    signal: new AbortController().signal,
    ask: async () => true,
  };
  return { dir, ctx };
}

test('list_dir lists entries with / for dirs, skipping ignored dirs', async () => {
  const { dir, ctx } = makeTree();
  try {
    const out = await listDirTool().execute({}, ctx);
    assert.ok(out.includes('a.txt'), out);
    assert.ok(out.includes('sub/'), out);
    assert.ok(!out.includes('node_modules'), out);
    assert.ok(out.startsWith('list of .'), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list_dir rejects paths outside the workspace', async () => {
  const { dir, ctx } = makeTree();
  try {
    const outside = mkdtempSync(join(tmpdir(), 'rz-outside-'));
    const out = await listDirTool().execute({ path: outside }, ctx);
    assert.ok(out.startsWith('error: path outside workspace'), out);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tree respects max_depth and skips ignored dirs', async () => {
  const { dir, ctx } = makeTree();
  try {
    const shallow = await treeTool().execute({ max_depth: 1 }, ctx);
    assert.ok(shallow.includes('a.txt'), shallow);
    assert.ok(shallow.includes('sub/'), shallow);
    assert.ok(!shallow.includes('b.txt'), shallow);
    const deep = await treeTool().execute({}, ctx); // default depth 3
    assert.ok(deep.includes('deep/'), deep);
    assert.ok(deep.includes('c.txt'), deep);
    assert.ok(!deep.includes('node_modules'), deep);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tree reports (empty) for an empty directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-empty-'));
  const ctx: ToolContext = {
    cwd: dir,
    home: homedir(),
    workspace: dir,
    signal: new AbortController().signal,
    ask: async () => true,
  };
  try {
    const out = await treeTool().execute({}, ctx);
    assert.ok(out.startsWith('(empty)'), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
