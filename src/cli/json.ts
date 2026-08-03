import type { AppConfig } from '../config/config.js';
import type { ImageInput } from '../kernel/types.js';
import { Runner } from './runner.js';

export interface OneShotOptions {
  resume?: string;
  yes?: boolean;
  model?: string;
  json?: boolean;
  images?: ImageInput[];
}

/** One-shot (or --json) run. In scripted mode asks default to deny unless --yes. */
export async function runOneShot(
  config: AppConfig,
  prompt: string,
  opts: OneShotOptions = {},
): Promise<void> {
  const runner = new Runner(config, {
    sessionId: opts.resume,
    model: opts.model,
    ask: opts.yes ? async () => 'yes' as const : async () => 'no' as const,
  });
  runner.ensureSession(prompt.slice(0, 40));
  const sessionId = runner.sessionId!;
  await runner.init();
  const agent = runner.agent();

  for await (const ev of agent.run(prompt, { images: opts.images })) {
    if (opts.json) {
      console.log(JSON.stringify({ sessionId, ...ev }));
    } else if (ev.type === 'text') {
      process.stdout.write(ev.text);
    } else if (ev.type === 'tool_start') {
      process.stdout.write(`\n[tool ${ev.name}]\n`);
    } else if (ev.type === 'tool_result') {
      process.stdout.write(`\n[tool ${ev.name} done${ev.truncated ? ' (truncated)' : ''}]\n`);
    } else if (ev.type === 'permission' && !ev.allowed) {
      process.stdout.write(`\n[permission denied: ${ev.name}]\n`);
    } else if (ev.type === 'compacting') {
      process.stdout.write('\n[compacting context…]\n');
    } else if (ev.type === 'finish') {
      process.stdout.write(
        `\n[finish steps=${ev.steps} usage=${JSON.stringify(ev.usage)} session=${sessionId}]\n`,
      );
    }
  }
}
