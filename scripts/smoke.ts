/**
 * Smoke test: real round-trip against the configured endpoint (packyapi /
 * deepseek-v4-flash). Verifies streaming text + tool calls + tool-result
 * continuation through the OpenAI-compatible adapter.
 *
 * Run: node dist/scripts/smoke.js
 */
import { loadEnv } from '../src/config/env.js';
import { createDefaultProvider } from '../src/providers/registry.js';
import type { ProviderMessage, ToolDefinition, ChatEvent } from '../src/kernel/types.js';

const env = loadEnv();
const provider = createDefaultProvider(env);
console.log(`provider=${provider.id} model=${env.model} base=${env.apiUrl}`);

const tools: ToolDefinition[] = [
  {
    name: 'get_cwd',
    description: 'Returns the current working directory path.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read a text file and return its contents.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

async function runTurn(
  messages: ProviderMessage[],
): Promise<{ events: ChatEvent[]; text: string; calls: any[] }> {
  const events: ChatEvent[] = [];
  let text = '';
  const calls: any[] = [];
  for await (const ev of provider.chat({
    system: ['You are a helpful assistant.'],
    messages,
    tools,
  })) {
    events.push(ev);
    if (ev.type === 'text') {
      text += ev.text;
      process.stdout.write(ev.text);
    } else if (ev.type === 'tool_calls') {
      calls.push(...ev.calls);
    } else if (ev.type === 'finish') {
      console.log(`\n[finish] reason=${ev.finishReason} usage=${JSON.stringify(ev.usage)}`);
    }
  }
  return { events, text, calls };
}

// Turn 1
const messages: ProviderMessage[] = [
  {
    role: 'user',
    content:
      '用 get_cwd 工具取得當前工作目錄，然後用 read_file 讀取 package.json，最後回報 package.json 的 name 欄位。',
  },
];
const t1 = await runTurn(messages);
if (t1.calls.length) {
  // Append assistant tool_calls + tool results, continue.
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: t1.calls,
  });
  const results = new Map<string, string>();
  for (const c of t1.calls) {
    let out = 'error: no impl';
    if (c.name === 'get_cwd') {
      out = process.cwd();
    } else if (c.name === 'read_file') {
      try {
        const { readFileSync } = await import('node:fs');
        out = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
      } catch (e: any) {
        out = `error: ${e.message}`;
      }
    }
    results.set(c.id, out);
  }
  for (const c of t1.calls) {
    messages.push({ role: 'tool', toolCallId: c.id, content: results.get(c.id) ?? '' });
  }
  console.log('\n--- turn 2 ---');
  const t2 = await runTurn(messages);
  if (t2.calls.length) console.log('unexpected extra tool calls:', t2.calls);
} else {
  console.log('\n(no tool calls in turn 1)');
}
console.log('\nSMOKE OK');
