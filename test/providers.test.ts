import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatProvider } from '../src/providers/openai-compat.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import type { ChatEvent } from '../src/kernel/types.js';

/** Stub global fetch with a canned SSE body; returns a restore function. */
function stubFetch(sse: string): () => void {
  const orig = globalThis.fetch;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse));
      c.close();
    },
  });
  globalThis.fetch = async () => new Response(body, { status: 200 });
  return () => {
    globalThis.fetch = orig;
  };
}

async function collectEvents(
  sse: string,
  make: () => AsyncGenerator<ChatEvent>,
): Promise<ChatEvent[]> {
  const restore = stubFetch(sse);
  try {
    const out: ChatEvent[] = [];
    for await (const ev of make()) out.push(ev);
    return out;
  } finally {
    restore();
  }
}

test('openai-compat surfaces reasoning_content as thinking events', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"Let me think"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":" step by step"}}]}',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ].join('\n\n');
  const provider = createOpenAICompatProvider({
    id: 'test',
    baseURL: 'http://example.com/v1',
    apiKey: 'k',
    model: 'm',
  });
  const evs = await collectEvents(sse, () => provider.chat({ messages: [] }));
  // thinking streams in chunks — the consumer concatenates
  const thinking = evs
    .filter((e) => e.type === 'thinking')
    .map((e) => (e as Extract<ChatEvent, { type: 'thinking' }>).text)
    .join('');
  assert.equal(thinking, 'Let me think step by step');
  assert.deepEqual(
    evs
      .filter((e) => e.type === 'text')
      .map((e) => (e as Extract<ChatEvent, { type: 'text' }>).text),
    ['Hello'],
  );
});

test('anthropic surfaces thinking blocks as thinking events', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":5}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I will reason"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" carefully."}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi!"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ].join('\n');
  const provider = createAnthropicProvider({ id: 'test', apiKey: 'k', model: 'm' });
  const evs = await collectEvents(sse, () => provider.chat({ messages: [] }));
  const thinking = evs
    .filter((e) => e.type === 'thinking')
    .map((e) => (e as Extract<ChatEvent, { type: 'thinking' }>).text)
    .join('');
  assert.equal(thinking, 'I will reason carefully.');
  assert.deepEqual(
    evs
      .filter((e) => e.type === 'text')
      .map((e) => (e as Extract<ChatEvent, { type: 'text' }>).text),
    ['Hi!'],
  );
  const finish = evs[evs.length - 1] as Extract<ChatEvent, { type: 'finish' }>;
  assert.equal(finish.type, 'finish');
  assert.deepEqual(finish.usage, { input: 10, output: 5, cacheRead: 5 });
  assert.equal(finish.finishReason, 'end_turn');
});
