import { watch, readdirSync, statSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config/config.js';
import type { TokenUsage } from '../kernel/types.js';
import { Runner } from './runner.js';
import { IGNORE_DIRS } from '../tools/fsutil.js';

/**
 * --watch mode: run the prompt, then re-run it whenever the working directory
 * changes (auto-fix loops, live demos, "keep this green" sessions). Reuses one
 * Runner/session so history accumulates across runs. Directory watching is
 * recursive-by-rebuild: every directory under cwd gets a non-recursive
 * fs.watch, and new subdirectories are picked up on the next rescan.
 */
export async function runWatch(
  config: AppConfig,
  prompt: string,
  opts: { model?: string; yes?: boolean } = {},
): Promise<void> {
  const runner = new Runner(config, {
    model: opts.model,
    ask: opts.yes ? async () => 'yes' as const : async () => 'no' as const,
  });
  runner.pluginSay = (t) => console.log(t);
  await runner.init();

  let running = false;
  let pending = false;
  let debounce: NodeJS.Timeout | undefined;
  const watchers = new Map<string, FSWatcher>();

  const run = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    console.log(`\n── run (${new Date().toLocaleTimeString()}) ──`);
    runner.ensureSession(prompt.slice(0, 40));
    const agent = runner.agent();
    let usage: TokenUsage | undefined;
    try {
      for await (const ev of agent.run(prompt)) {
        if (ev.type === 'text') process.stdout.write(ev.text);
        else if (ev.type === 'tool_start') process.stdout.write(`\n⛏ ${ev.name}\n`);
        else if (ev.type === 'permission' && !ev.allowed)
          process.stdout.write(`[denied: ${ev.name}]\n`);
        else if (ev.type === 'compacting') process.stdout.write('\n[compacting context…]\n');
        else if (ev.type === 'finish') usage = ev.usage;
      }
    } catch (err) {
      process.stdout.write(`\n[error: ${err instanceof Error ? err.message : String(err)}]\n`);
    }
    if (usage) {
      process.stdout.write(
        `\n[usage in=${usage.input} out=${usage.output}${
          usage.cacheRead ? ` cached=${usage.cacheRead}` : ''
        }]\n`,
      );
    }
    running = false;
    if (pending) {
      pending = false;
      void run();
    }
  };

  /** All directories under cwd (skipping dot-dirs and build/ignore dirs). */
  const scanDirs = (): string[] => {
    const dirs: string[] = [];
    const visit = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      dirs.push(dir);
      for (const name of entries) {
        if (name.startsWith('.') || IGNORE_DIRS.has(name)) continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) visit(full);
      }
    };
    visit(config.cwd);
    return dirs;
  };

  const refresh = (): void => {
    const dirs = scanDirs();
    for (const [d, w] of watchers) {
      if (!dirs.includes(d)) {
        w.close();
        watchers.delete(d);
      }
    }
    for (const d of dirs) {
      if (watchers.has(d)) continue;
      try {
        watchers.set(
          d,
          watch(d, { persistent: true }, () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
              refresh();
              void run();
            }, 300);
          }),
        );
      } catch {
        /* dir vanished mid-scan */
      }
    }
  };

  const onExit = (): void => {
    for (const w of watchers.values()) w.close();
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  console.log(`RingZero --watch on ${config.cwd} — Ctrl+C to stop`);
  await run();
  refresh();
  console.log('(watching for changes…)');
}
