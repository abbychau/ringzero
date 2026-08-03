import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, consumeSSE } from '../src/providers/streaming.js';

/** Build a single-enqueue ReadableStream body from a raw string. */
function bodyOf(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

async function collect(s: string): Promise<{ event?: string; data: string }[]> {
  const out: { event?: string; data: string }[] = [];
  for await (const ev of consumeSSE(bodyOf(s))) out.push(ev);
  return out;
}

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

test('consumeSSE flushes a final line without trailing newline', async () => {
  const evs = await collect('data: {"a":1}\n\ndata: {"b":2}');
  assert.equal(evs.length, 2);
  assert.equal(evs[1]!.data, '{"b":2}');
});

test('consumeSSE stops at [DONE] even without trailing newline', async () => {
  const evs = await collect('data: {"a":1}\n\ndata: [DONE]');
  assert.equal(evs.length, 1);
});
