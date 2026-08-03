import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSymbolIndex } from '../src/tools/indexer.js';
import { relatedFilesTool } from '../src/tools/related.js';
import type { ToolContext } from '../src/kernel/types.js';

function ctxFor(cwd: string, workspace?: string): ToolContext {
  return {
    cwd,
    home: tmpdir(),
    workspace,
    signal: new AbortController().signal,
    ask: async () => true,
  };
}

test('getSymbolIndex caches per-root until the tree changes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-idx-'));
  try {
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src', 'a.ts'), 'export function helper() {}\n');
    const idx1 = getSymbolIndex(tmp);
    assert.equal(getSymbolIndex(tmp), idx1, 'second call reuses the cached index');

    // A new file changes the signature → a fresh index that includes it.
    writeFileSync(join(tmp, 'src', 'b.ts'), 'export function other() {}\n');
    const idx2 = getSymbolIndex(tmp);
    assert.notEqual(idx2, idx1);
    assert.ok(idx2.files.has(join('src', 'b.ts')));
    assert.equal(idx2.files.get(join('src', 'a.ts'))?.symbols[0]?.name, 'helper');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('related_files finds importers and same-symbol files', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-rel-'));
  try {
    mkdirSync(join(tmp, 'src'));
    writeFileSync(
      join(tmp, 'src', 'a.ts'),
      'export function helper() {}\nexport const CONFIG = 1;\n',
    );
    writeFileSync(
      join(tmp, 'src', 'b.ts'),
      "import { helper } from './a';\nconsole.log(helper());\n",
    );
    writeFileSync(join(tmp, 'src', 'c.ts'), 'export function helper() {}\n');
    writeFileSync(join(tmp, 'src', 'd.ts'), 'export function other() {}\n');
    const tool = relatedFilesTool();
    const out = await tool.execute({ path: 'src/a.ts' }, ctxFor(tmp));
    const b = join('src', 'b.ts');
    const c = join('src', 'c.ts');
    const d = join('src', 'd.ts');
    assert.ok(out.includes(`related files for ${join('src', 'a.ts')}`), out);
    assert.ok(out.includes(`- ${b}  (imports a)`), out);
    assert.ok(out.includes(`- ${c}  (same symbols: helper)`), out);
    assert.ok(!out.includes(d), `must not list ${d}:\n${out}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('related_files resolves index barrels via the parent dir', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-barrel-'));
  try {
    mkdirSync(join(tmp, 'lib'));
    writeFileSync(join(tmp, 'lib', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(tmp, 'lib', 'user.ts'), "import { x } from './index';\n");
    const out = await relatedFilesTool().execute({ path: 'lib/index.ts' }, ctxFor(tmp));
    assert.ok(out.includes(`- ${join('lib', 'user.ts')}  (imports lib)`), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('related_files rejects paths outside the workspace', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-out-'));
  try {
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src', 'a.ts'), 'export function helper() {}\n');
    const tool = relatedFilesTool();
    const out = await tool.execute({ path: '../outside.ts' }, ctxFor(tmp));
    assert.ok(out.startsWith('error:'), out);
    const out2 = await tool.execute({ path: join('src', 'a.ts') }, ctxFor(tmp, tmp));
    assert.ok(!out2.startsWith('error:'), out2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('related_files errors on missing or non-indexable files', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-miss-'));
  try {
    writeFileSync(join(tmp, 'a.ts'), 'export function helper() {}\n');
    writeFileSync(join(tmp, 'a.bin'), 'not source');
    const tool = relatedFilesTool();
    const missing = await tool.execute({ path: 'nope.ts' }, ctxFor(tmp));
    assert.ok(missing.startsWith('error:'), missing);
    const bin = await tool.execute({ path: 'a.bin' }, ctxFor(tmp));
    assert.ok(bin.startsWith('error:'), bin);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('related_files reports no matches cleanly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-none-'));
  try {
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src', 'a.ts'), 'export function helper() {}\n');
    writeFileSync(join(tmp, 'src', 'd.ts'), 'export function other() {}\n');
    const out = await relatedFilesTool().execute({ path: 'src/d.ts' }, ctxFor(tmp));
    assert.equal(out, `no related files for ${join('src', 'd.ts')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
