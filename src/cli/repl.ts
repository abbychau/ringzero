import readline from 'node:readline';
import type { AppConfig } from '../config/config.js';
import { Runner } from './runner.js';
import { createDefaultProvider } from '../providers/registry.js';
import type { AskResponse } from '../permission/gate.js';
import type { TokenUsage, ImageInput } from '../kernel/types.js';
import type { Agent } from '../kernel/agent.js';
import { estimateCost, fmtCost } from '../kernel/cost.js';
import { notifyPermission, notifyRunComplete } from './notify.js';

function makeAsk(rl: readline.Interface): (prompt: string) => Promise<AskResponse> {
  return (prompt: string) =>
    new Promise((res) => {
      rl.question(`${prompt}\n[y]es / [n]o / [a]lways / ne[v]er > `, (ans) => {
        const a = ans.trim().toLowerCase();
        if (a.startsWith('y')) res('yes');
        else if (a.startsWith('a')) res('always');
        else if (a.startsWith('v') || a.startsWith('n')) res('never');
        else res('no');
      });
    });
}

function fmtUsage(u?: TokenUsage): string {
  if (!u) return 'no usage data';
  return `in=${u.input} out=${u.output}${u.cacheRead ? ` cached=${u.cacheRead}` : ''}${
    u.cacheWrite ? ` cacheWrite=${u.cacheWrite}` : ''
  }`;
}

export async function runRepl(config: AppConfig, model?: string, resume?: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'ringzero> ',
  });
  const ask = makeAsk(rl);
  const runner = new Runner(config, {
    model,
    sessionId: resume,
    ask: (p) => {
      notifyPermission(p);
      return ask(p);
    },
    promptUser: (p) => {
      notifyPermission(p);
      return new Promise<string | null>((res) => rl.question(`${p}\n> `, (a) => res(a)));
    },
  });
  runner.pluginSay = (t) => console.log(t);
  let lastUsage: TokenUsage | undefined;
  // The agent currently running, or null when idle. Typing while a run is in
  // progress injects the line into the agent instead of starting a second run.
  let runningAgent: Agent | null = null;
  // Image attached via /image; sent with the next message.
  const imageState: { current?: ImageInput } = {};
  const title = 'ringzero session';
  await runner.init();

  console.log(
    `RingZero — model=${runner.model} provider=${createDefaultProvider({ ...config.env, model: runner.model }).id} — /help for commands`,
  );
  rl.prompt();

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (runningAgent) {
      if (line.startsWith('/')) {
        process.stdout.write('(agent is running — / commands wait until it finishes)\n');
      } else {
        runningAgent.inject(line);
        process.stdout.write(
          `[✂ injected mid-run: ${line.slice(0, 80)}${line.length > 80 ? '…' : ''}]\n`,
        );
      }
      rl.prompt();
      return;
    }
    if (line.startsWith('/')) {
      await handleSlash(
        runner,
        rl,
        line,
        () => lastUsage,
        (u) => (lastUsage = u),
        imageState,
      );
      rl.prompt();
      return;
    }
    runner.ensureSession(title);
    const agent = runner.agent();
    runningAgent = agent;
    let usage: TokenUsage | undefined;
    const t0 = performance.now();
    try {
      for await (const ev of agent.run(line, {
        images: imageState.current ? [imageState.current] : undefined,
      })) {
        if (ev.type === 'text') process.stdout.write(ev.text);
        else if (ev.type === 'tool_start') process.stdout.write(`\n⛏ ${ev.name}\n`);
        else if (ev.type === 'permission' && !ev.allowed)
          process.stdout.write(`[denied: ${ev.name}]\n`);
        else if (ev.type === 'compacting') process.stdout.write('\n[compacting context…]\n');
        else if (ev.type === 'injected') process.stdout.write(`\n[✂ injected: ${ev.text}]\n`);
        else if (ev.type === 'finish') usage = ev.usage;
      }
    } catch (err) {
      process.stdout.write(`\n[error: ${err instanceof Error ? err.message : String(err)}]\n`);
    }
    runningAgent = null;
    imageState.current = undefined;
    lastUsage = usage;
    if (usage)
      process.stdout.write(
        `\n[usage ${fmtUsage(usage)} ≈${fmtCost(estimateCost(runner.model, usage))}]\n`,
      );
    notifyRunComplete(Math.round((performance.now() - t0) / 1000));
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

