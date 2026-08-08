import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatProvider, toOpenAIMessages } from '../src/providers/openai-compat.js';
import { createAnthropicProvider, toAnthropicMessages } from '../src/providers/anthropic.js';
import { createGeminiProvider, toGeminiMessages } from '../src/providers/gemini.js';
import { createDefaultProvider } from '../src/providers/registry.js';
import { effortLevel } from '../src/providers/effort.js';
import type { ChatEvent, ProviderMessage } from '../src/kernel/types.js';

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

/** Stub fetch, capturing each request body as parsed JSON (fresh SSE per call). */
function stubFetchCapture(sse = 'data: [DONE]\n\n'): {
  restore: () => void;
  bodies: Record<string, unknown>[];
} {
  const orig = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    void input;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  return {
    restore: () => {
      globalThis.fetch = orig;
    },
    bodies,
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

test('openai-compat reports cached tokens separately from fresh input', async () => {
  // DeepSeek/OpenAI count cached tokens INSIDE prompt_tokens; input must be
  // the fresh remainder so cacheHitRate and cost aren't double-counted.
  const sse = [
    'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":90}}}',
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
  const finish = evs[evs.length - 1] as Extract<ChatEvent, { type: 'finish' }>;
  assert.deepEqual(finish.usage, { input: 10, output: 5, cacheRead: 90 });
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

test('gemini maps messages to contents: roles, functionCall, functionResponse, images', () => {
  const msgs: ProviderMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'look', images: [{ mime: 'image/png', data: 'AAAA' }] },
    {
      role: 'assistant',
      content: 'calling',
      toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"a.ts"}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: 'file body' },
  ];
  const contents = toGeminiMessages(msgs) as {
    role: string;
    parts: Record<string, unknown>[];
  }[];
  assert.deepEqual(
    contents.map((c) => c.role),
    ['user', 'model', 'user'],
  );
  assert.deepEqual(contents[0]!.parts, [
    { text: 'look' },
    { inline_data: { mime_type: 'image/png', data: 'AAAA' } },
  ]);
  assert.deepEqual(contents[1]!.parts, [
    { text: 'calling' },
    { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
  ]);
  assert.deepEqual(contents[2]!.parts, [
    { functionResponse: { name: 'read_file', response: { result: 'file body' } } },
  ]);
});

test('gemini merges adjacent same-role turns (parallel tool results)', () => {
  const msgs: ProviderMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'grep', args: '{}' },
        { id: 'b', name: 'glob', args: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'a', content: 'hit 1' },
    { role: 'tool', toolCallId: 'b', content: 'hit 2' },
  ];
  const contents = toGeminiMessages(msgs) as { role: string; parts: Record<string, unknown>[] }[];
  assert.deepEqual(
    contents.map((c) => c.role),
    ['model', 'user'],
  );
  assert.equal(contents[1]!.parts.length, 2);
});

test('gemini streams text, thinking, and function calls from SSE chunks', async () => {
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"pondering"},{"text":"Hello"}]},"finishReason":null}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5,"cachedContentTokenCount":40}}',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.ts"}}}]}}]}',
    'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":12}}',
  ].join('\n\n');
  const provider = createGeminiProvider({ id: 'test', apiKey: 'k', model: 'gemini-2.5-flash' });
  const evs = await collectEvents(sse, () => provider.chat({ messages: [] }));
  const thinking = evs
    .filter((e) => e.type === 'thinking')
    .map((e) => (e as Extract<ChatEvent, { type: 'thinking' }>).text)
    .join('');
  assert.equal(thinking, 'pondering');
  assert.deepEqual(
    evs
      .filter((e) => e.type === 'text')
      .map((e) => (e as Extract<ChatEvent, { type: 'text' }>).text),
    ['Hello'],
  );
  const calls = evs.find((e) => e.type === 'tool_calls') as Extract<
    ChatEvent,
    { type: 'tool_calls' }
  >;
  assert.ok(calls, 'tool_calls event');
  assert.equal(calls.calls[0]!.name, 'read_file');
  assert.equal(calls.calls[0]!.args, '{"path":"a.ts"}');
  const finish = evs[evs.length - 1] as Extract<ChatEvent, { type: 'finish' }>;
  // Last usage chunk has promptTokenCount 100 with no cached tokens → input 100.
  assert.deepEqual(finish.usage, { input: 100, output: 12 });
  assert.equal(finish.finishReason, 'STOP');
});

