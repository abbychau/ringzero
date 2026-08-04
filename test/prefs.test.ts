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
        yolo: true,
      }),
    );
    writeFileSync(
      paths.project,
      JSON.stringify({
        disabledTools: ['bash'],
        permissionOverrides: { write_file: 'allow' },
        yolo: false,
      }),
    );
    const p = loadPrefs(paths);
    assert.deepEqual([...p.disabledTools].sort(), ['bash', 'http_request']);
    assert.deepEqual(p.permissionOverrides, { bash: 'deny', write_file: 'allow' });
    assert.equal(p.yolo, false); // project wins
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
      yolo: true,
    });
    assert.ok(existsSync(paths.global));
    const raw = JSON.parse(readFileSync(paths.global, 'utf8')) as {
      disabledTools: string[];
      permissionOverrides: Record<string, string>;
      yolo: boolean;
    };
    assert.deepEqual(raw.disabledTools, ['bash', 'http_request']); // sorted
    assert.deepEqual(raw.permissionOverrides, { http_request: 'deny' });
    assert.equal(raw.yolo, true);
    const p = loadPrefs(paths);
    assert.deepEqual([...p.disabledTools].sort(), ['bash', 'http_request']);
    assert.deepEqual(p.permissionOverrides, { http_request: 'deny' });
    assert.equal(p.yolo, true);
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
    assert.equal(p.yolo, false);
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

test('PermissionGate yolo auto-allows everything, even deny rules', async () => {
  let asked = 0;
  const gate = new PermissionGate({
    rules: { read_file: 'allow', bash: 'ask', write: 'deny' },
    ask: async () => {
      asked++;
      return 'no';
    },
  });
  gate.setYolo(true);
  assert.equal(gate.yolo, true);
  // deny rule is overridden, ask is never called (even for __ask__/plan gate)
  assert.equal((await gate.check('write', '')).allowed, true);
  assert.equal((await gate.check('bash', 'rm -rf /')).allowed, true);
  assert.equal((await gate.check('__ask__', 'plan?')).allowed, true);
  assert.equal(asked, 0);
  // toggling back off restores normal rules
  gate.setYolo(false);
  assert.equal((await gate.check('bash', '')).allowed, false);
  assert.equal(asked, 1);
  assert.equal((await gate.check('read_file', '')).allowed, true);
});
