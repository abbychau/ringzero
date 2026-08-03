import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../src/providers/retry.js';

test('fetchWithRetry retries 429 then succeeds', async (t) => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
    return new Response('ok', { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  const res = await fetchWithRetry('http://x', {}, { retries: 2, baseDelayMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('fetchWithRetry gives up after retries, returns last response', async (t) => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  const res = await fetchWithRetry('http://x', {}, { retries: 1, baseDelayMs: 1 });
  assert.equal(res.status, 429);
  assert.equal(calls, 2);
});

test('fetchWithRetry retries network errors', async (t) => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('ECONNRESET');
    return new Response('ok', { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  const res = await fetchWithRetry('http://x', {}, { retries: 2, baseDelayMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});