test('registry picks gemini only when no API_URL is set', () => {
  const base = { apiKey: '', apiUrl: '' };
  const g = createDefaultProvider({ ...base, model: 'gemini-x', geminiApiKey: 'k' });
  assert.equal(g.id, 'gemini');
  const a = createDefaultProvider({
    ...base,
    model: 'm',
    geminiApiKey: 'k',
    anthropicApiKey: 'k2',
  });
  assert.equal(a.id, 'anthropic'); // anthropic wins over gemini
  const o = createDefaultProvider({ ...base, model: 'm', geminiApiKey: 'k', apiUrl: 'http://x' });
  assert.equal(o.id, 'openai-compat'); // API_URL wins over vendor keys
});

test('openai-compat and anthropic embed images as multimodal content', () => {
  const msgs: ProviderMessage[] = [
    { role: 'user', content: 'see this', images: [{ mime: 'image/png', data: 'QUJD' }] },
  ];
  const openai = toOpenAIMessages(msgs) as { role: string; content: unknown }[];
  assert.deepEqual(openai[0]!.content, [
    { type: 'text', text: 'see this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
  ]);
  const anthropic = toAnthropicMessages(msgs) as { role: string; content: unknown[] }[];
  assert.deepEqual(anthropic[0]!.content, [
    { type: 'text', text: 'see this' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    },
  ]);
});

test('effortLevel accepts known levels and rejects the rest', () => {
  assert.equal(effortLevel('low'), 'low');
  assert.equal(effortLevel('medium'), 'medium');
  assert.equal(effortLevel('high'), 'high');
  assert.equal(effortLevel('max'), 'max');
  assert.equal(effortLevel('ultra'), undefined);
  assert.equal(effortLevel(''), undefined);
  assert.equal(effortLevel(undefined), undefined);
});

test('openai-compat sends reasoning_effort when effort is set, omits it otherwise', async () => {
  const { restore, bodies } = stubFetchCapture();
  try {
    const withEffort = createOpenAICompatProvider({
      id: 'test',
      baseURL: 'http://example.com/v1',
      apiKey: 'k',
      model: 'm',
      effort: 'high',
    });
    for await (const _ev of withEffort.chat({ messages: [] })) {
      /* drain */
    }
    assert.equal(bodies[0]?.reasoning_effort, 'high');
    const without = createOpenAICompatProvider({
      id: 'test',
      baseURL: 'http://example.com/v1',
      apiKey: 'k',
      model: 'm',
    });
    for await (const _ev of without.chat({ messages: [] })) {
      /* drain */
    }
    assert.equal('reasoning_effort' in (bodies[1] ?? {}), false);
  } finally {
    restore();
  }
});

test('anthropic maps effort to a thinking budget', async () => {
  const { restore, bodies } = stubFetchCapture();
  try {
    const provider = createAnthropicProvider({
      id: 'test',
      apiKey: 'k',
      model: 'm',
      effort: 'medium',
    });
    for await (const _ev of provider.chat({ messages: [] })) {
      /* drain */
    }
    assert.deepEqual(bodies[0]?.thinking, { type: 'enabled', budget_tokens: 8192 });
  } finally {
    restore();
  }
});

test('gemini maps effort to thinkingConfig', async () => {
  const { restore, bodies } = stubFetchCapture();
  try {
    const provider = createGeminiProvider({
      id: 'test',
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      effort: 'low',
    });
    for await (const _ev of provider.chat({ messages: [] })) {
      /* drain */
    }
    const gc = (bodies[0]?.generationConfig ?? {}) as Record<string, unknown>;
    assert.deepEqual(gc.thinkingConfig, { thinkingBudget: 2048 });
  } finally {
    restore();
  }
});

test('registry passes effort through to the provider', async () => {
  const { restore, bodies } = stubFetchCapture();
  try {
    const p = createDefaultProvider({
      apiUrl: 'http://example.com/v1',
      apiKey: 'k',
      model: 'm',
      effort: 'low',
    });
    assert.equal(p.id, 'openai-compat');
    for await (const _ev of p.chat({ messages: [] })) {
      /* drain */
    }
    assert.equal(bodies[0]?.reasoning_effort, 'low');
  } finally {
    restore();
  }
});
