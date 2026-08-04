import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkNodeVersion, doctorReport } from '../src/cli/doctor.js';
import type { AppConfig } from '../src/config/config.js';

function fakeConfig(over: Partial<AppConfig> = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'rz-doctor-'));
  return {
    env: {
      apiUrl: '',
      apiKey: '',
      model: 'test',
      anthropicApiKey: undefined,
      geminiApiKey: undefined,
    },
    cwd: dir,
    home: tmpdir(),
    ringzeroHome: join(dir, 'ringzero-home'),
    workspace: undefined,
    sessionsDir: join(dir, 'sessions'),
    skillsDirs: [],
    pluginDirs: [],
    contextBudget: 32_000,
    preserveRecentTokens: 8_000,
    maxSteps: 24,
    systemPrompt: [],
    favoriteModels: ['test'],
    permissions: {},
    ...over,
  };
}

test('checkNodeVersion passes on the running Node', () => {
  assert.equal(checkNodeVersion().level, 'ok');
});

test('doctorReport flags a missing provider and no sandbox', () => {
  const cfg = fakeConfig();
  try {
    const findings = doctorReport(cfg);
    const byLabel = new Map(findings.map((f) => [f.label, f.level]));
    assert.equal(byLabel.get('Provider'), 'fail');
    assert.equal(byLabel.get('Workspace sandbox'), 'warn');
    assert.equal(byLabel.get('Git repo'), 'warn');
    assert.equal(byLabel.get('Sessions dir'), 'ok'); // created under the tmp dir
  } finally {
    rmSync(cfg.cwd, { recursive: true, force: true });
  }
});

test('doctorReport passes with an OpenAI-compatible provider configured', () => {
  const cfg = fakeConfig({
    env: { apiUrl: 'http://localhost:11434/v1', apiKey: 'x', model: 'test' },
  });
  try {
    const findings = doctorReport(cfg);
    const provider = findings.find((f) => f.label === 'Provider');
    assert.equal(provider?.level, 'ok');
    assert.ok(provider?.detail?.includes('OpenAI-compatible'));
  } finally {
    rmSync(cfg.cwd, { recursive: true, force: true });
  }
});
