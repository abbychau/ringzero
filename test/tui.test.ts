import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyReader, strWidth, wrapText, truncateWidth, colToCharIndex } from '../src/tui/term.js';

test('strWidth counts CJK/fullwidth as 2', () => {
  assert.equal(strWidth('abc'), 3);
  assert.equal(strWidth('中文'), 4);
  assert.equal(strWidth('a中b'), 4);
  assert.equal(strWidth('Ａ'), 2);
});

test('wrapText never exceeds width and splits long CJK', () => {
  const lines = wrapText('中文字測試一二三四五六七八九', 6);
  for (const l of lines) assert.ok(strWidth(l) <= 6);
  assert.ok(lines.length >= 2);
});

test('truncateWidth respects double-width', () => {
  assert.equal(truncateWidth('中文字', 4), '中文');
  assert.equal(truncateWidth('abcde', 4), 'abcd');
});

test('widths match Ink for wide glyphs the old ranges missed', () => {
  // The hand-rolled ranges undercounted some wide glyphs (e.g. 🀄 U+1F004), so
  // rows came out narrower than Ink renders them → Ink re-wrapped → layout
  // overflow. string-width is the library Ink itself renders with, so our
  // measurements now agree with it by construction.
  assert.equal(strWidth('🀄'), 2); // mahjong tile U+1F004 (was 1)
  assert.equal(strWidth('🀄中'), 4);
  // Combining marks and VS16 are zero-width, exactly like Ink counts them
  // (the old ranges counted them as 1).
  assert.equal(strWidth('e\u0301'), 1);
  assert.equal(strWidth('\uFE0F'), 0);
  // wrapText never produces a row wider than requested, even for the above.
  for (const l of wrapText('🀄🀄🀄🀄🀄', 6)) assert.ok(strWidth(l) <= 6);
  assert.equal(truncateWidth('🀄🀄🀄', 3), '🀄');
});

test('KeyReader parses arrows, ctrl, ascii and CJK chars', () => {
  const r = new KeyReader();
  r.push(Buffer.from('\x1b[A'));
  assert.deepEqual(r.next(), { type: 'up' });
  r.push(Buffer.from('a'));
  assert.deepEqual(r.next(), { type: 'char', char: 'a' });
  r.push(Buffer.from('中'));
  assert.deepEqual(r.next(), { type: 'char', char: '中' });
  r.push(Buffer.from('\x03'));
  assert.deepEqual(r.next(), { type: 'ctrl_c' });
  r.push(Buffer.from('\r'));
  assert.deepEqual(r.next(), { type: 'enter' });
});

test('KeyReader handles fragmented escape sequence across chunks', () => {
  const r = new KeyReader();
  r.push(Buffer.from('\x1b'));
  assert.equal(r.next(), null);
  r.push(Buffer.from('['));
  assert.equal(r.next(), null);
  r.push(Buffer.from('B'));
  assert.deepEqual(r.next(), { type: 'down' });
});

test('KeyReader handles fragmented multi-byte CJK across chunks', () => {
  const r = new KeyReader();
  const b = Buffer.from('中');
  r.push(b.subarray(0, 2)); // 2 of 3 bytes
  assert.equal(r.next(), null);
  r.push(b.subarray(2));
  assert.deepEqual(r.next(), { type: 'char', char: '中' });
});

test('KeyReader pageup/pagedown and delete', () => {
  const r = new KeyReader();
  r.push(Buffer.from('\x1b[5~\x1b[6~\x1b[3~'));
  assert.deepEqual(r.next(), { type: 'pageup' });
  assert.deepEqual(r.next(), { type: 'pagedown' });
  assert.deepEqual(r.next(), { type: 'delete' });
});

test('colToCharIndex maps terminal columns to char indices (CJK-safe)', () => {
  // plain ascii: 1:1
  assert.equal(colToCharIndex('abc', 0), 0);
  assert.equal(colToCharIndex('abc', 2), 2);
  assert.equal(colToCharIndex('abc', 99), 3);
  // a click in the left half of a double-width char rounds down to it
  assert.equal(colToCharIndex('中文', 1), 0); // col 1 → char 0 (中 starts at col 0)
  assert.equal(colToCharIndex('中文', 2), 1); // col 2 → char 1
  assert.equal(colToCharIndex('中文', 3), 1); // col 3 → still char 1 (文)
  assert.equal(colToCharIndex('中文', 4), 2); // past the end → length
  // mixed widths
  assert.equal(colToCharIndex('a中b', 1), 1);
  assert.equal(colToCharIndex('a中b', 2), 1); // col 2 is 中's second cell
  assert.equal(colToCharIndex('a中b', 3), 2);
});
