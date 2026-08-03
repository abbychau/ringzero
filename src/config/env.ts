import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment config. Loads .env from cwd (then user home) without overriding
 * existing process.env vars (so real env vars take precedence). Never logs the key.
 */
export interface Env {
  apiUrl: string;
  apiKey: string;
  model: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
}

export function loadDotEnv(dir: string): void {
  const p = join(dir, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    if (key in process.env) continue;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

export function loadEnv(cwd = process.cwd()): Env {
  loadDotEnv(cwd);
  loadDotEnv(homedir());
  return {
    apiUrl: process.env.API_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.API_KEY ?? '',
    model: process.env.MODEL ?? 'gpt-4o-mini',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL,
  };
}
