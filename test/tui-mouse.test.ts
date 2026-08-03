import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MouseParser, filterMouseSequences, wheelDelta, FilteredStdin } from '../src/tui/mouse.js';
import process from 'node:process';

test('MouseParser normalizes wheel buttons to 0 (up) / 1 (down)', () => {
  const p = new MouseParser();
  const evs = p.push('\x1b[<64;3;4M\x1b[<65;3;4M');
  assert.deepEqual(evs[0], { type: 'wheel', button: 0, x: 3, y: 4 });
  assert.deepEqual(evs[1], { type: 'wheel', button: 1, x: 3, y: 4 });
});

test('wheelDelta maps normalized wheel buttons to scroll deltas', () => {
  assert.equal(wheelDelta(0), 2); // wheel up → scroll back
  assert.equal(wheelDelta(1), -2); // wheel down → scroll forward
  assert.equal(wheelDelta(2), 0); // other buttons do not scroll
  assert.equal(wheelDelta(64), 0); // raw codes must not be compared directly
});

test('MouseParser parses SGR left/right click and wheel', () => {
  const p = new MouseParser();
  const evs = p.push('\x1b[<0;10;5M\x1b[<2;12;6M\x1b[<64;10;5M\x1b[<0;10;5m');
  assert.equal(evs.length, 4);
  assert.deepEqual(evs[0], { type: 'down', button: 0, x: 10, y: 5 }); // left
  assert.deepEqual(evs[1], { type: 'down', button: 2, x: 12, y: 6 }); // right
  assert.deepEqual(evs[2], { type: 'wheel', button: 0, x: 10, y: 5 }); // wheel up
  assert.deepEqual(evs[3], { type: 'up', button: 0, x: 10, y: 5 }); // release
});

test('MouseParser handles fragmented SGR sequences across chunks', () => {
  const p = new MouseParser();
  assert.deepEqual(p.push('\x1b[<'), []);
  assert.deepEqual(p.push('0;10;5'), []);
  const evs = p.push('M');
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], { type: 'down', button: 0, x: 10, y: 5 });
});

test('filterMouseSequences strips mouse bytes, keeps normal input', () => {
  const out = filterMouseSequences('hello\x1b[<0;10;5Mworld\x1b[<2;1;1M');
  assert.equal(out, 'helloworld');
});

test('filterMouseSequences does not strip arrow keys or paste', () => {
  assert.equal(
    filterMouseSequences('a\x1b[A\x1b[200~paste\x1b[201~b'),
    'a\x1b[A\x1b[200~paste\x1b[201~b',
  );
});

test('FilteredStdin is structurally Ink-compatible (setRawMode/ref/unref/isTTY)', () => {
  const fs = new FilteredStdin(process.stdin as unknown as NodeJS.ReadStream);
  assert.equal(typeof fs.setRawMode, 'function');
  assert.equal(typeof fs.ref, 'function');
  assert.equal(typeof fs.unref, 'function');
  assert.equal(typeof fs.isTTY, 'boolean');
});
