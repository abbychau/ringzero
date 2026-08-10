import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectGitRoot, loadConfig, WIN_SYSTEM_HINT } from '../src/config/config.js';

test('detectGitRoot finds the repo root from inside the repo', () => {
  const root = detectGitRoot(process.cwd());
  assert.ok(root, 'expected a git root for the repo itself');
  // git may return forward slashes on Windows; compare normalized.
  assert.equal(resolve(root), resolve(process.cwd()));
});

test('detectGitRoot is undefined outside a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-plain-'));
  assert.equal(detectGitRoot(dir), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('WIN_SYSTEM_HINT tells the agent cmd.exe lacks POSIX tools and what to use', () => {
  // The agent keeps reaching for grep/tail/ls in the Windows shell; the hint
  // must name the missing commands and the working alternatives explicitly.
  assert.ok(WIN_SYSTEM_HINT.includes('cmd.exe'), WIN_SYSTEM_HINT);
  assert.ok(WIN_SYSTEM_HINT.includes('no grep, tail'), WIN_SYSTEM_HINT);
  assert.ok(WIN_SYSTEM_HINT.includes('findstr'), WIN_SYSTEM_HINT);
  assert.ok(WIN_SYSTEM_HINT.includes('list_dir'), WIN_SYSTEM_HINT);
  assert.ok(WIN_SYSTEM_HINT.includes('backslashes'), WIN_SYSTEM_HINT);
  // Must stay a single paragraph (the system prompt list is one block per item).
  assert.ok(!WIN_SYSTEM_HINT.includes('\n'), 'hint should be one line');
});

test('loadConfig resolves an explicit RINGZERO_WORKSPACE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-ws-'));
  const prev = process.env.RINGZERO_WORKSPACE;
  process.env.RINGZERO_WORKSPACE = dir;
  try {
    assert.equal(loadConfig().workspace, resolve(dir));
  } finally {
    if (prev === undefined) delete process.env.RINGZERO_WORKSPACE;
    else process.env.RINGZERO_WORKSPACE = prev;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('loadConfig with RINGZERO_WORKSPACE=off disables the sandbox', () => {
  const prev = process.env.RINGZERO_WORKSPACE;
  process.env.RINGZERO_WORKSPACE = 'off';
  try {
    assert.equal(loadConfig().workspace, undefined);
  } finally {
    if (prev === undefined) delete process.env.RINGZERO_WORKSPACE;
    else process.env.RINGZERO_WORKSPACE = prev;
  }
});

test('loadConfig auto-detects the git root as workspace when unset', () => {
  const prev = process.env.RINGZERO_WORKSPACE;
  // '' means unset here but still blocks .env from re-setting it (loadEnv
  // never overrides keys already present in process.env).
  process.env.RINGZERO_WORKSPACE = '';
  try {
    const ws = loadConfig().workspace;
    assert.ok(ws, 'expected workspace to be auto-detected');
    assert.equal(resolve(ws), resolve(process.cwd()));
  } finally {
    if (prev === undefined) delete process.env.RINGZERO_WORKSPACE;
    else process.env.RINGZERO_WORKSPACE = prev;
  }
});

/** Run fn with an env var set (or removed when value is undefined), restoring after. */
async function withEnv(key: string, value: string | undefined, fn: () => void | Promise<void>) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('MAX_STEPS (short name) wins over RINGZERO_MAX_STEPS', () => {
  return withEnv('MAX_STEPS', '48', () =>
    withEnv('RINGZERO_MAX_STEPS', '10', () => {
      assert.equal(loadConfig().maxSteps, 48);
    }),
  );
});

test('MAX_STEPS=-1 means unlimited steps', () => {
  return withEnv('MAX_STEPS', '-1', () =>
    withEnv('RINGZERO_MAX_STEPS', '10', () => {
      assert.equal(loadConfig().maxSteps, -1);
    }),
  );
});

test('EFFORT maps to env.effort, short name wins over RINGZERO_EFFORT', () => {
  return withEnv('EFFORT', 'high', () =>
    withEnv('RINGZERO_EFFORT', 'low', () => {
      assert.equal(loadConfig().env.effort, 'high');
    }),
  );
});

test('EFFORT empty string disables effort even when RINGZERO_EFFORT is set', () => {
  return withEnv('EFFORT', '', () =>
    withEnv('RINGZERO_EFFORT', 'low', () => {
      // `??` semantics: an empty short name shadows the long alias (same as
      // CONTEXT_BUDGET / RINGZERO_CONTEXT_BUDGET).
      assert.equal(loadConfig().env.effort, undefined);
    }),
  );
});

test('unknown EFFORT values are ignored', () => {
  return withEnv('EFFORT', 'ultra', () => {
    assert.equal(loadConfig().env.effort, undefined);
  });
});

test('YOLO truthy values enable yolo, falsy/unknown disable it', () => {
  return withEnv('YOLO', '1', () =>
    withEnv('RINGZERO_YOLO', '', () => {
      assert.equal(loadConfig().env.yolo, true);
    }),
  )
    .then(() =>
      withEnv('YOLO', 'true', () =>
        withEnv('RINGZERO_YOLO', '', () => {
          assert.equal(loadConfig().env.yolo, true);
        }),
      ),
    )
    .then(() =>
      withEnv('YOLO', '0', () =>
        withEnv('RINGZERO_YOLO', '', () => {
          assert.equal(loadConfig().env.yolo, false);
        }),
      ),
    )
    .then(() =>
      withEnv('YOLO', 'banana', () =>
        withEnv('RINGZERO_YOLO', '', () => {
          assert.equal(loadConfig().env.yolo, false);
        }),
      ),
    );
});

test('YOLO empty string shadows RINGZERO_YOLO (like EFFORT)', () => {
  return withEnv('YOLO', '', () =>
    withEnv('RINGZERO_YOLO', '1', () => {
      assert.equal(loadConfig().env.yolo, undefined);
    }),
  );
});

test('RINGZERO_COST_CAP and RINGZERO_TOKEN_CAP map onto config', () => {
  return withEnv('RINGZERO_COST_CAP', '0.5', () =>
    withEnv('RINGZERO_TOKEN_CAP', '100000', () => {
      const c = loadConfig();
      assert.equal(c.costCap, 0.5);
      assert.equal(c.tokenCap, 100000);
    }),
  );
});

test('unset or invalid caps mean no cap', () => {
  return withEnv('RINGZERO_COST_CAP', undefined, () =>
    withEnv('RINGZERO_TOKEN_CAP', undefined, () => {
      const c = loadConfig();
      assert.equal(c.costCap, undefined);
      assert.equal(c.tokenCap, undefined);
    }),
  ).then(() =>
    withEnv('RINGZERO_COST_CAP', '0', () =>
      withEnv('RINGZERO_TOKEN_CAP', '-5', () => {
        const c = loadConfig();
        assert.equal(c.costCap, undefined);
        assert.equal(c.tokenCap, undefined);
      }),
    ),
  );
});
