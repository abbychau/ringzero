/**
 * Zero-dep cost estimation (USD) for the token dashboard.
 *
 * Prices are approximate list rates per 1M tokens — tune this table to your
 * provider's current pricing; unknown models fall back to a conservative
 * default. The estimate is a guide, not a bill.
 */
import type { TokenUsage } from './types.js';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens (usually much cheaper). */
  cacheRead: number;
}

/** Approximate list prices (USD / 1M tokens), matched by model-name prefix. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.014 },
  'deepseek-chat': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'claude-sonnet': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku': { input: 1, output: 5, cacheRead: 0.1 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  gemini: { input: 0.3, output: 2.5, cacheRead: 0.03 },
  qwen: { input: 0.3, output: 1.2, cacheRead: 0.03 },
  moonshot: { input: 2, output: 12, cacheRead: 0.2 },
  llama: { input: 0, output: 0, cacheRead: 0 }, // local
  ollama: { input: 0, output: 0, cacheRead: 0 }, // local
};

/** Conservative fallback for models not in the table. */
const DEFAULT_PRICE: ModelPrice = { input: 1, output: 3, cacheRead: 0.2 };

/** Longest table key that the (lowercased) model name starts with. */
export function priceFor(model: string): ModelPrice {
  const m = model.toLowerCase();
  let best: { key: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (m.startsWith(key) && (!best || key.length > best.key.length)) best = { key, price };
  }
  return best?.price ?? DEFAULT_PRICE;
}

/** Estimated USD cost of a usage snapshot. */
export function estimateCost(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  // cacheWrite is billed like cacheRead (close enough for an estimate).
  const total =
    u.input * p.input +
    u.output * p.output +
    (u.cacheRead ?? 0) * p.cacheRead +
    (u.cacheWrite ?? 0) * p.cacheRead;
  return total / 1_000_000;
}

/** Cache hit rate: cached input tokens / total input tokens (0..1). */
export function cacheHitRate(u: TokenUsage): number {
  const cached = u.cacheRead ?? 0;
  const total = u.input + cached;
  return total > 0 ? cached / total : 0;
}

/** Compact currency formatting for small dollar amounts. */
export function fmtCost(cost: number): string {
  if (cost <= 0) return '$0';
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
