import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { loadEnv, type Env } from './env.js';
import type { PermissionRule } from '../permission/gate.js';

export interface AppConfig {
  env: Env;
  cwd: string;
  home: string;
  /** RingZero data dir (~/.ringzero by default; RINGZERO_HOME overrides). */
  ringzeroHome: string;
  /** Optional root that fs tools are locked to (paths outside are rejected). */
  workspace?: string;
  sessionsDir: string;
  skillsDirs: string[];
  pluginDirs: string[];
  contextBudget: number;
  preserveRecentTokens: number;
  maxSteps: number;
  /** Hard USD cost cap per run (RINGZERO_COST_CAP); unset = no cap. */
  costCap?: number;
  /** Hard cumulative-token cap per run (RINGZERO_TOKEN_CAP); unset = no cap. */
  tokenCap?: number;
  systemPrompt: string[];
  favoriteModels: string[];
  permissions: Record<string, PermissionRule>;
  /** Optional shell command run after write/edit tools (RINGZERO_VERIFY). */
  verifyCommand?: string;
}

const DEFAULT_SYSTEM = `You are RingZero, a coding agent that completes work by using tools.
You operate autonomously in the user's workspace: inspect, search, edit, and run
commands with the available tools. Do the actual work rather than only
describing what you would do.
Rules:
- Use tools to gather context, make changes, and verify results. Prefer
  edit_file over write_file to save tokens.
- Prefer the dedicated filesystem tools (list_dir, tree, read_file, grep,
  glob) over shell commands for inspecting files — they are cross-platform
  and cheap. Use bash only for things the dedicated tools cannot do (builds,
  tests, git, running programs).
- Work step by step. When you change code or run something, verify the outcome
  (build, tests, or reading the output) before declaring it done.
- Keep responses concise and in the user's language.
- Answer simple conversational questions directly; use tools when the request
  involves inspecting, modifying, or running anything in the workspace.`;

/**
 * Appended to the system prompt on Windows: the bash tool runs cmd.exe, which
 * has none of the POSIX utilities (grep/tail/ls/cat/…) models reach for by
 * default. State the constraint and the alternatives explicitly, or the agent
 * keeps burning turns on "'grep' is not recognized".
 */
export const WIN_SYSTEM_HINT =
  'Environment: Windows. The bash tool runs cmd.exe — it has no grep, tail, head, ' +
  'ls, cat, sed, awk, diff, rm, mv, cp, or touch. For files use the dedicated ' +
  'cross-platform tools (grep, glob, list_dir, tree, read_file, edit_file, ' +
  'write_file). For shell-only work use cmd/PowerShell natives: dir, type, ' +
  'findstr /s /i "pattern" *, where, powershell -c "Get-Content file". ' +
  'Paths use backslashes, e.g. C:\\Users\\name\\project.';

export function num(envVar: string | undefined, fallback: number): number {
  const v = Number(envVar);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The git work-tree root of cwd, or undefined when not inside a git repo.
 * Used as the default workspace sandbox so fs tools stay inside the project.
 */
export function detectGitRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** All ancestor directories from dir up to the filesystem root. */
export function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let cur = resolve(dir);
  while (true) {
    out.push(cur);
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/**
 * Build the app config from env (see loadEnv for .env precedence). `envFile`
 * is an explicit env file from the CLI `--env <path>` flag.
 */
export function loadConfig(envFile?: string): AppConfig {
  const env = loadEnv(envFile);
  const cwd = process.cwd();
  const home = homedir();
  const ringzeroHome = process.env.RINGZERO_HOME ?? join(home, '.ringzero');
  const sessionsDir = process.env.RINGZERO_SESSIONS ?? join(ringzeroHome, 'sessions');
  // Workspace sandbox: explicit RINGZERO_WORKSPACE wins; 'off'/'none' disables
  // the sandbox; unset falls back to the git work-tree root (when inside a repo).
  let workspace: string | undefined;
  const wsEnv = process.env.RINGZERO_WORKSPACE;
  if (wsEnv !== undefined && wsEnv !== '' && wsEnv !== 'off' && wsEnv !== 'none') {
    workspace = resolve(wsEnv);
  } else if (wsEnv === undefined || wsEnv === '') {
    workspace = detectGitRoot(cwd);
  }
  const favoriteModels = (process.env.RINGZERO_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // MAX_STEPS (short, handy in .env) wins over RINGZERO_MAX_STEPS; -1 = unlimited.
  const maxStepsEnv = process.env.MAX_STEPS ?? process.env.RINGZERO_MAX_STEPS;

  const systemPrompt: string[] = [
    DEFAULT_SYSTEM,
    // Windows: bash runs cmd.exe — POSIX utilities don't exist. Say so
    // explicitly or the agent keeps trying grep/tail/ls in the shell.
    ...(process.platform === 'win32' ? [WIN_SYSTEM_HINT] : []),
    // Date injection (separate block so Anthropic keeps the static rules cached
    // even as the date rolls; the model uses it for commit messages/date math).
    `Today: ${new Date().toISOString().slice(0, 10)} (UTC). Use this for commit messages, timestamps, and date math.`,
  ];
  // RINGZERO_SYSTEM: extra system rules appended verbatim (used by the
  // benchmark adapter to push task-oriented behavior, e.g. "actually modify
  // files / run commands instead of answering with text alone").
  const extraSystem = process.env.RINGZERO_SYSTEM;
  if (extraSystem) systemPrompt.push(extraSystem);
  const systemMd = join(cwd, 'SYSTEM.md');
  if (existsSync(systemMd)) systemPrompt.push(readFileSync(systemMd, 'utf8'));
  for (const dir of ancestorDirs(cwd)) {
    const p = join(dir, 'AGENTS.md');
    if (existsSync(p)) systemPrompt.push(`# AGENTS.md (${dir})\n${readFileSync(p, 'utf8')}`);
  }

  return {
    env,
    cwd,
    home,
    ringzeroHome,
    workspace,
    sessionsDir,
    skillsDirs: [join(cwd, '.ringzero', 'skills'), join(ringzeroHome, 'skills')],
    pluginDirs: [join(cwd, '.ringzero', 'plugins'), join(ringzeroHome, 'plugins')],
    // CONTEXT_BUDGET (short, for .env) takes precedence, falls back to RINGZERO_CONTEXT_BUDGET.
    contextBudget: num(process.env.CONTEXT_BUDGET ?? process.env.RINGZERO_CONTEXT_BUDGET, 32_000),
    preserveRecentTokens: num(process.env.RINGZERO_PRESERVE_RECENT, 8_000),
    maxSteps: maxStepsEnv === '-1' ? -1 : num(maxStepsEnv, 24),
    // P6.1 caps: RINGZERO_COST_CAP (USD, may be fractional) and
    // RINGZERO_TOKEN_CAP (cumulative tokens) — 0/unset/negative = no cap.
    costCap: num(process.env.RINGZERO_COST_CAP, 0) || undefined,
    tokenCap: num(process.env.RINGZERO_TOKEN_CAP, 0) || undefined,
    systemPrompt,
    favoriteModels: favoriteModels.length ? favoriteModels : [env.model],
    verifyCommand: process.env.RINGZERO_VERIFY || undefined,
    permissions: {
      read_file: 'allow',
      grep: 'allow',
      glob: 'allow',
      web_fetch: 'allow',
      list_dir: 'allow',
      tree: 'allow',
      git_log: 'allow',
      web_search: 'allow',
      http_request: 'ask',
      write_file: 'ask',
      edit_file: 'ask',
      bash: 'ask',
      git_commit: 'ask',
    },
  };
}
