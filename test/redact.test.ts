import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRedactor } from '../src/kernel/redact.js';

test('makeRedactor replaces known secret values and URL credentials', () => {
  process.env.RZ_REDACT_TOKEN = 'supersecret123';
  try {
    const redact = makeRedactor();
    const out = redact('my token is supersecret123 here and http://user:pass@example.com/ there');
    assert.ok(!out.includes('supersecret123'), `secret leaked: ${out}`);
    assert.ok(out.includes('[redacted]'), `no redaction marker: ${out}`);
    assert.ok(out.includes('http://[redacted]@example.com/'), `url creds not redacted: ${out}`);
  } finally {
    delete process.env.RZ_REDACT_TOKEN;
  }
});

test('makeRedactor redacts multiple occurrences and short values are kept', () => {
  process.env.RZ_REDACT_TOKEN = 'longsecrecy';
  process.env.RZ_REDACT_TINY = 'abc';
  try {
    const redact = makeRedactor();
    const out = redact('a longsecrecy b longsecrecy c abc d');
    assert.ok(!out.includes('longsecrecy'));
    assert.equal(out.includes('abc'), true, 'values < 6 chars are not treated as secrets');
  } finally {
    delete process.env.RZ_REDACT_TOKEN;
    delete process.env.RZ_REDACT_TINY;
  }
});
