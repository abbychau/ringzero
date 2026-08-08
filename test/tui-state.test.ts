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
  selectionRange,
  selectionText,
  shiftSelect,
  type Block,
  type Selection,
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

test('reducer plan mode + todos', () => {
  let s = initial('m', true);
  assert.equal(s.planMode, true);
  s = reducer(s, { type: 'setPlanMode', planMode: false });
  assert.equal(s.planMode, false);
  s = reducer(s, { type: 'setYolo', yolo: true });
  assert.equal(s.yolo, true);
  s = reducer(s, { type: 'setYolo', yolo: false });
  assert.equal(s.yolo, false);
  s = reducer(s, {
    type: 'setTodos',
    todos: [
      { text: 'a', done: false },
      { text: 'b', done: true },
    ],
  });
  assert.equal(s.todos.length, 2);
  assert.equal(s.todosExpanded, false);
  s = reducer(s, { type: 'toggleTodos' });
  assert.equal(s.todosExpanded, true);
  s = reducer(s, { type: 'toggleTodos' });
  assert.equal(s.todosExpanded, false);
});

test('initial state carries yolo (default off)', () => {
  assert.equal(initial('m').yolo, false);
  assert.equal(initial('m', false, true).yolo, true);
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
  assert.equal(inputLines('', 100), 1);
  assert.equal(inputLines('hello', 100), 1);
  assert.equal(inputLines('a\nb', 100), 2);
  assert.equal(inputLines('a\nb\nc', 100), 3);
});