async function handleSlash(
  runner: Runner,
  rl: readline.Interface,
  line: string,
  getUsage: () => TokenUsage | undefined,
  setUsage: (u: TokenUsage) => void,
  imageState: { current?: ImageInput },
): Promise<void> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case 'help':
      console.log(
        'commands: /help  /usage  /model <id>  /compact  /permission <tool> <allow|ask|deny>  /skills [name]  /sessions  /resume <id>  /diff  /status  /commit <msg>  /checkpoint  /rollback  /plan [on|off]  /todos  /image <path>  /new  /exit',
      );
      break;
    case 'usage': {
      const u = getUsage();
      console.log(
        u
          ? `usage: ${fmtUsage(u)} ≈${fmtCost(estimateCost(runner.model, u))}`
          : 'usage: no usage data',
      );
      break;
    }
    case 'compact': {
      const res = await runner.compact();
      if (!res) console.log('(nothing to compact)');
      else
        console.log(
          `compact: ${res.replaced} msg(s) → summary · ${res.before} → ${res.after} tokens`,
        );
      break;
    }
    case 'model': {
      if (rest[0]) {
        runner.setModel(rest[0]);
        console.log(`model → ${rest[0]}`);
      } else {
        console.log(`model = ${runner.model}`);
      }
      break;
    }
    case 'permission': {
      if (rest.length === 2 && ['allow', 'ask', 'deny'].includes(rest[1]!)) {
        runner.gate.setOverride(rest[0]!, rest[1] as 'allow' | 'ask' | 'deny');
        console.log(`${rest[0]} → ${rest[1]}`);
      } else {
        console.log('usage: /permission <tool> <allow|ask|deny>');
      }
      break;
    }
    case 'tools':
      console.log(
        runner
          .agent()
          .toolDefs.map((t) => t.name)
          .join(', '),
      );
      break;
    case 'skills': {
      if (rest[0]) {
        if (rest[0] === 'off' && rest[1]) {
          runner.disableSkill(rest[1]);
          console.log(`skill disabled: ${rest[1]}`);
        } else if (await runner.enableSkill(rest[0])) {
          console.log(`skill enabled: ${rest[0]}`);
        } else {
          console.log(`skill not found: ${rest[0]}`);
        }
      } else {
        const all = runner.listSkills();
        console.log(
          all.length
            ? all
                .map((s) => `${s.name} — ${s.description}${runner.hasSkill(s.name) ? ' [on]' : ''}`)
                .join('\n')
            : '(no skills found — create <dir>/skills/<name>/SKILL.md)',
        );
      }
      break;
    }
    case 'sessions': {
      const list = runner.listSessions();
      if (!list.length) {
        console.log('(no sessions)');
        break;
      }
      for (const s of list.slice(0, 20)) {
        const when = new Date(s.updated).toISOString().slice(0, 19).replace('T', ' ');
        console.log(`${s.id}  ${when}  ${s.title}`);
      }
      break;
    }
    case 'resume': {
      if (rest[0] && runner.resume(rest[0])) {
        console.log(`resumed session ${rest[0]}`);
      } else {
        console.log('usage: /resume <sessionId>  (see /sessions)');
      }
      break;
    }
    case 'new':
      runner.reset();
      console.log('new session');
      break;
    case 'exit':
      rl.close();
      break;
    case 'diff':
      console.log(runner.gitDiff().slice(0, 2000) || '(no changes)');
      break;
    case 'status':
      console.log(runner.gitStatus());
      break;
    case 'commit': {
      const msg = rest.join(' ').trim();
      if (!msg) {
        console.log('usage: /commit <message>');
        break;
      }
      console.log(runner.gitCommit(msg));
      break;
    }
    case 'checkpoint': {
      const sha = runner.checkpoint();
      console.log(
        sha ? `checkpoint saved (${sha.slice(0, 8)})` : '(no session or no changes to snapshot)',
      );
      break;
    }
    case 'rollback': {
      const sha = runner.rollback();
      console.log(sha ? `rolled back to ${sha.slice(0, 8)}` : '(no checkpoints for this session)');
      break;
    }
    case 'plan': {
      const arg = rest[0];
      const on = arg === undefined ? !runner.isPlanMode() : arg === 'on';
      if (arg !== undefined && arg !== 'on' && arg !== 'off') {
        console.log('usage: /plan [on|off]');
        break;
      }
      runner.setPlanMode(on);
      console.log(`plan mode ${on ? 'ON' : 'OFF'}`);
      break;
    }
    case 'todos': {
      const todos = runner.listTodos();
      console.log(
        todos.length
          ? todos.map((t, i) => `${i + 1}. ${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n')
          : '(no todos)',
      );
      break;
    }
    case 'image': {
      const path = rest[0];
      if (!path) {
        console.log('usage: /image <path>  (attaches to your next message)');
        break;
      }
      try {
        const { loadImage } = await import('../util/image.js');
        imageState.current = loadImage(path);
        console.log(`image attached: ${path} (sent with your next message)`);
      } catch (e) {
        console.log(`image error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
    case 'export': {
      const res = runner.exportSession(undefined, rest[0]);
      console.log(res.path ? `exported to ${res.path}` : `export error: ${res.error}`);
      break;
    }
    default:
      if (cmd && (await runner.runPluginCommand(cmd, rest))) break;
      console.log(`unknown command: /${cmd}`);
  }
  void setUsage;
}
