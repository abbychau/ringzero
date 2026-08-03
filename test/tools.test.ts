import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from '../src/tools/fs.js';
import { extractOutline, formatOutline } from '../src/tools/outline.js';
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

test('extractOutline finds functions/classes/interfaces in TS', () => {
  const src = `import { x } from 'y';

export function add(a: number, b: number) {
  return a + b;
}

const double = (n: number) => n * 2;

export class Foo {
  bar() {}
}

interface Baz {
  qux: string;
}

type Quux = string;`;
  const syms = extractOutline(src, 'ts');
  assert.deepEqual(
    syms.map((s) => s.kind),
    ['import', 'function', 'const', 'class', 'interface', 'type'],
  );
  assert.equal(syms[1]!.name, 'add');
  assert.equal(syms[1]!.line, 3);
});

test('extractOutline handles Python defs and async defs', () => {
  const py = `# comment
def foo():
    pass

class Bar:
    pass

async def baz():
    pass`;
  const syms = extractOutline(py, 'py');
  assert.deepEqual(
    syms.map((s) => `${s.kind} ${s.name}`),
    ['def foo', 'class Bar', 'def baz'],
  );
});

test('extractOutline handles Rust fn/struct/impl', () => {
  const rs = `use std::fmt;

pub fn greet(name: &str) -> String {
    format!("hi {name}")
}

pub struct Point {
    x: f64,
}

impl Point {
    fn origin() -> Self { Point { x: 0.0 } }
}`;
  const syms = extractOutline(rs, 'rs');
  assert.deepEqual(
    syms.map((s) => `${s.kind} ${s.name}`),
    ['fn greet', 'struct Point', 'impl Point', 'fn origin'],
  );
});

test('formatOutline caps at OUTLINE_MAX_SYMBOLS', () => {
  const syms = Array.from({ length: 350 }, (_, i) => ({
    kind: 'function',
    name: `f${i}`,
    line: i + 1,
  }));
  const out = formatOutline(syms);
  assert.ok(out.includes('1: function f0'));
  assert.ok(out.includes('… (50 more symbols)'));
});

test('read_file explicit outline mode returns symbols', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-outline-'));
  writeFileSync(join(tmp, 'a.ts'), 'export function f() {}\nclass C {}\n');
  const out = await readFileTool().execute({ path: 'a.ts', mode: 'outline' }, { ...ctx, cwd: tmp });
  assert.ok(out.includes('outline mode'));
  assert.ok(out.includes('1: function f'));
  assert.ok(out.includes('2: class C'));
  rmSync(tmp, { recursive: true, force: true });
});

test('read_file auto-outlines large files, mode=full bypasses', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-outline2-'));
  const big = Array.from({ length: 350 }, (_, i) => `export function fn${i}() {}`).join('\n');
  writeFileSync(join(tmp, 'big.ts'), big);
  const out = await readFileTool().execute({ path: 'big.ts' }, { ...ctx, cwd: tmp });
  assert.ok(out.includes('outline mode'));
  assert.ok(out.includes('350 lines'));
  assert.ok(out.includes('1: function fn0'));
  const full = await readFileTool().execute({ path: 'big.ts', mode: 'full' }, { ...ctx, cwd: tmp });
  assert.ok(full.includes('function fn349'));
  rmSync(tmp, { recursive: true, force: true });
});
