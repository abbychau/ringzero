import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { readEnvLines, setEnvKey } from '../src/cli/setup.js';

test('setEnvKey appends a new key when absent', () => {
  const out = setEnvKey(['API_URL=x'], 'API_KEY', 'sk-abc');
  assert.deepEqual(out, ['API_URL=x', 'API_KEY=sk-abc']);
});

test('setEnvKey replaces an existing uncommented key in place', () => {
  const out = setEnvKey(['API_URL=x', 'API_KEY=old', 'MODEL=m'], 'API_KEY', 'new');
  assert.deepEqual(out, ['API_URL=x', 'API_KEY=new', 'MODEL=m']);
});

test('setEnvKey ignores commented keys and appends', () => {
  const out = setEnvKey(['#API_KEY=old', 'API_URL=x'], 'API_KEY', 'new');
  assert.deepEqual(out, ['#API_KEY=old', 'API_URL=x', 'API_KEY=new']);
});

test('setEnvKey handles a key with leading spaces', () => {
  const out = setEnvKey(['  MAX_STEPS = 10'], 'MAX_STEPS', '100');
  assert.deepEqual(out, ['MAX_STEPS=100']);
});

test('readEnvLines returns [] for a missing file', () => {
  assert.deepEqual(readEnvLines('nope-does-not-exist.env'), []);
});

/** Load env from a temp cwd + RINGZERO_HOME, clearing API env vars first. */
function loadEnvIsolated(cwd: string, ringzeroHome: string) {
  const prevHome = process.env.RINGZERO_HOME;
  const prevKey = process.env.API_KEY;
  const prevEffort = process.env.EFFORT;
  process.env.RINGZERO_HOME = ringzeroHome;
  delete process.env.API_KEY;
  delete process.env.EFFORT;
  try {
    return loadEnv(cwd);
  } finally {
    if (prevHome === undefined) delete process.env.RINGZERO_HOME;
    else process.env.RINGZERO_HOME = prevHome;
    if (prevKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = prevKey;
    if (prevEffort === undefined) delete process.env.EFFORT;
    else process.env.EFFORT = prevEffort;
  }
}

test('loadEnv reads user-level ~/.ringzero/.env via RINGZERO_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'rz-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rz-cwd-'));
  writeFileSync(join(home, '.env'), 'API_KEY=ringzero-home-key\nEFFORT=max\n');
  try {
    const env = loadEnvIsolated(cwd, home);
    assert.equal(env.apiKey, 'ringzero-home-key');
    assert.equal(env.effort, 'max');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadEnv: project <cwd>/.env overrides ~/.ringzero/.env', () => {
  const home = mkdtempSync(join(tmpdir(), 'rz-home2-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rz-cwd2-'));
  writeFileSync(join(home, '.env'), 'API_KEY=home-key\n');
  writeFileSync(join(cwd, '.env'), 'API_KEY=cwd-key\n');
  try {
    const env = loadEnvIsolated(cwd, home);
    assert.equal(env.apiKey, 'cwd-key');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadEnv: real process.env wins over all .env files', () => {
  const home = mkdtempSync(join(tmpdir(), 'rz-home3-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rz-cwd3-'));
  writeFileSync(join(home, '.env'), 'API_KEY=home-key\n');
  writeFileSync(join(cwd, '.env'), 'API_KEY=cwd-key\n');
  const prevHome = process.env.RINGZERO_HOME;
  const prevKey = process.env.API_KEY;
  process.env.RINGZERO_HOME = home;
  process.env.API_KEY = 'real-env-key';
  try {
    assert.equal(loadEnv(cwd).apiKey, 'real-env-key');
  } finally {
    if (prevHome === undefined) delete process.env.RINGZERO_HOME;
    else process.env.RINGZERO_HOME = prevHome;
    if (prevKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
