/**
 * Git integration (zero-dep, shells out to the git binary like Claude Code).
 * Provides working-tree status/diff tools plus checkpoint snapshots used by
 * /checkpoint and /rollback.
 *
 * Checkpoints are captured through a temporary index (GIT_INDEX_FILE):
 * read-tree HEAD → add -A → write-tree → commit-tree → update-ref. This
 * records tracked changes, untracked files and deletions in one tree without
 * touching the real index. Restoring replays that tree over the worktree with
 * checkout-index and then swaps the temporary index in, so the branch pointer
 * (HEAD) is never moved. All commands use execFileSync with an args array
 * (no shell, no injection).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import type { Tool, ToolContext } from '../kernel/types.js';

const MAX_OUT = 100_000;

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUT * 4 }).toString();
}

function runGitEnv(args: string[], cwd: string, env: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: MAX_OUT * 4,
  }).toString();
}

/** True if cwd is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Short working-tree status (branch + porcelain entries), or an error string. */
export function gitStatus(cwd: string): string {
  if (!isGitRepo(cwd)) return '(not a git repo)';
  try {
    return runGit(['--no-pager', 'status', '--short', '--branch'], cwd).trim() || '(clean)';
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface GitDiffOptions {
  path?: string;
  stat?: boolean;
}

/** Uncommitted working-tree diff (or its --stat summary), capped. */
export function gitDiff(cwd: string, opts: GitDiffOptions = {}): string {
  if (!isGitRepo(cwd)) return '(not a git repo)';
  const args = ['--no-pager', 'diff', '--no-color'];
  if (opts.stat === true) args.push('--stat');
  if (opts.path) args.push('--', opts.path);
  try {
    const out = runGit(args, cwd).trim();
    if (!out) return '(no changes)';
    return out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}\n…[truncated]…` : out;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** A temp dir holding a throwaway index; removed when the callback finishes. */
function withTempIndex<T>(fn: (index: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'rz-git-'));
  const index = join(dir, 'index');
  try {
    return fn(index);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** git config value, or undefined when unset. */
function gitConfig(cwd: string, key: string): string | undefined {
  try {
    return runGit(['config', key], cwd).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the absolute path of the real .git index file. */
function realIndexPath(cwd: string): string {
  const gitDir = runGit(['rev-parse', '--git-dir'], cwd).trim();
  const abs = isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
  return join(abs, 'index');
}

/**
 * Snapshot the worktree (tracked + untracked + deletions) as a commit-like
 * object and point `ref` at it. Returns the sha, or null when there is
 * nothing to snapshot (clean tree) or git is unavailable.
 */
export function createCheckpoint(cwd: string, ref: string): string | null {
  if (!isGitRepo(cwd)) return null;
  try {
    const sha = withTempIndex((index) => {
      const env = { GIT_INDEX_FILE: index };
      try {
        runGitEnv(['read-tree', 'HEAD'], cwd, env);
      } catch {
        runGitEnv(['read-tree', '--empty'], cwd, env); // unborn HEAD
      }
      runGitEnv(['add', '-A'], cwd, env);
      const tree = runGitEnv(['write-tree'], cwd, env).trim();
      // Nothing changed relative to HEAD (incl. no untracked files): nothing
      // to snapshot.
      let headTree = '';
      try {
        headTree = runGit(['rev-parse', 'HEAD^{tree}'], cwd).trim();
      } catch {
        // unborn HEAD
      }
      if (headTree && tree === headTree) return null;
      const args = [
        '-c',
        `user.name=${gitConfig(cwd, 'user.name') ?? 'ringzero'}`,
        '-c',
        `user.email=${gitConfig(cwd, 'user.email') ?? 'ringzero@localhost'}`,
        'commit-tree',
        tree,
      ];
      let head: string;
      try {
        head = runGit(['rev-parse', '--verify', 'HEAD'], cwd).trim();
      } catch {
        head = '';
      }
      if (head) args.push('-p', head);
      args.push('-m', 'ringzero checkpoint');
      return runGit(args, cwd).trim();
    });
    return sha && setCheckpoint(cwd, ref, sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Point `ref` at a sha (or delete it when sha is null). Returns success. */
export function setCheckpoint(cwd: string, ref: string, sha: string | null): boolean {
  try {
    execFileSync('git', sha ? ['update-ref', ref, sha] : ['update-ref', '-d', ref], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** The sha currently pointed to by `ref`, or null. */
export function latestCheckpoint(cwd: string, ref: string): string | null {
  try {
    const out = runGit(['rev-parse', '--verify', ref], cwd).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Restore the worktree to the checkpoint state and put the index back to
 * HEAD, so the snapshot shows as ordinary unstaged changes (new files stay
 * untracked, deletions stay unstaged). Files created after the checkpoint
 * are left alone. HEAD/branch pointers are never moved. Returns success.
 */
export function restoreCheckpoint(cwd: string, ref: string): boolean {
  try {
    return withTempIndex((index) => {
      const env = { GIT_INDEX_FILE: index };
      runGitEnv(['read-tree', ref], cwd, env);
      runGitEnv(['checkout-index', '-a', '-f'], cwd, env);
      const headIndex = join(dirname(index), 'head-index');
      try {
        runGitEnv(['read-tree', 'HEAD'], cwd, { GIT_INDEX_FILE: headIndex });
      } catch {
        runGitEnv(['read-tree', '--empty'], cwd, { GIT_INDEX_FILE: headIndex }); // unborn HEAD
      }
      const real = realIndexPath(cwd);
      if (existsSync(real)) copyFileSync(headIndex, real);
      return true;
    });
  } catch {
    return false;
  }
}

export function gitStatusTool(): Tool {
  return {
    definition: {
      name: 'git_status',
      description:
        'Show git working-tree status (short format with branch). Returns "(not a git repo)" when the project is not under git.',
      inputSchema: { type: 'object', properties: {} },
    },
    async execute(_input, ctx: ToolContext) {
      return gitStatus(ctx.cwd);
    },
  };
}

export interface GitLogOptions {
  /** Restrict to commits touching this path. */
  path?: string;
  /** Pickaxe search: commits that added or removed this string. */
  search?: string;
  /** Include the --stat file summary. */
  stat?: boolean;
  /** Max commits (default 20, capped at 50). */
  count?: number;
}

/** Recent commit history (oneline or --stat), capped. */
export function gitLog(cwd: string, opts: GitLogOptions = {}): string {
  if (!isGitRepo(cwd)) return '(not a git repo)';
  const n = Math.min(50, Math.max(1, Math.floor(opts.count ?? 20)));
  const args = ['--no-pager', 'log'];
  if (opts.stat === true) args.push('--stat');
  else args.push('--oneline');
  if (opts.search) args.push('-S', opts.search);
  args.push('-n', String(n));
  if (opts.path) args.push('--', opts.path);
  try {
    const out = runGit(args, cwd).trim();
    if (!out) return '(no commits)';
    return out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}\n…[truncated]…` : out;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function gitLogTool(): Tool {
  return {
    definition: {
      name: 'git_log',
      description:
        'Show recent commit history (one line each). search picks commits that added or removed the given string (-S pickaxe); path restricts to one file or directory; stat adds the file summary. Returns "(not a git repo)" outside a repo.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'restrict to commits touching this path' },
          search: { type: 'string', description: 'commits adding/removing this string' },
          stat: { type: 'boolean', description: 'include the diffstat summary' },
          count: { type: 'number', description: 'max commits (default 20, max 50)' },
        },
      },
    },
    async execute(input, ctx: ToolContext) {
      return gitLog(ctx.cwd, {
        path: input.path ? String(input.path) : undefined,
        search: input.search ? String(input.search) : undefined,
        stat: input.stat === true,
        count: typeof input.count === 'number' ? input.count : undefined,
      });
    },
  };
}

/**
 * Stage everything (git add -A) and commit with `message`. Returns the new
 * commit id (short form) or a human-readable status string: '(not a git
 * repo)', '(nothing to commit)', or 'error: …'.
 */
export function gitCommit(cwd: string, message: string): string {
  if (!isGitRepo(cwd)) return '(not a git repo)';
  const m = message.trim();
  if (!m) return 'error: empty commit message';
  try {
    runGit(['add', '-A'], cwd);
    runGit(['commit', '-m', m], cwd);
  } catch (e) {
    const err = e as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const out = `${err.stdout ? String(err.stdout) : ''}${err.stderr ? String(err.stderr) : ''}`;
    if ((err.message + '\n' + out).includes('nothing to commit')) return '(nothing to commit)';
    return `error: ${out.trim().split('\n')[0] || err.message}`;
  }
  return runGit(['--no-pager', 'log', '-1', '--oneline'], cwd).trim();
}

export function gitCommitTool(): Tool {
  return {
    definition: {
      name: 'git_commit',
      description:
        'Stage all working-tree changes (git add -A) and commit them with the given message. Returns the new commit id, "(nothing to commit)", or an error.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'commit message' },
        },
        required: ['message'],
      },
    },
    async execute(input, ctx: ToolContext) {
      return gitCommit(ctx.cwd, input.message ? String(input.message) : '');
    },
  };
}

export function gitDiffTool(): Tool {
  return {
    definition: {
      name: 'git_diff',
      description:
        'Show uncommitted working-tree changes (git diff). stat=true returns just the file summary; path restricts the diff to one file or directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'restrict the diff to this path' },
          stat: { type: 'boolean', description: 'show only the --stat summary' },
        },
      },
    },
    async execute(input, ctx: ToolContext) {
      return gitDiff(ctx.cwd, {
        path: input.path ? String(input.path) : undefined,
        stat: input.stat === true,
      });
    },
  };
}
