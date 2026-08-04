import type {
  ChatRequest,
  ChatEvent,
  Provider,
  ProviderMessage,
  TokenUsage,
  ToolCall,
} from '../kernel/types.js';
import { countTokens } from '../kernel/tokenizer.js';
import { fetchWithRetry } from './retry.js';
import { log } from '../util/log.js';
import type { EffortLevel } from './effort.js';

export interface OpenAICompatConfig {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** Reasoning effort sent as `reasoning_effort` (low/medium/high). */
  effort?: EffortLevel;
  /** Override the HTTP error message for auth failures (surfaced to user). */
  headers?: Record<string, string>;
  /** Transient-failure retries (429/5xx/network). Default 2. */
  retries?: number;
}

interface ChatChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
}

interface ToolCallDelta {
  index?: number;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null };
}

interface ChatChunkDelta {
  content?: string | null;
  /** Reasoning models (DeepSeek, o-series…) stream thinking here. */
  reasoning_content?: string | null;
  tool_calls?: ToolCallDelta[];
}

interface ChatChunkChoice {
  finish_reason?: string | null;
  delta?: ChatChunkDelta;
}

/** One SSE data line of a chat.completions streaming response. */
interface ChatChunk {
  usage?: ChatChunkUsage;
  choices?: ChatChunkChoice[];
}

/** Convert provider-agnostic messages to OpenAI chat-completions shape. */
export function toOpenAIMessages(msgs: ProviderMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of msgs) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      if (m.images?.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: m.content },
            ...m.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.data}` },
            })),
          ],
        });
      } else {
        out.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc: ToolCall) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

export function createOpenAICompatProvider(cfg: OpenAICompatConfig): Provider {
  return {
    id: cfg.id,
    countTokens: (t: string) => countTokens(t),
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
      const baseURL = cfg.baseURL.replace(/\/+$/, '');
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: toOpenAIMessages([
          ...(req.system ?? []).map((s): ProviderMessage => ({ role: 'system', content: s })),
          ...req.messages,
        ]),
        stream: true,
      };
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      }
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (cfg.effort) body.reasoning_effort = cfg.effort;

      const res = await fetchWithRetry(
        `${baseURL}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
            ...cfg.headers,
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

      // Dynamically import to avoid a hard circular dependency at module scope.
      const { consumeSSE } = await import('./streaming.js');

      let usage: TokenUsage | undefined;
      let finishReason: string | undefined;
      const pending = new Map<number, ToolCall>();

      for await (const ev of consumeSSE(res.body, req.signal)) {
        let chunk: ChatChunk | undefined;
        try {
          chunk = JSON.parse(ev.data) as ChatChunk;
        } catch {
          continue;
        }
        if (chunk.usage) {
          const cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens;
          const cacheWrite = chunk.usage.prompt_tokens_details?.cache_creation_input_tokens;
          usage = {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
            ...(cacheRead !== undefined ? { cacheRead } : {}),
            ...(cacheWrite !== undefined ? { cacheWrite } : {}),
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (delta.content) yield { type: 'text', text: delta.content };
        if (delta.reasoning_content) yield { type: 'thinking', text: delta.reasoning_content };
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = pending.get(idx) ?? { id: tc.id ?? '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            pending.set(idx, cur);
          }
        }
      }

      const calls = [...pending.values()].filter((c) => c.name);
      if (calls.length) yield { type: 'tool_calls', calls };
      log('openai-compat', cfg.model, 'finish', finishReason, usage ?? {});
      yield { type: 'finish', usage, finishReason };
    },
  };
}
