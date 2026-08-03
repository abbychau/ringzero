import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, estimateCost, cacheHitRate, fmtCost, MODEL_PRICES } from '../src/kernel/cost.js';

test('priceFor matches the longest model-name prefix', () => {
  assert.deepEqual(priceFor('gpt-4o-2024-08-06'), MODEL_PRICES['gpt-4o']);
  assert.deepEqual(priceFor('gpt-4o-mini-2024-07-18'), MODEL_PRICES['gpt-4o-mini']);
  assert.deepEqual(priceFor('deepseek-v4-flash'), MODEL_PRICES['deepseek-v4-flash']);
});

test('priceFor is case-insensitive and falls back to the default', () => {
  assert.deepEqual(priceFor('DeepSeek-Chat'), MODEL_PRICES['deepseek-chat']);
  assert.deepEqual(priceFor('some-brand-new-model'), { input: 1, output: 3, cacheRead: 0.2 });
});

test('estimateCost prices input/output/cache-read tokens', () => {
  // 1M in * 0.27 + 100k out * 1.1 + 500k cached * 0.07 → 0.415 USD
  const u = { input: 1_000_000, output: 100_000, cacheRead: 500_000 };
  assert.equal(estimateCost('deepseek-chat', u), 0.415);
});

test('estimateCost counts cacheWrite like cacheRead', () => {
  const u = { input: 1_000_000, output: 0, cacheWrite: 1_000_000 };
  assert.equal(estimateCost('deepseek-chat', u), 0.27 + 0.07);
});

test('cacheHitRate is cached/(input+cached), guarded against zero', () => {
  assert.equal(cacheHitRate({ input: 5000, output: 100, cacheRead: 5000 }), 0.5);
  assert.equal(cacheHitRate({ input: 0, output: 0 }), 0);
  assert.equal(cacheHitRate({ input: 1000, output: 0 }), 0);
});

test('fmtCost adapts precision to the magnitude', () => {
  assert.equal(fmtCost(0), '$0');
  assert.equal(fmtCost(-0.01), '$0');
  assert.equal(fmtCost(0.0085), '$0.0085');
  assert.equal(fmtCost(0.0123), '$0.012');
  assert.equal(fmtCost(1.5), '$1.50');
  assert.equal(fmtCost(150), '$150');
});
