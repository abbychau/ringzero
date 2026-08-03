import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateOutput } from '../src/kernel/truncate.js';
import { PermissionGate } from '../src/permission/gate.js';
import { compactHistory, estimateContextTokens } from '../src/kernel/context.js';
import { countTokens } from '../src/kernel/tokenizer.js';
import type { Provider, SessionMessage } from '../src/kernel/types.js';

test('truncateOutput keeps head+tail with marker', () => {
  const text = 'a'.repeat(10_000);
  const r = truncateOutput(text, 1000);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 1100);
  assert.ok(r.text.includes('truncated'));
});

test('truncateOutput passthrough when small', () => {
  const r = truncateOutput('hello', 1000);
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'hello');
});

test('permission gate rules + ask', async () => {
  const asked: string[] = [];
  const gate = new PermissionGate({
    rules: { read_file: 'allow', bash: 'ask' },
    ask: async (p) => {
      asked.push(p);
      return 'yes';
    },
  });
  assert.equal((await gate.check('read_file', '')).allowed, true);
  assert.equal((await gate.check('bash', 'rm -rf /')).allowed, true);
  assert.equal(asked.length, 1);
});

test('permission always override persists', async () => {
  const gate = new PermissionGate({ ask: async () => 'always' });
  assert.equal((await gate.check('bash', '')).allowed, true);
  assert.equal(gate.ruleFor('bash'), 'allow');
  assert.equal((await gate.check('bash', '')).allowed, true); // no ask
});

const fakeProvider: Provider = {
  id: 'fake',
  countTokens: (t) => countTokens(t),
  async *chat(req) {
    void req;
    yield { type: 'text', text: 'FAKE SUMMARY' };
    yield { type: 'finish', usage: { input: 10, output: 10 } };
  },
};

test('compactHistory summarizes prefix, keeps tail verbatim', async () => {
  const mk = (i: number): SessionMessage => ({
    id: `m${i}`,
    role: i === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(500), // ~125 tokens each
    ts: i,
  });
  const history = Array.from({ length: 20 }, (_, i) => mk(i));
  const result = await compactHistory(fakeProvider, history, {
    preserveRecentTokens: 500,
    budgetTokens: 10_000,
  });
  assert.ok(result.replaced > 0);
  assert.ok(result.messages[0]!.content.includes('FAKE SUMMARY'));
  // tail preserved verbatim: last message unchanged
  assert.equal(result.messages[result.messages.length - 1]!.id, 'm19');
});

test('estimateContextTokens counts system + tools + messages', () => {
  const total = estimateContextTokens(
    fakeProvider,
    [{ id: 'a', role: 'user', content: '中文測試', ts: 0 }],
    {
      system: ['hello'],
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
    },
  );
  assert.ok(total > 0);
});

test('compactHistory sends structured prompt, omits tool-call args', async () => {
  const seen: any[] = [];
  const provider: Provider = {
    id: 'capture',
    countTokens: (t) => countTokens(t),
    async *chat(req) {
      seen.push(req);
      yield { type: 'text', text: 'SUMMARY' };
      yield { type: 'finish', usage: { input: 10, output: 10 } };
    },
  };
  const mk = (i: number): SessionMessage => ({
    id: `m${i}`,
    role: i === 0 ? 'user' : 'assistant',
    content: 'y'.repeat(400), // ~100 tokens each
    ts: i,
    toolCalls:
      i % 2 === 0
        ? [
            {
              id: `c${i}`,
              name: 'read_file',
              args: '{"path":"/very/long/path/' + 'a'.repeat(200) + '"}',
            },
          ]
        : undefined,
  });
  const history = Array.from({ length: 16 }, (_, i) => mk(i));
  await compactHistory(provider, history, {
    preserveRecentTokens: 200,
    budgetTokens: 10_000,
  });
  assert.ok(seen.length >= 1);
  const req = seen[0]!;
  const last = req.messages[req.messages.length - 1];
  assert.ok(typeof last?.content === 'string');
  for (const h of ['# Goals', '# Decisions', '# Files', '# Errors', '# Unfinished']) {
    assert.ok(last!.content.includes(h), `prompt lacks ${h}`);
  }
  // Tool-call arguments must not be sent to the summarizer.
  for (const m of req.messages) {
    assert.equal(m.toolCalls, undefined, 'toolCalls leaked into summarize request');
  }
});

test('compactHistory folds incrementally when budget is tight', async () => {
  const mk = (i: number): SessionMessage => ({
    id: `m${i}`,
    role: i === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(500), // ~125 tokens each
    ts: i,
  });
  const history = Array.from({ length: 20 }, (_, i) => mk(i));
  // Budget below the preserved tail (500t) forces repeated folding passes.
  const result = await compactHistory(fakeProvider, history, {
    preserveRecentTokens: 500,
    budgetTokens: 400,
  });
  assert.ok(result.passes >= 2, `expected incremental folding, got ${result.passes} pass`);
  assert.ok(result.messages[0]!.content.includes('FAKE SUMMARY'));
});
