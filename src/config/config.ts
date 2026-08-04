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
  systemPrompt: string[];
  favoriteModels: string[];
  permissions: Record<string, PermissionRule>;
  /** Optional shell command run after write/edit tools (RINGZERO_VERIFY). */
  verifyCommand?: string;
}

const DEFAULT_SYSTEM = `You are RingZero, a minimal, token-efficient coding agent.
Rules:
- Use tools to inspect, search, and edit the project. Prefer edit_file over write_file to save tokens.
- Work step by step; verify results (build/tests) when relevant.
- Be concise. Answer in the user's language. When done, give a short summary.`;

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

export function loadConfig(): AppConfig {
  const env = loadEnv();
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

  const systemPrompt: string[] = [
    DEFAULT_SYSTEM,
    // Date injection (separate block so Anthropic keeps the static rules cached
    // even as the date rolls; the model uses it for commit messages/date math).
    `Today: ${new Date().toISOString().slice(0, 10)} (UTC). Use this for commit messages, timestamps, and date math.`,
  ];
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
    maxSteps: num(process.env.RINGZERO_MAX_STEPS, 24),
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