test('inputLines counts wrapped rows (CJK-aware, prefix on line 0)', () => {
  // Line 0 also renders the ❯ prefix (2 cols), so 98 chars fill 100 cols.
  assert.equal(inputLines('x'.repeat(98), 100), 1);
  assert.equal(inputLines('x'.repeat(99), 100), 2);
  assert.equal(inputLines('x'.repeat(150), 100), 2);
  assert.equal(inputLines('a\n' + 'y'.repeat(150), 100), 3);
  assert.equal(inputLines('你'.repeat(60), 100), 2); // CJK double-width: 120+2 cols
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
  assert.deepEqual(slashMatches('/c'), ['context', 'compact', 'commit', 'checkpoint']);
  assert.deepEqual(slashMatches('/com'), ['compact', 'commit']);
  // plan/todos/tools are registered for autocomplete
  assert.deepEqual(slashMatches('/p'), ['permission', 'plan']);
  assert.deepEqual(slashMatches('/t'), ['todos', 'tools']);
  assert.ok(slashMatches('/').includes('yolo'));
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

test('reducer transcriptFocus: set, clear, and reset on new content', () => {
  let s = initial('m');
  assert.equal(s.transcriptFocus, false);
  s = reducer(s, { type: 'setTranscriptFocus', focus: true });
  assert.equal(s.transcriptFocus, true);
  // new content snaps focus back to the input
  s = reducer(s, { type: 'push', block: { tag: 'sys', text: 'hi' } });
  assert.equal(s.transcriptFocus, false);
  assert.equal(s.scroll, 0);
  // same for submit and run start
  s = reducer(s, { type: 'setTranscriptFocus', focus: true });
  s = reducer(s, { type: 'submit', text: 'hi' });
  assert.equal(s.transcriptFocus, false);
  s = reducer(s, { type: 'setTranscriptFocus', focus: true });
  s = reducer(s, { type: 'runStart' });
  assert.equal(s.transcriptFocus, false);
});

test('reducer scroll clamps at 0', () => {
  let s = initial('m');
  s = reducer(s, { type: 'scroll', delta: 3 });
  assert.equal(s.scroll, 3);
  s = reducer(s, { type: 'scroll', delta: -1 });
  assert.equal(s.scroll, 2);
  s = reducer(s, { type: 'scroll', delta: -99 });
  assert.equal(s.scroll, 0);
});

test('reducer setSelection stores and structural changes clear it', () => {
  let s = initial('m');
  const sel: Selection = { anchorRow: 0, anchorCol: 0, headRow: 1, headCol: 3 };
  s = reducer(s, { type: 'setSelection', selection: sel });
  assert.deepEqual(s.selection, sel);
  s = reducer(s, { type: 'setSelection', selection: undefined });
  assert.equal(s.selection, undefined);

  const cases: { name: string; apply: (st: typeof s) => typeof s }[] = [
    {
      name: 'push',
      apply: (st) => reducer(st, { type: 'push', block: { tag: 'sys', text: 'x' } }),
    },
    {
      name: 'appendAssistant',
      apply: (st) => reducer(st, { type: 'appendAssistant', delta: 'x' }),
    },
    { name: 'appendThinking', apply: (st) => reducer(st, { type: 'appendThinking', delta: 'x' }) },
    {
      name: 'setToolOutput',
      apply: (st) => reducer(st, { type: 'setToolOutput', output: 'o', done: true }),
    },
    { name: 'toggleTool', apply: (st) => reducer(st, { type: 'toggleTool' }) },
    { name: 'submit', apply: (st) => reducer(st, { type: 'submit', text: 'hi' }) },
    { name: 'runStart', apply: (st) => reducer(st, { type: 'runStart' }) },
    { name: 'clear', apply: (st) => reducer(st, { type: 'clear' }) },
  ];
  for (const c of cases) {
    s = reducer(initial('m'), { type: 'setSelection', selection: sel });
    const out = c.apply(s);
    assert.equal(out.selection, undefined, `selection must clear on ${c.name}`);
  }
});

test('selectionRange covers single row, multi-row, reversed, and clamps', () => {
  // single row, normal order
  assert.deepEqual(selectionRange({ anchorRow: 1, anchorCol: 1, headRow: 1, headCol: 3 }, 1, 10), {
    start: 1,
    end: 3,
  });
  // single row, reversed cols
  assert.deepEqual(selectionRange({ anchorRow: 1, anchorCol: 3, headRow: 1, headCol: 1 }, 1, 10), {
    start: 1,
    end: 3,
  });
  // rows outside the selection are null
  assert.equal(selectionRange({ anchorRow: 1, anchorCol: 1, headRow: 3, headCol: 3 }, 0, 10), null);
  assert.equal(selectionRange({ anchorRow: 1, anchorCol: 1, headRow: 3, headCol: 3 }, 4, 10), null);
  // top row: from anchor col to end
  assert.deepEqual(selectionRange({ anchorRow: 1, anchorCol: 2, headRow: 3, headCol: 3 }, 1, 10), {
    start: 2,
    end: 10,
  });
  // middle row: whole line
  assert.deepEqual(selectionRange({ anchorRow: 1, anchorCol: 2, headRow: 3, headCol: 3 }, 2, 10), {
    start: 0,
    end: 10,
  });
  // bottom row: from 0 to head col
  assert.deepEqual(selectionRange({ anchorRow: 1, anchorCol: 2, headRow: 3, headCol: 3 }, 3, 10), {
    start: 0,
    end: 3,
  });
  // selection upwards (head above anchor) still resolves top/bottom
  assert.deepEqual(selectionRange({ anchorRow: 3, anchorCol: 4, headRow: 1, headCol: 2 }, 1, 10), {
    start: 2,
    end: 10,
  });
  assert.deepEqual(selectionRange({ anchorRow: 3, anchorCol: 4, headRow: 1, headCol: 2 }, 3, 10), {
    start: 0,
    end: 4,
  });
  // cols clamp to row length
  assert.deepEqual(selectionRange({ anchorRow: 1, anchorCol: 0, headRow: 1, headCol: 99 }, 1, 5), {
    start: 0,
    end: 5,
  });
});

test('selectionText joins rows with newlines and honors col ranges', () => {
  const rows = [
    { blockIdx: 0, text: 'aa' },
    { blockIdx: 0, text: 'bbb' },
    { blockIdx: 0, text: 'cc' },
  ];
  assert.equal(
    selectionText(rows, { anchorRow: 0, anchorCol: 1, headRow: 2, headCol: 1 }),
    'a\nbbb\nc',
  );
  // single row slice
  assert.equal(selectionText(rows, { anchorRow: 1, anchorCol: 0, headRow: 1, headCol: 2 }), 'bb');
  // reversed order still reads top→bottom
  assert.equal(
    selectionText(rows, { anchorRow: 2, anchorCol: 1, headRow: 0, headCol: 1 }),
    'a\nbbb\nc',
  );
  // out-of-range rows are skipped
  assert.equal(selectionText(rows, { anchorRow: 5, anchorCol: 0, headRow: 7, headCol: 1 }), '');
});

test('shiftSelect starts a selection at fromRow and extends it, clamped', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ blockIdx: 0, text: `r${i}` }));
  // no selection yet → anchor at fromRow, head one row further
  assert.deepEqual(shiftSelect(undefined, rows.length, 4, -1), {
    pane: 'transcript',
    anchorRow: 4,
    anchorCol: 0,
    headRow: 3,
    headCol: 0,
  });
  // extend an existing selection
  assert.deepEqual(
    shiftSelect({ anchorRow: 4, anchorCol: 0, headRow: 3, headCol: 0 }, rows.length, 4, 1),
    { pane: 'transcript', anchorRow: 4, anchorCol: 0, headRow: 4, headCol: 0 },
  );
  // clamps at the top
  assert.deepEqual(
    shiftSelect({ anchorRow: 4, anchorCol: 0, headRow: 3, headCol: 0 }, rows.length, 4, -9),
    {
      pane: 'transcript',
      anchorRow: 4,
      anchorCol: 0,
      headRow: 0,
      headCol: 0,
    },
  );
  // clamps at the bottom
  assert.deepEqual(
    shiftSelect({ anchorRow: 4, anchorCol: 0, headRow: 3, headCol: 0 }, rows.length, 4, 99),
    {
      pane: 'transcript',
      anchorRow: 4,
      anchorCol: 0,
      headRow: 9,
      headCol: 0,
    },
  );
  // keyboard selection always lands on the transcript pane, even when a
  // sidebar selection exists (mouse-made selections carry their own pane)
  assert.deepEqual(
    shiftSelect(
      { pane: 'sidebar', anchorRow: 1, anchorCol: 0, headRow: 2, headCol: 3 },
      rows.length,
      4,
      1,
    ),
    { pane: 'transcript', anchorRow: 1, anchorCol: 0, headRow: 3, headCol: 3 },
  );
});
