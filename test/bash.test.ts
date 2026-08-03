import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { sanitizeEnv, bashTool } from '../src/tools/bash.js';
import type { ToolContext } from '../src/kernel/types.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  home: homedir(),
  signal: new AbortController().signal,
  ask: async () => true,
};

test('sanitizeEnv strips secret-looking variables', () => {
  process.env.RZ_TEST_TOKEN = 'hunter2';
  process.env.RZ_TEST_API_KEY = 'abc123xyz';
  process.env.RZ_TEST_PASSWORD = 'pw';
  process.env.RZ_TEST_AUTH_TOKEN = 'auth-token-123';
  process.env.RZ_TEST_PLAIN = 'visible';
  try {
    const env = sanitizeEnv();
    assert.equal(env.RZ_TEST_TOKEN, undefined);
    assert.equal(env.RZ_TEST_API_KEY, undefined);
    assert.equal(env.RZ_TEST_PASSWORD, undefined);
    assert.equal(env.RZ_TEST_AUTH_TOKEN, undefined);
    assert.equal(env.RZ_TEST_PLAIN, 'visible');
  } finally {
    delete process.env.RZ_TEST_TOKEN;
    delete process.env.RZ_TEST_API_KEY;
    delete process.env.RZ_TEST_PASSWORD;
    delete process.env.RZ_TEST_AUTH_TOKEN;
    delete process.env.RZ_TEST_PLAIN;
  }
});

test('sanitizeEnv honors RINGZERO_BASH_FULL_ENV=1 opt-out', () => {
  process.env.RZ_TEST_TOKEN = 'hunter2';
  process.env.RINGZERO_BASH_FULL_ENV = '1';
  try {
    const env = sanitizeEnv();
    assert.equal(env.RZ_TEST_TOKEN, 'hunter2');
  } finally {
    delete process.env.RZ_TEST_TOKEN;
    delete process.env.RINGZERO_BASH_FULL_ENV;
  }
});

test('bash tool child processes do not see secrets', async () => {
  process.env.RZ_TEST_TOKEN = 'hunter2';
  try {
    const out = await bashTool().execute(
      { command: 'node -e "console.log(process.env.RZ_TEST_TOKEN || \'none\')"' },
      ctx,
    );
    assert.ok(out.includes('none'), `got: ${out}`);
    assert.ok(!out.includes('hunter2'), 'secret leaked into bash output');
  } finally {
    delete process.env.RZ_TEST_TOKEN;
  }
});

test('bash tool clamps timeout_ms to the 1s..10min range', async () => {
  // A tiny command with an absurd timeout must still run (clamped, not rejected).
  const out = await bashTool().execute(
    { command: 'node -e "console.log(42)"', timeout_ms: 0 },
    ctx,
  );
  assert.ok(out.includes('42'), `got: ${out}`);
  const out2 = await bashTool().execute(
    { command: 'node -e "console.log(7)"', timeout_ms: 9_999_999 },
    ctx,
  );
  assert.ok(out2.includes('7'), `got: ${out2}`);
});
