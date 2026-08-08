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
import { effortBudgetTokens, type EffortLevel } from './effort.js';

export interface GeminiConfig {
  id: string;
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Reasoning effort: sets `thinkingConfig` with a mapped token budget. */
  effort?: EffortLevel;
  /** Transient-failure retries (429/5xx/network). Default 2. */
  retries?: number;
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

function safeParseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Convert provider-agnostic messages to Gemini contents.
 * Roles are user/model; assistant tool calls become functionCall parts and
 * tool results become functionResponse parts. Adjacent same-role turns are
 * merged (parallel tool results produce consecutive tool messages).
 */
export function toGeminiMessages(msgs: ProviderMessage[]): unknown[] {
  const nameById = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) nameById.set(tc.id, tc.name);
    }
  }
  const out: { role: string; parts: Record<string, unknown>[] }[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue; // system goes in systemInstruction
    const parts: Record<string, unknown>[] = [];
    if (m.role === 'user') {
      if (m.content) parts.push({ text: m.content });
      for (const img of m.images ?? []) {
        parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
      }
    } else if (m.role === 'assistant') {
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: safeParseArgs(tc.args) } });
      }
    } else if (m.role === 'tool') {
      const name = m.toolCallId ? nameById.get(m.toolCallId) : undefined;
      if (name) {
        parts.push({ functionResponse: { name, response: { result: m.content } } });
      } else {
        // Unknown call id: surface the result as text so the model still sees it.
        parts.push({ text: `tool result: ${m.content}` });
      }
    }
    if (parts.length === 0) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      out.push({ role, parts });
    }
  }
  return out;
}

export function createGeminiProvider(cfg: GeminiConfig): Provider {
  return {
    id: cfg.id,
    countTokens: (t: string) => countTokens(t),
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
      const baseURL = (cfg.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: req.maxTokens ?? 8192,
      };
      if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
      const budget = effortBudgetTokens(cfg.effort);
      if (budget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: budget };
      const body: Record<string, unknown> = {
        contents: toGeminiMessages(req.messages),
        generationConfig,
      };
      if (req.system?.length) {
        body.systemInstruction = { parts: req.system.map((s) => ({ text: s })) };
      }
      if (req.tools?.length) {
        body.tools = [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ];
      }

      const res = await fetchWithRetry(
        `${baseURL}/models/${cfg.model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': cfg.apiKey,
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
      // Gemini function calls carry no id; we synthesize one per call so tool
      // results can be matched back by name (see toGeminiMessages).
      const pendingCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];

      for await (const ev of consumeSSE(res.body, req.signal)) {
        let chunk: GeminiChunk | undefined;
        try {
          chunk = JSON.parse(ev.data) as GeminiChunk;
        } catch {
          continue;
        }
        if (chunk.usageMetadata) {
          const cacheRead = chunk.usageMetadata.cachedContentTokenCount;
          // Gemini counts cached tokens inside promptTokenCount; keep input as
          // the FRESH part so cacheHitRate isn't diluted by double-counting.
          const input = Math.max(0, (chunk.usageMetadata.promptTokenCount ?? 0) - (cacheRead ?? 0));
          usage = {
            input,
            output: chunk.usageMetadata.candidatesTokenCount ?? 0,
            ...(cacheRead && cacheRead > 0 ? { cacheRead } : {}),
          };
        }
        const cand = chunk.candidates?.[0];
        if (!cand) continue;
        if (cand.finishReason) finishReason = cand.finishReason;
        for (const part of cand.content?.parts ?? []) {
          if (part.thought) {
            if (part.text) yield { type: 'thinking', text: part.text };
          } else if (part.text) {
            yield { type: 'text', text: part.text };
          } else if (part.functionCall) {
            const name = part.functionCall.name ?? '';
            pendingCalls.push({
              id: name || `call-${pendingCalls.length}`,
              name,
              args: part.functionCall.args ?? {},
            });
          }
        }
      }

      const calls: ToolCall[] = pendingCalls.map((c) => ({
        id: c.id,
        name: c.name,
        args: JSON.stringify(c.args),
      }));
      if (calls.length) yield { type: 'tool_calls', calls };
      log('gemini', cfg.model, 'finish', finishReason, usage ?? {});
      yield { type: 'finish', usage, finishReason };
    },
  };
}
