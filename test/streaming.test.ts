import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../src/providers/streaming.js';

test('parses data-only events', () => {
  const ev = parseSSE('data: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.equal(ev.length, 2);
  assert.equal(ev[0]!.data, '{"a":1}');
  assert.equal(ev[1]!.data, '{"b":2}');
});

test('parses event: prefix', () => {
  const ev = parseSSE('event: message_start\ndata: {"ok":true}\n\n');
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.event, 'message_start');
  assert.equal(ev[0]!.data, '{"ok":true}');
});

test('stops at [DONE]', () => {
  const ev = parseSSE('data: {"x":1}\n\ndata: [DONE]\n\n');
  assert.equal(ev.length, 1);
});

test('handles CRLF line endings', () => {
  const ev = parseSSE('data: hello\r\ndata: world\r\n\r\n');
  assert.equal(ev.length, 2);
  assert.equal(ev[0]!.data, 'hello');
  assert.equal(ev[1]!.data, 'world');
});
