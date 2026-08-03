import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isGitRepo,
  gitStatus,
  gitDiff,
  gitCommit,
  createCheckpoint,
  restoreCheckpoint,
  latestCheckpoint,
  gitStatusTool,
  gitDiffTool,
} from '../src/tools/git.js';
import type { ToolContext } from '../src/kernel/types.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  home: homedir(),
  signal: new AbortController().signal,
  ask: async () => true,
};

/** Create a temp git repo with an initial commit (a.txt = "one\n"). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rz-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

test('isGitRepo true in a repo, false outside', () => {
  const dir = makeRepo();
  assert.equal(isGitRepo(dir), true);
  assert.equal(isGitRepo(mkdtempSync(join(tmpdir(), 'rz-plain-'))), false);
  rmSync(dir, { recursive: true, force: true });
});

test('gitStatus shows untracked and modified files', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'new.txt'), 'x');
  writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
  const out = gitStatus(dir);
  assert.ok(out.includes('?? new.txt'));
  assert.ok(out.includes(' M a.txt'));
  assert.ok(out.includes('## main'));
  rmSync(dir, { recursive: true, force: true });
});

test('gitDiff shows tracked changes only', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'new.txt'), 'x'); // untracked → not in diff
  writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
  const out = gitDiff(dir);
  assert.ok(out.includes('+changed'));
  assert.ok(!out.includes('new.txt'));
  const stat = gitDiff(dir, { stat: true });
  assert.ok(stat.includes('a.txt'));
  const pathFiltered = gitDiff(dir, { path: 'a.txt' });
  assert.ok(pathFiltered.includes('+changed'));
  rmSync(dir, { recursive: true, force: true });
});

test('gitCommit stages and commits untracked and modified files', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'new.txt'), 'x');
  writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
  const out = gitCommit(dir, 'my change');
  assert.match(out, /^[0-9a-f]{7,40}/);
  const status = gitStatus(dir);
  assert.ok(status.startsWith('## main'), status);
  assert.ok(!status.includes('??'), status);
  assert.ok(!status.includes(' M'), status);
  rmSync(dir, { recursive: true, force: true });
});

test('gitCommit empty message and not-a-repo cases', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'new.txt'), 'x');
  assert.match(gitCommit(dir, '   '), /^error: empty commit message/);
  const plain = mkdtempSync(join(tmpdir(), 'rz-plain-'));
  assert.equal(gitCommit(plain, 'msg'), '(not a git repo)');
  rmSync(dir, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test('gitCommit reports (nothing to commit) on a clean tree', () => {
  const dir = makeRepo();
  assert.equal(gitCommit(dir, 'nothing'), '(nothing to commit)');
  rmSync(dir, { recursive: true, force: true });
});

test('git tools report (not a git repo) outside a repo', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'rz-plain2-'));
  assert.equal(gitStatus(plain), '(not a git repo)');
  assert.equal(gitDiff(plain), '(not a git repo)');
  const toolOut = await gitStatusTool().execute({}, { ...ctx, cwd: plain });
  assert.equal(toolOut, '(not a git repo)');
  const diffOut = await gitDiffTool().execute({}, { ...ctx, cwd: plain });
  assert.equal(diffOut, '(not a git repo)');
  rmSync(plain, { recursive: true, force: true });
});

test('checkpoint captures tracked + untracked changes and restore undoes them', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
  writeFileSync(join(dir, 'b.txt'), 'brand new\n');
  const sha = createCheckpoint(dir, 'refs/ringzero/checkpoints/t1');
  assert.ok(sha);
  assert.equal(latestCheckpoint(dir, 'refs/ringzero/checkpoints/t1'), sha);

  // Agent keeps working: more changes.
  writeFileSync(join(dir, 'a.txt'), 'one\nchanged\nmore\n');
  writeFileSync(join(dir, 'b.txt'), 'brand new\nextended\n');

  assert.equal(restoreCheckpoint(dir, sha), true);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nchanged\n');
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'brand new\n');
  rmSync(dir, { recursive: true, force: true });
});

test('restoreCheckpoint handles deletions and leaves post-checkpoint untracked files', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'd.txt'), 'tracked\n');
  execFileSync('git', ['add', 'd.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'add d'], { cwd: dir });

  // Checkpoint state: a.txt modified, b.txt added (untracked), d.txt deleted.
  writeFileSync(join(dir, 'a.txt'), 'one\nchanged\n');
  writeFileSync(join(dir, 'b.txt'), 'brand new\n');
  rmSync(join(dir, 'd.txt'));
  const sha = createCheckpoint(dir, 'refs/ringzero/checkpoints/t3');
  assert.ok(sha);

  // After the checkpoint: more edits, b.txt deleted, c.txt created.
  writeFileSync(join(dir, 'a.txt'), 'one\nchanged\nmore\n');
  rmSync(join(dir, 'b.txt'));
  writeFileSync(join(dir, 'c.txt'), 'post checkpoint\n');

  assert.equal(restoreCheckpoint(dir, sha), true);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nchanged\n');
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'brand new\n'); // recreated
  assert.equal(existsSync(join(dir, 'd.txt')), false); // stays deleted
  assert.equal(readFileSync(join(dir, 'c.txt'), 'utf8'), 'post checkpoint\n'); // untouched
  const status = gitStatus(dir);
  assert.ok(status.includes(' M a.txt'), status);
  assert.ok(status.includes(' D d.txt'), status);
  assert.ok(status.includes('?? b.txt'), status);
  assert.ok(status.includes('?? c.txt'), status);
  rmSync(dir, { recursive: true, force: true });
});

test('createCheckpoint returns null on a clean tree', () => {
  const dir = makeRepo();
  assert.equal(createCheckpoint(dir, 'refs/ringzero/checkpoints/t2'), null);
  assert.equal(latestCheckpoint(dir, 'refs/ringzero/checkpoints/t2'), null);
  rmSync(dir, { recursive: true, force: true });
});
