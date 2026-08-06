import type { Provider } from '../kernel/types.js';
import type { Env } from '../config/env.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';

/** Positive env var (ms) or fallback; used for request timeouts. */
function ms(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Pick the default provider from env (first match wins):
 *  - Anthropic key AND no OpenAI-compatible URL → Anthropic.
 *  - Gemini key AND no OpenAI-compatible URL → Gemini.
 *  - Otherwise → OpenAI-compatible (covers packyapi, Ollama, LM Studio,
 *    OpenRouter, MiniMax...). API_URL always wins over vendor keys.
 */
export function createDefaultProvider(env: Env): Provider {
  if (env.anthropicApiKey && !env.apiUrl) {
    return createAnthropicProvider({
      id: 'anthropic',
      apiKey: env.anthropicApiKey,
      model: env.anthropicModel ?? 'claude-sonnet-4-5',
      cacheControl: true,
      effort: env.effort,
      retries: Number(process.env.RINGZERO_RETRIES) || 2,
    });
  }
  if (env.geminiApiKey && !env.apiUrl) {
    return createGeminiProvider({
      id: 'gemini',
      apiKey: env.geminiApiKey,
      model: env.model,
      effort: env.effort,
      retries: Number(process.env.RINGZERO_RETRIES) || 2,
    });
  }
  return createOpenAICompatProvider({
    id: 'openai-compat',
    baseURL: env.apiUrl,
    apiKey: env.apiKey,
    model: env.model,
    effort: env.effort,
    retries: Number(process.env.RINGZERO_RETRIES) || 2,
    // Timeouts turn a hung connect / stalled stream into a visible error
    // instead of an endless spinner (RINGZERO_TIMEOUT_MS / RINGZERO_IDLE_TIMEOUT_MS).
    timeoutMs: ms(process.env.RINGZERO_TIMEOUT_MS, 300_000),
    idleTimeoutMs: ms(process.env.RINGZERO_IDLE_TIMEOUT_MS, 120_000),
  });
}
