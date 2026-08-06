import type { AppConfig } from '../config/config.js';
import type { ImageInput } from '../kernel/types.js';
import { Runner } from './runner.js';
import { notifyRunComplete } from './notify.js';

export interface OneShotOptions {
  resume?: string;
  yes?: boolean;
  yolo?: boolean;
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
    yolo: opts.yolo,
    ask: opts.yes ? async () => 'yes' as const : async () => 'no' as const,
  });
  runner.ensureSession(prompt.slice(0, 40));
  const sessionId = runner.sessionId!;
  await runner.init();
  const agent = runner.agent();
  const t0 = performance.now();

  // In --json mode the stream is intended for machine consumers (parsing the
  // finish event for usage/steps/reason). To keep stdout bounded in constrained
  // sandboxes we:
  //  - coalesce consecutive thinking deltas into a single event (the provider
  //    streams reasoning incrementally, one tiny chunk at a time);
  //  - cap the size of each event's text-ish fields (thinking/tool output),
  //    since a single tool call (e.g. primer3) can emit hundreds of KB.
  const MAX_JSON_FIELD = 4096;
  const cap = (s: string | undefined): string | undefined =>
    s && s.length > MAX_JSON_FIELD ? `${s.slice(0, MAX_JSON_FIELD)}\n…[truncated]` : s;

  let thinkingBuf = '';
  const flushThinking = (): void => {
    if (thinkingBuf) {
      console.log(JSON.stringify({ sessionId, type: 'thinking', text: cap(thinkingBuf) }));
      thinkingBuf = '';
    }
  };

  for await (const ev of agent.run(prompt, { images: opts.images })) {
    if (opts.json) {
      if (ev.type === 'thinking') {
        thinkingBuf += ev.text;
        continue;
      }
      flushThinking();
      if (ev.type === 'tool_result' && ev.output) {
        console.log(
          JSON.stringify({
            sessionId,
            type: 'tool_result',
            name: ev.name,
            output: cap(ev.output),
            truncated: ev.truncated,
          }),
        );
        continue;
      }
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
        `\n[finish steps=${ev.steps} reason=${ev.reason} usage=${JSON.stringify(ev.usage)} session=${sessionId}]\n`,
      );
    }
  }
  flushThinking();
  notifyRunComplete(Math.round((performance.now() - t0) / 1000));
}
