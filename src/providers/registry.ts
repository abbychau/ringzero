import type { Provider } from '../kernel/types.js';
import type { Env } from '../config/env.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';

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
      retries: Number(process.env.RINGZERO_RETRIES) || 2,
    });
  }
  if (env.geminiApiKey && !env.apiUrl) {
    return createGeminiProvider({
      id: 'gemini',
      apiKey: env.geminiApiKey,
      model: env.model,
      retries: Number(process.env.RINGZERO_RETRIES) || 2,
    });
  }
  return createOpenAICompatProvider({
    id: 'openai-compat',
    baseURL: env.apiUrl,
    apiKey: env.apiKey,
    model: env.model,
    retries: Number(process.env.RINGZERO_RETRIES) || 2,
  });
}
