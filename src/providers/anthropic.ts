import type {
  ChatRequest,
  ChatEvent,
  Provider,
  ProviderMessage,
  TokenUsage,
  ToolCall,
} from '../kernel/types.js';
import { countTokens } from '../kernel/tokenizer.js';
import { consumeSSE } from './streaming.js';
import { fetchWithRetry } from './retry.js';
import { log } from '../util/log.js';

export interface AnthropicConfig {
  id: string;
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Inject cache_control breakpoints (Anthropic prompt caching). */
  cacheControl?: boolean;
  /** Transient-failure retries (429/5xx/network). Default 2. */
  retries?: number;
}

const DEFAULT_BASE = 'https://api.anthropic.com/v1';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicContentBlock {
  type?: string;
  id?: string;
  name?: string;
}

/** One SSE data line of an Anthropic Messages stream. */
interface AnthropicEvent {
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
}

function toAnthropicMessages(msgs: ProviderMessage[], cacheControl = false): unknown[] {
  const out: unknown[] = [];
  let lastUserIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role === 'user') lastUserIdx = i;
  }
  msgs.forEach((m, idx) => {
    if (m.role === 'user') {
      const block: Record<string, unknown> = { type: 'text', text: m.content };
      if (cacheControl && idx === lastUserIdx) block.cache_control = { type: 'ephemeral' };
      out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: safeParse(tc.args),
        });
      }
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      });
    }
  });
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function createAnthropicProvider(cfg: AnthropicConfig): Provider {
  return {
    id: cfg.id,
    countTokens: (t: string) => countTokens(t),
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
      const baseURL = (cfg.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
      const systemBlocks = (req.system ?? []).map((s, i) => {
        const block: Record<string, unknown> = { type: 'text', text: s };
        if (cfg.cacheControl && i === 0) block.cache_control = { type: 'ephemeral' };
        return block;
      });
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: req.maxTokens ?? 8192,
        messages: toAnthropicMessages(req.messages, cfg.cacheControl === true),
        stream: true,
      };
      if (systemBlocks.length) body.system = systemBlocks;
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }));
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;

      const res = await fetchWithRetry(
        `${baseURL}/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: req.signal,
        },
        { retries: cfg.retries, signal: req.signal },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
        );
      }
      if (!res.body) throw new Error('No response body');

      let usage: TokenUsage | undefined;
      let finishReason: string | undefined;
      // Accumulated content blocks by stream index.
      const blocks = new Map<
        number,
        | { type: 'tool_use'; id: string; name: string; args: string }
        | { type: 'text'; text: string }
      >();

      for await (const ev of consumeSSE(res.body, req.signal)) {
        let json: AnthropicEvent | undefined;
        try {
          json = JSON.parse(ev.data) as AnthropicEvent;
        } catch {
          continue;
        }
        switch (ev.event) {
          case 'message_start': {
            const u = json.message?.usage;
            if (u) {
              usage = {
                input: u.input_tokens ?? 0,
                output: u.output_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens,
                cacheWrite: u.cache_creation_input_tokens,
              };
            }
            break;
          }
          case 'content_block_start': {
            const idx = json.index;
            if (idx === undefined) break;
            const cb = json.content_block;
            if (cb?.type === 'tool_use') {
              blocks.set(idx, { type: 'tool_use', id: cb.id ?? '', name: cb.name ?? '', args: '' });
            } else {
              blocks.set(idx, { type: 'text', text: '' });
            }
            break;
          }
          case 'content_block_delta': {
            const idx = json.index;
            if (idx === undefined) break;
            const b = blocks.get(idx);
            if (!b) break;
            if (json.delta?.type === 'text_delta') {
              if (b.type === 'text') {
                b.text += json.delta.text;
                yield { type: 'text', text: json.delta.text ?? '' };
              }
            } else if (json.delta?.type === 'input_json_delta') {
              if (b.type === 'tool_use') b.args += json.delta.partial_json ?? '';
            }
            break;
          }
          case 'message_delta': {
            finishReason = json.delta?.stop_reason;
            if (json.usage?.output_tokens) {
              usage = { ...usage, output: json.usage.output_tokens } as TokenUsage;
            }
            break;
          }
        }
      }

      const calls: ToolCall[] = [];
      for (const b of blocks.values()) {
        if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: b.args });
      }
      if (calls.length) yield { type: 'tool_calls', calls };
      log('anthropic', cfg.model, 'finish', finishReason, usage ?? {});
      yield { type: 'finish', usage, finishReason };
    },
  };
}
