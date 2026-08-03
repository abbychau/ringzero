import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reducer,
  initial,
  layoutBlocks,
  windowRows,
  fmtUsage,
  fmtSession,
  mergeUsage,
  inputLineCol,
  inputLines,
  slashMatches,
  type Block,
} from '../src/tui/state.js';

test('reducer appends and streams assistant text', () => {
  let s = initial('m');
  s = reducer(s, { type: 'submit', text: 'hi' });
  assert.equal(s.input, '');
  s = reducer(s, { type: 'push', block: { tag: 'user', text: 'hi' } });
  s = reducer(s, { type: 'appendAssistant', delta: '你好' });
  s = reducer(s, { type: 'appendAssistant', delta: '世界' });
  const last = s.blocks[s.blocks.length - 1]!;
  assert.equal(last.tag, 'assistant');
  assert.equal((last as Extract<Block, { tag: 'assistant' }>).text, '你好世界');
});

test('reducer tool output + toggle expand', () => {
  let s = initial('m');
  s = reducer(s, {
    type: 'push',
    block: { tag: 'tool', name: 'glob', args: '{}', done: false, expanded: false },
  });
  s = reducer(s, { type: 'setToolOutput', output: 'a\nb\nc\nd', done: true });
  s = reducer(s, { type: 'toggleTool' });
  const tool = s.blocks[s.blocks.length - 1] as Extract<Block, { tag: 'tool' }>;
  assert.equal(tool.expanded, true);
});

test('reducer history + clear', () => {
  let s = initial('m');
  s = reducer(s, { type: 'submit', text: 'first' });
  s = reducer(s, { type: 'submit', text: 'second' });
  assert.equal(s.history.length, 2);
  s = reducer(s, { type: 'history', index: 0 });
  assert.equal(s.input, 'first');
  s = reducer(s, { type: 'clear' });
  assert.equal(s.blocks.length, 0);
});

test('layoutBlocks wraps and collapses tool preview', () => {
  const blocks: Block[] = [
    { tag: 'user', text: 'abc' },
    {
      tag: 'tool',
      name: 'glob',
      args: '{}',
      output: 'line1\nline2\nline3\nline4',
      done: true,
      expanded: false,
    },
  ];
  const rows = layoutBlocks(blocks, 20);
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((r) => r.blockIdx === 0 || r.blockIdx === 1));
  assert.ok(rows.some((r) => r.text.includes('glob')));
  const toolText = rows
    .filter((r) => r.blockIdx === 1)
    .map((r) => r.text)
    .join('\n');
  assert.ok(toolText.includes('line1'));
  assert.ok(toolText.includes('+1 lines'));
});

test('windowRows clamps scroll and shows bottom by default', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ blockIdx: 0, text: `r${i}` }));
  const w = windowRows(rows, 4, 0);
  assert.equal(w.visible[0]!.text, 'r6');
  assert.equal(w.visible[3]!.text, 'r9');
  const scrolled = windowRows(rows, 4, 99);
  assert.equal(scrolled.visible[0]!.text, 'r0');
  assert.equal(scrolled.maxScroll, 6);
});

test('fmtUsage includes cache read', () => {
  assert.equal(fmtUsage({ input: 100, output: 20 }), 'in=100 out=20');
  assert.equal(fmtUsage({ input: 100, output: 20, cacheRead: 30 }), 'in=100 out=20 cached=30');
});

test('inputLineCol maps cursor to line/col across newlines', () => {
  assert.deepEqual(inputLineCol('', 0), { line: 0, col: 0 });
  assert.deepEqual(inputLineCol('abc', 2), { line: 0, col: 2 });
  assert.deepEqual(inputLineCol('a\nbc', 3), { line: 1, col: 1 });
  assert.deepEqual(inputLineCol('a\nbc', 1), { line: 0, col: 1 });
  assert.deepEqual(inputLineCol('a\nb\ncd', 5), { line: 2, col: 1 });
  // cursor exactly on a newline char belongs to the line that ends with it
  assert.deepEqual(inputLineCol('a\nbc', 1), { line: 0, col: 1 });
});

test('inputLines counts rendered lines (min 1)', () => {
  assert.equal(inputLines(''), 1);
  assert.equal(inputLines('hello'), 1);
  assert.equal(inputLines('a\nb'), 2);
  assert.equal(inputLines('a\nb\nc'), 3);
});

test('reducer runEnd stores ctxTokens', () => {
  let s = initial('m');
  s = reducer(s, { type: 'runEnd', usage: { input: 1, output: 2 }, status: 'idle', ctx: 5000 });
  assert.equal(s.ctxTokens, 5000);
  assert.equal(s.running, false);
});

test('reducer accumulates session total usage across runs', () => {
  let s = initial('m');
  s = reducer(s, { type: 'runEnd', usage: { input: 100, output: 20 }, status: 'idle', ctx: 1 });
  s = reducer(s, {
    type: 'runEnd',
    usage: { input: 50, output: 10, cacheRead: 30 },
    status: 'idle',
    ctx: 1,
  });
  assert.deepEqual(s.totalUsage, { input: 150, output: 30, cacheRead: 30 });
});

test('mergeUsage omits zero cache fields; fmtSession includes cached', () => {
  assert.equal(mergeUsage(undefined, undefined), undefined);
  assert.deepEqual(mergeUsage({ input: 10, output: 5 }, undefined), { input: 10, output: 5 });
  assert.deepEqual(
    mergeUsage({ input: 10, output: 5, cacheRead: 3 }, { input: 1, output: 1, cacheRead: 2 }),
    {
      input: 11,
      output: 6,
      cacheRead: 5,
    },
  );
  assert.equal(
    fmtSession({ input: 4313, output: 360, cacheRead: 3072 }),
    'Σ in=4313 out=360 cached=3072',
  );
});

test('slashMatches filters commands by prefix (and a lone slash shows all)', () => {
  assert.deepEqual(slashMatches('plain'), []);
  const all = slashMatches('/');
  assert.ok(all.includes('compact'));
  assert.ok(all.includes('exit'));
  assert.deepEqual(slashMatches('/c'), ['context', 'compact', 'checkpoint']);
  assert.deepEqual(slashMatches('/com'), ['compact']);
  // plugin extras are merged and deduped against built-ins
  assert.ok(slashMatches('/', ['mcp-list']).includes('mcp-list'));
  assert.deepEqual(slashMatches('/m', ['mcp-list']), ['model', 'mcp-list']);
});

test('reducer resets suggestIdx on input/submit and clamps via suggestIdx action', () => {
  let s = initial('m');
  s = reducer(s, { type: 'suggestIdx', index: 3 });
  assert.equal(s.suggestIdx, 3);
  s = reducer(s, { type: 'input', text: '/c', cursor: 2 });
  assert.equal(s.suggestIdx, 0);
  s = reducer(s, { type: 'suggestIdx', index: 1 });
  s = reducer(s, { type: 'submit', text: '/compact' });
  assert.equal(s.suggestIdx, 0);
});
