/** Reasoning-effort levels understood by RingZero (EFFORT / RINGZERO_EFFORT). */
export type EffortLevel = 'low' | 'medium' | 'high';

/** Parse an EFFORT env value into a known level; empty/unknown → undefined. */
export function effortLevel(v: string | undefined): EffortLevel | undefined {
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return undefined;
}

/**
 * Map an effort level to a thinking budget in tokens. Used by providers whose
 * API has no reasoning_effort knob (Anthropic `thinking`, Gemini `thinkingConfig`).
 */
export function effortBudgetTokens(effort: EffortLevel | undefined): number | undefined {
  switch (effort) {
    case 'low':
      return 2048;
    case 'medium':
      return 8192;
    case 'high':
      return 16384;
    default:
      return undefined;
  }
}
