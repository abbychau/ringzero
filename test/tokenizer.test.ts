import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTokens } from '../src/kernel/tokenizer.js';

test('ascii heuristic: ~4 chars per token', () => {
  assert.equal(countTokens('hello world'), Math.ceil(11 / 4));
  assert.equal(countTokens(''), 0);
});

test('cjk heuristic: ~1 token per CJK char', () => {
  // 8 Chinese chars → 8 tokens
  assert.equal(countTokens('中文測試文本測試'), 8);
});

test('cjk vs ascii mixed', () => {
  const ascii = 'hello world';
  const cjk = '中文測試';
  const combined = countTokens(`${ascii} ${cjk}`);
  assert.equal(combined, Math.ceil(ascii.length / 4) + cjk.length);
});

test('handles japanese kana and hangul', () => {
  assert.equal(countTokens('こんにちは'), 5);
  assert.equal(countTokens('안녕하세요'), 5);
});

test('fullwidth forms counted as cjk', () => {
  assert.equal(countTokens('ＡＢＣ'), 3);
});

test('cjkCharsPerToken option tunes density', () => {
  assert.equal(countTokens('中文測試', { cjkCharsPerToken: 2 }), Math.ceil(4 / 2));
});
