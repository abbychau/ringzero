#!/usr/bin/env node
import { loadConfig } from '../config/config.js';
import { runRepl } from './repl.js';
import { runOneShot } from './json.js';

const HELP = `RingZero — minimal token-efficient agent harness

Usage:
  ringzero                      interactive TUI
  ringzero --repl               line-based REPL (fallback if no TTY)
  ringzero "prompt"             one-shot run
  ringzero --json "prompt"      one-shot, NDJSON event stream
  ringzero --resume <id> "..."  continue a session
  ringzero --sessions           list saved sessions
  ringzero --continue           resume the most recent session
  ringzero --rpc                JSON-RPC mode over stdin/stdout (SDK)
  ringzero --model <id> "..."   override model
  ringzero --yes "..."          auto-allow all tools (scripted mode)
  ringzero --version            print version

TUI keys: Enter submit · ↑/↓ history · PgUp/PgDn scroll · Ctrl+C abort/exit
Env (.env or environment):
  API_URL, API_KEY, MODEL          OpenAI-compatible endpoint (packyapi etc.)
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL   Anthropic (used when API_URL is empty)
  RINGZERO_CONTEXT_BUDGET          context budget for compaction (default 32000)
  RINGZERO_PRESERVE_RECENT         tail tokens kept verbatim across compaction
`;

function printHelp(): void {
  console.log(HELP);
}

const args = process.argv.slice(2);
let json = false;
let yes = false;
let resume: string | undefined;
let model: string | undefined;
let listSessions = false;
let version = false;
let cont = false;
let rpc = false;
let tui = true;
const positionals: string[] = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--json') json = true;
  else if (a === '--yes' || a === '-y') yes = true;
  else if (a === '--resume' || a === '-c') resume = args[++i];
  else if (a === '--model') model = args[++i];
  else if (a === '--sessions') listSessions = true;
  else if (a === '--continue') cont = true;
  else if (a === '--rpc') rpc = true;
  else if (a === '--verbose') process.env.RINGZERO_VERBOSE = '1';
  else if (a === '--version' || a === '-v') version = true;
  else if (a === '--repl') tui = false;
  else if (a === '--tui') tui = true;
  else if (a === '--help' || a === '-h') {
    printHelp();
    process.exit(0);
  } else if (a.startsWith('-')) {
    console.error(`unknown flag: ${a}`);
    printHelp();
    process.exit(1);
  } else {
    positionals.push(a);
  }
}

const config = loadConfig();

if (cont && !resume) {
  const { SessionStore } = await import('../session/store.js');
  resume = new SessionStore(config.sessionsDir).list()[0]?.id;
}

if (version) {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  console.log(`ringzero ${pkg.version ?? '0.0.0'}`);
  process.exit(0);
}

if (listSessions) {
  const { SessionStore } = await import('../session/store.js');
  const store = new SessionStore(config.sessionsDir);
  const list = store.list();
  if (!list.length) {
    console.log('(no sessions)');
  } else {
    for (const s of list.slice(0, 20)) {
      const when = new Date(s.updated).toISOString().slice(0, 19).replace('T', ' ');
      console.log(`${s.id}  ${when}  ${s.title}`);
    }
  }
  process.exit(0);
}

const prompt = positionals.join(' ');

try {
  if (prompt) {
    await runOneShot(config, prompt, { resume, yes, model, json });
  } else if (rpc) {
    const { runRpc } = await import('./rpc.js');
    await runRpc(config, { model });
  } else if (tui && process.stdin.isTTY && process.stdout.isTTY) {
    const { runTui } = await import('../tui/app.js');
    await runTui(config, model, resume);
  } else {
    await runRepl(config, model, resume);
  }
} catch (e) {
  console.error(`\n[error] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
