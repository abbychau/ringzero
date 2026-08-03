import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectGitRoot, loadConfig } from '../src/config/config.js';

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
  delete process.env.RINGZERO_WORKSPACE;
  try {
    const ws = loadConfig().workspace;
    assert.ok(ws, 'expected workspace to be auto-detected');
    assert.equal(resolve(ws), resolve(process.cwd()));
  } finally {
    if (prev !== undefined) process.env.RINGZERO_WORKSPACE = prev;
  }
});
