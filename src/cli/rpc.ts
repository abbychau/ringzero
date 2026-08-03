import readline from 'node:readline';
import type { AppConfig } from '../config/config.js';
import type { TokenUsage } from '../kernel/types.js';
import { Runner } from './runner.js';

/**
 * RPC/SDK mode: JSON-RPC 2.0 over stdin/stdout (one JSON object per line).
 * Requests are processed serially. Responses always include `id`.
 *
 * Methods:
 *   initialize                        → { protocol, model }
 *   ping                              → {}
 *   model/get | model/set {model}     → { model }
 *   sessions/list                     → [{ id, title, updated }]
 *   sessions/resume {id}              → { sessionId }
 *   prompt {text}                     → { sessionId, text, usage }  (runs the agent)
 */
export async function runRpc(config: AppConfig, opts: { model?: string } = {}): Promise<void> {
  const runner = new Runner(config, { model: opts.model, ask: async () => 'no' as const });
  await runner.init();
  runner.pluginSay = (t) => console.error(`[plugin] ${t}`);

  const rl = readline.createInterface({ input: process.stdin });
  const send = (o: unknown): void => {
    process.stdout.write(JSON.stringify(o) + '\n');
  };

  let queue: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(() => handle(line).catch((e) => console.error(`[rpc] ${e}`)));
  });

  async function handle(line: string): Promise<void> {
    const msg = parseRequest(line);
    if (!msg) return;
    const reply = (result?: unknown, error?: { code: number; message: string }): void => {
      if (msg.id === undefined) return;
      const o: {
        jsonrpc: '2.0';
        id: number | string;
        result?: unknown;
        error?: { code: number; message: string };
      } = {
        jsonrpc: '2.0',
        id: msg.id,
      };
      if (error) o.error = error;
      else o.result = result;
      send(o);
    };
    try {
      switch (msg.method) {
        case 'initialize':
          reply({ protocol: 'ringzero-rpc@1', model: runner.model });
          break;
        case 'ping':
          reply({});
          break;
        case 'model/get':
          reply({ model: runner.model });
          break;
        case 'model/set':
          if (typeof msg.params?.model === 'string') {
            runner.setModel(msg.params.model);
            reply({ model: runner.model });
          } else {
            reply(undefined, { code: -32602, message: 'model required' });
          }
          break;
        case 'sessions/list':
          reply(
            runner.listSessions().map((s) => ({ id: s.id, title: s.title, updated: s.updated })),
          );
          break;
        case 'sessions/resume':
          if (typeof msg.params?.id === 'string' && runner.resume(msg.params.id)) {
            reply({ sessionId: runner.sessionId });
          } else {
            reply(undefined, { code: 404, message: 'session not found' });
          }
          break;
        case 'prompt': {
          if (typeof msg.params?.text !== 'string') {
            reply(undefined, { code: -32602, message: 'text required' });
            break;
          }
          runner.ensureSession();
          const sessionId = runner.sessionId!;
          const agent = runner.agent();
          let text = '';
          let usage: TokenUsage | undefined;
          for await (const ev of agent.run(msg.params.text)) {
            if (ev.type === 'text') text += ev.text;
            else if (ev.type === 'finish') usage = ev.usage;
          }
          reply({ sessionId, text, usage });
          break;
        }
        default:
          reply(undefined, { code: -32601, message: `unknown method: ${msg.method}` });
      }
    } catch (e) {
      reply(undefined, { code: -32000, message: e instanceof Error ? e.message : String(e) });
    }
  }
}

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function parseRequest(line: string): RpcRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const o = parsed as Partial<RpcRequest>;
  if (typeof o.method !== 'string') return undefined;
  return {
    jsonrpc: o.jsonrpc,
    id: o.id,
    method: o.method,
    params:
      typeof o.params === 'object' && o.params !== null
        ? (o.params as Record<string, unknown>)
        : undefined,
  };
}
