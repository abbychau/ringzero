import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyReader, strWidth, wrapText, truncateWidth } from '../src/tui/term.js';

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
