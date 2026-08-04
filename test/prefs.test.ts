import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrefs, savePrefs, type PrefsPaths } from '../src/config/prefs.js';
import { PermissionGate } from '../src/permission/gate.js';

function tmpPaths(): { paths: PrefsPaths; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rz-prefs-'));
  return {
    dir,
    paths: {
      project: join(dir, 'project.json'),
      global: join(dir, 'global.json'),
    },
  };
}

test('loadPrefs merges global then project (project wins per key)', () => {
  const { paths, dir } = tmpPaths();
  try {
    writeFileSync(
      paths.global,
      JSON.stringify({
        disabledTools: ['bash', 'http_request'],
        permissionOverrides: { bash: 'deny', write_file: 'ask' },
      }),
    );
    writeFileSync(
      paths.project,
      JSON.stringify({
        disabledTools: ['bash'],
        permissionOverrides: { write_file: 'allow' },
      }),
    );
    const p = loadPrefs(paths);
    assert.deepEqual([...p.disabledTools].sort(), ['bash', 'http_request']);
    assert.deepEqual(p.permissionOverrides, { bash: 'deny', write_file: 'allow' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('savePrefs writes the global file and round-trips', () => {
  const { paths, dir } = tmpPaths();
  try {
    savePrefs(paths, {
      disabledTools: new Set(['bash', 'http_request']),
      permissionOverrides: { http_request: 'deny' },
    });
    assert.ok(existsSync(paths.global));
    const raw = JSON.parse(readFileSync(paths.global, 'utf8')) as {
      disabledTools: string[];
      permissionOverrides: Record<string, string>;
    };
    assert.deepEqual(raw.disabledTools, ['bash', 'http_request']); // sorted
    assert.deepEqual(raw.permissionOverrides, { http_request: 'deny' });
    const p = loadPrefs(paths);
    assert.deepEqual([...p.disabledTools].sort(), ['bash', 'http_request']);
    assert.deepEqual(p.permissionOverrides, { http_request: 'deny' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPrefs ignores missing and corrupt files', () => {
  const { paths, dir } = tmpPaths();
  try {
    writeFileSync(paths.global, '{ not json !!!');
    writeFileSync(paths.project, '[]'); // not an object
    const p = loadPrefs(paths);
    assert.equal(p.disabledTools.size, 0);
    assert.deepEqual(p.permissionOverrides, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPrefs drops invalid rules and non-string tool names', () => {
  const { paths, dir } = tmpPaths();
  try {
    writeFileSync(
      paths.global,
      JSON.stringify({
        disabledTools: ['bash', 42, null, ''],
        permissionOverrides: { bash: 'allow', weird: 'sometimes', n: 1 },
      }),
    );
    const p = loadPrefs(paths);
    assert.deepEqual([...p.disabledTools], ['bash']);
    assert.deepEqual(p.permissionOverrides, { bash: 'allow' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PermissionGate onOverride fires on setOverride (incl. always/never)', async () => {
  const fired: [string, string][] = [];
  const gate = new PermissionGate({
    rules: { bash: 'ask' },
    ask: async () => 'always',
    onOverride: (name, rule) => fired.push([name, rule]),
  });
  assert.deepEqual(gate.listOverrides(), {});
  assert.equal((await gate.check('bash', '')).allowed, true);
  assert.deepEqual(gate.listOverrides(), { bash: 'allow' });
  assert.deepEqual(fired, [['bash', 'allow']]);
  gate.setOverride('read_file', 'deny');
  assert.deepEqual(fired, [
    ['bash', 'allow'],
    ['read_file', 'deny'],
  ]);
  // clearOverride does not fire (nothing to persist)
  gate.clearOverride('read_file');
  assert.deepEqual(gate.listOverrides(), { bash: 'allow' });
});
