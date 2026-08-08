import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effortLevel, type EffortLevel } from '../providers/effort.js';

/**
 * Environment config. Loads .env from ~/.ringzero/.env (user-level settings)
 * and, when an explicit env file is given (CLI `--env <path>`), from that file
 * too — WITHOUT overriding existing process.env vars (so real env vars always
 * win). Never logs the key.
 *
 * Working-directory .env files are intentionally NOT loaded: a foreign .env
 * (e.g. another project's `API_KEY=...`) would silently override config or
 * suppress the first-run setup wizard. Opt in explicitly with `--env`.
 */
export interface Env {
  apiUrl: string;
  apiKey: string;
  model: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  geminiApiKey?: string;
  /** Reasoning effort (EFFORT / RINGZERO_EFFORT): low/medium/high/max. */
  effort?: EffortLevel;
  /** Yolo mode (YOLO / RINGZERO_YOLO): auto-allow every permission check. */
  yolo?: boolean;
}

/** Load `<dir>/.env` into process.env. `protected` keys (real env vars) are never overridden. */
export function loadDotEnv(dir: string, protectedKeys?: ReadonlySet<string>): void {
  loadEnvFile(join(dir, '.env'), protectedKeys);
}

/** Load a specific env file into process.env. Missing files are a no-op. */
export function loadEnvFile(file: string, protectedKeys?: ReadonlySet<string>): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    if (protectedKeys?.has(key)) continue;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

/** Truthy env flag: '1' / 'true' / 'yes' / 'on' → true, anything else → false. */
export function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * Load env vars. Priority (lowest → highest): ~/.ringzero/.env → --env file →
 * real env. Real env vars (present before any .env load) are protected and
 * always win over every .env file. `envFile` is an explicit path from the
 * CLI `--env <path>` flag.
 */
export function loadEnv(envFile?: string): Env {
  const ringzeroHome = process.env.RINGZERO_HOME ?? join(homedir(), '.ringzero');
  const realKeys = new Set(Object.keys(process.env));
  loadDotEnv(ringzeroHome, realKeys);
  if (envFile) loadEnvFile(envFile, realKeys);
  return {
    apiUrl: process.env.API_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.API_KEY ?? '',
    model: process.env.MODEL ?? process.env.GEMINI_MODEL ?? 'gpt-4o-mini',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL,
    geminiApiKey: process.env.GEMINI_API_KEY,
    // EFFORT (short, handy in .env) wins over RINGZERO_EFFORT.
    effort: effortLevel(process.env.EFFORT ?? process.env.RINGZERO_EFFORT),
    // YOLO (short) wins over RINGZERO_YOLO; empty string shadows the alias.
    yolo: envBool(process.env.YOLO ?? process.env.RINGZERO_YOLO),
  };
}
