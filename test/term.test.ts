/** Terminal text primitives: URL splitting (OSC 8 links) and URL-safe wrap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitUrls,
  wrapText,
  wrapWords,
  wrappedRows,
  wrappedCursor,
  charWidth,
  strWidth,
} from '../src/tui/term.js';

test('splitUrls splits plain text and URLs', () => {
  assert.deepEqual(splitUrls('see https://x.dev now'), [
    { text: 'see ' },
    { url: 'https://x.dev', text: 'https://x.dev' },
    { text: ' now' },
  ]);
});

test('splitUrls trims trailing sentence punctuation from the link', () => {
  assert.deepEqual(splitUrls('a https://x.dev. b'), [
    { text: 'a ' },
    { url: 'https://x.dev', text: 'https://x.dev' },
    { text: '. b' },
  ]);
  assert.deepEqual(splitUrls('see https://x.dev).'), [
    { text: 'see ' },
    { url: 'https://x.dev', text: 'https://x.dev' },
    { text: ').' },
  ]);
});

test('splitUrls supports http and https, and no-URL text passes through', () => {
  assert.ok(splitUrls('http://a.io x').some((p) => p.url === 'http://a.io'));
  assert.deepEqual(splitUrls('no urls here'), [{ text: 'no urls here' }]);
  assert.deepEqual(splitUrls(''), []);
});

test('wrapText does not split a URL across lines', () => {
  // URL (https://x.dev = 13 cols) can't fit after 'aaa ' (4 cols) in a
  // 16-col line: the whole URL moves to its own line instead of breaking
  // mid-URL, and no text is lost.
  const lines = wrapText('aaa https://x.dev end', 16);
  assert.equal(lines[0], 'aaa ');
  assert.ok(lines[1]!.startsWith('https://x.dev'), `line1: ${lines[1]}`);
  assert.ok(lines[1]!.length <= 16, `line1 wider than 16: ${lines[1]}`);
  assert.deepEqual(lines.join(''), 'aaa https://x.dev end');
});

test('wrapText still breaks a URL wider than a full line (degraded)', () => {
  // URL (23 cols) wider than the 10-col line: char wrapping kicks in, but no
  // text is lost.
  const lines = wrapText('aa https://example.com/xyz', 10);
  assert.deepEqual(lines.join(''), 'aa https://example.com/xyz');
});

test('wrapText keeps surrogate pairs (emoji) intact', () => {
  // Regression: iterating by UTF-16 code unit split 🀄 (a surrogate pair),
  // making stringWidth return 0 for the halves and never wrapping.
  const lines = wrapText('🀄🀄🀄🀄🀄', 6);
  assert.deepEqual(lines, ['🀄🀄🀄', '🀄🀄']);
});

test('ambiguous-width chars (← … ·) count as 2 columns', () => {
  // CJK terminals render East Asian Ambiguous chars (U+2190 ←, U+2026 …,
  // U+00B7 ·, …) 2 columns wide; string-width alone counts them as 1, which
  // made rows wider than computed and pushed the sidebar out of alignment.
  assert.equal(charWidth('←'), 2);
  assert.equal(charWidth('…'), 2);
  assert.equal(charWidth('·'), 2);
  assert.equal(strWidth('← Store stub 退到後面'), 2 + 12 + 8); // ←=2 + ascii + CJK
  assert.equal(charWidth('中'), 2);
  assert.equal(charWidth('a'), 1);
  // Combining marks stay zero-width even though U+0301 is classified ambiguous.
  assert.equal(strWidth('e\u0301'), 1);
});

test('wrapText wraps ambiguous chars as 2 columns (no overflow)', () => {
  // '←←←←←' is 10 columns: two rows of 3+2 at width 6.
  assert.deepEqual(wrapText('←←←←←', 6), ['←←←', '←←']);
});

test('wrapWords rows never exceed width with ambiguous chars', () => {
  for (const row of wrapWords('←←←←← a b', 6)) {
    assert.ok(strWidth(row) <= 6, `row too wide: ${JSON.stringify(row)}`);
  }
});

test('wrappedRows counts Ink-style word-wrap rows', () => {
  assert.equal(wrappedRows('', 10), 1);
  assert.equal(wrappedRows('hello', 100), 1);
  // Word boundary break: '❯ aaaa ' (7) + 'bbbb cccc' (9) — not uniform rows.
  assert.equal(wrappedRows('❯ aaaa bbbb cccc', 10), 2);
  // Rows fill to the width when words allow.
  assert.equal(wrappedRows('❯ a b c d e f g h i j k l m', 10), 3);
  // CJK double-width: hard break on an unbroken word.
  assert.equal(wrappedRows('❯ ' + '你'.repeat(60), 100), 2);
});

test('wrappedCursor follows the actual word-wrapped layout', () => {
  // '❯ aaaa ' / 'bbbb cccc' — line 1 ends at col 7 (trailing space kept), so
  // the cursor after '❯ aaaa bb' (pos 10) is at row 1 col 2. The old
  // colWidth % width math put it at col 1 (and mid-line positions were worse),
  // which is the "cursor retreats a few columns" bug.
  assert.deepEqual(wrappedCursor('❯ aaaa bbbb cccc', 10, 10), { row: 1, col: 2 });
  // End of text.
  assert.deepEqual(wrappedCursor('❯ aaaa bbbb cccc', 16, 10), { row: 1, col: 8 });
  // Inside the first wrapped row.
  assert.deepEqual(wrappedCursor('❯ aaaa bbbb cccc', 5, 10), { row: 0, col: 5 });
  // CJK columns count double.
  assert.deepEqual(wrappedCursor('❯ 中文測試', 4, 10), { row: 0, col: 6 });
  // Empty text.
  assert.deepEqual(wrappedCursor('', 0, 10), { row: 0, col: 0 });
  // pos past the end clamps to the end of the last row.
  assert.deepEqual(wrappedCursor('ab', 99, 10), { row: 0, col: 2 });
});
