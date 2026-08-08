import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { sanitizeEnv, bashTool, decodeOutput } from '../src/tools/bash.js';
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

test('decodeOutput passes valid UTF-8 through (incl. CJK)', () => {
  assert.equal(decodeOutput(Buffer.from('你好世界', 'utf8')), '你好世界');
  assert.equal(decodeOutput(Buffer.from('plain ascii\n', 'ascii')), 'plain ascii\n');
});

test('decodeOutput falls back to the forced legacy encoding (GBK)', () => {
  process.env.RINGZERO_OS_ENCODING = 'gbk';
  try {
    // 中文 in GBK = D6D0 CEC4 (invalid UTF-8, would otherwise show as mojibake)
    assert.equal(decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文');
    // valid UTF-8 still wins even with an override
    assert.equal(decodeOutput(Buffer.from('你好', 'utf8')), '你好');
  } finally {
    delete process.env.RINGZERO_OS_ENCODING;
  }
});

test('decodeOutput falls back to Big5 when forced', () => {
  process.env.RINGZERO_OS_ENCODING = 'big5';
  try {
    // 中文 in Big5 = A4A4 A4E5
    assert.equal(decodeOutput(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])), '中文');
  } finally {
    delete process.env.RINGZERO_OS_ENCODING;
  }
});

test('decodeOutput tolerates an unsupported forced encoding', () => {
  process.env.RINGZERO_OS_ENCODING = 'not-a-encoding';
  try {
    assert.equal(decodeOutput(Buffer.from([0xd6, 0xd0])), '\uFFFD\uFFFD');
  } finally {
    delete process.env.RINGZERO_OS_ENCODING;
  }
});

test('decodeOutput trims a trailing partial UTF-8 sequence before fallback', () => {
  // Byte-cap truncation can cut a multi-byte char in half; the incomplete tail
  // must not poison the whole buffer into the legacy-codepage fallback (which
  // produced mojibake + PUA garbage that broke TUI row widths).
  const buf = Buffer.concat([Buffer.from('你好世界', 'utf8'), Buffer.from([0xe4, 0xbd])]);
  assert.equal(decodeOutput(buf), '你好世界');
  // Pure truncated ASCII is unaffected.
  assert.equal(decodeOutput(Buffer.from('abc')), 'abc');
  // A genuinely legacy-encoded (Big5) buffer is NOT trimmed and still decodes
  // via the forced codepage.
  process.env.RINGZERO_OS_ENCODING = 'big5';
  try {
    assert.equal(decodeOutput(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])), '中文');
  } finally {
    delete process.env.RINGZERO_OS_ENCODING;
  }
});

test('bash tool passes UTF-8 CJK output through', async () => {
  // 你好 written as raw UTF-8 bytes so the command line itself stays ASCII
  // (survives any shell codepage on Windows CI runners).
  const out = await bashTool().execute(
    { command: 'node -e "process.stdout.write(Buffer.from([0xe4,0xbd,0xa0,0xe5,0xa5,0xbd]))"' },
    ctx,
  );
  assert.equal(out, '你好');
});

test('bash tool decodes legacy-encoded CJK output (GBK)', async () => {
  process.env.RINGZERO_OS_ENCODING = 'gbk';
  try {
    const out = await bashTool().execute(
      { command: 'node -e "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))"' },
      ctx,
    );
    assert.equal(out, '中文');
  } finally {
    delete process.env.RINGZERO_OS_ENCODING;
  }
});
