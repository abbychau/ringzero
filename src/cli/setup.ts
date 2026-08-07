import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

/**
 * First-run setup wizard. Runs when no API key is configured: guides the user
 * through setting up .env (API URL / key / model) and, when they confirm they
 * use DeepSeek, applies the recommended tuning (EFFORT=max, CONTEXT_BUDGET,
 * MAX_STEPS, YOLO=1) automatically.
 */

/** Set `key=value` in .env lines, replacing the first uncommented `key=` line. */
export function setEnvKey(lines: string[], key: string, value: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l) && !l.trim().startsWith('#'));
  const line = `${key}=${value}`;
  if (idx >= 0) {
    const out = lines.slice();
    out[idx] = line;
    return out;
  }
  return [...lines, line];
}

/** Read a .env file as lines (empty array if missing). */
export function readEnvLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/);
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

async function askRequired(rl: readline.Interface, q: string, label: string): Promise<string> {
  for (;;) {
    const v = await ask(rl, q);
    if (v) return v;
    console.log(`  ${label} cannot be empty — please paste your API key.`);
  }
}

async function askYes(rl: readline.Interface, q: string): Promise<boolean> {
  const v = (await ask(rl, `${q} [y/N] `)).toLowerCase();
  return v === 'y' || v === 'yes';
}

/** Run the interactive first-run setup, writing ~/.ringzero/.env. Returns true if anything was written. */
export async function runSetup(ringzeroHome: string): Promise<boolean> {
  console.log('');
  console.log('No API key found — RingZero needs an LLM API to run.');
  console.log("Let's configure your provider in ~/.ringzero/.env (one time).");
  console.log('You can change these later there or via environment variables.');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const isDeepSeek = await askYes(rl, 'Are you using DeepSeek models?');

    const defaultUrl = isDeepSeek ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
    const defaultModel = isDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini';
    const apiUrl = await ask(rl, `API URL [${defaultUrl}] > `);
    const apiKey = await askRequired(rl, 'API key > ', 'API key');
    const model = await ask(rl, `Model [${defaultModel}] > `);

    const sets: Array<[string, string]> = [
      ['API_URL', apiUrl || defaultUrl],
      ['API_KEY', apiKey],
      ['MODEL', model || defaultModel],
    ];
    if (isDeepSeek) {
      // Recommended DeepSeek tuning, applied automatically.
      sets.push(
        ['EFFORT', 'max'],
        ['CONTEXT_BUDGET', '1000000'],
        ['MAX_STEPS', '100'],
        ['YOLO', '1'],
      );
    }

    const envPath = join(ringzeroHome, '.env');
    mkdirSync(ringzeroHome, { recursive: true });
    let lines = readEnvLines(envPath);
    for (const [k, v] of sets) lines = setEnvKey(lines, k, v);
    writeFileSync(envPath, lines.join('\n').replace(/\n+$/, '') + '\n');

    console.log('');
    console.log(`Saved to ${envPath}:`);
    for (const [k] of sets) {
      const re = new RegExp(`^\\s*${k}\\s*=\\s*(.*)$`);
      const line = lines.find((l) => re.test(l) && !l.trim().startsWith('#'));
      const val = line ? line.replace(re, '$1') : '';
      const shown = k === 'API_KEY' ? (val ? '••••••••' : '(empty)') : val;
      console.log(`  ${k}=${shown}`);
    }
    if (isDeepSeek) {
      console.log('');
      console.log(
        'DeepSeek recommended settings applied: EFFORT=max, CONTEXT_BUDGET=1000000, MAX_STEPS=100, YOLO=1',
      );
    }
    console.log('');
    console.log('Done. Re-run `ringzero` to start.');
    return true;
  } finally {
    rl.close();
  }
}
