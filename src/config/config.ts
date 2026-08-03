import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadEnv, type Env } from './env.js';
import type { PermissionRule } from '../permission/gate.js';

export interface AppConfig {
  env: Env;
  cwd: string;
  home: string;
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
}

const DEFAULT_SYSTEM = `You are RingZero, a minimal, token-efficient coding agent.
Rules:
- Use tools to inspect, search, and edit the project. Prefer edit_file over write_file to save tokens.
- Work step by step; verify results (build/tests) when relevant.
- Be concise. Answer in the user's language. When done, give a short summary.`;

function num(envVar: string | undefined, fallback: number): number {
  const v = Number(envVar);
  return Number.isFinite(v) && v > 0 ? v : fallback;
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
  const workspace = process.env.RINGZERO_WORKSPACE
    ? resolve(process.env.RINGZERO_WORKSPACE)
    : undefined;
  const favoriteModels = (process.env.RINGZERO_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const systemPrompt: string[] = [DEFAULT_SYSTEM];
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
    permissions: {
      read_file: 'allow',
      grep: 'allow',
      glob: 'allow',
      web_fetch: 'allow',
      write_file: 'ask',
      edit_file: 'ask',
      bash: 'ask',
    },
  };
}
