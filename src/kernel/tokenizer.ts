/**
 * Zero-dependency CJK-aware token estimator.
 *
 * Heuristic used ONLY for pre-send budgeting (compaction thresholds, context
 * pressure). The provider-reported `usage` is always the source of truth for
 * actual accounting.
 *
 *   ASCII          ≈ 1 token per 4 chars
 *   CJK (漢字/かな/한글/全形) ≈ 1 token per char (tunable)
 */

const CJK_CHAR =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u3000-\u303F\uFF00-\uFFEF]/u;

export interface TokenizerOptions {
  /** Average chars per token for non-CJK text. Default 4. */
  asciiCharsPerToken?: number;
  /** Average chars per token for CJK text. Default 1. */
  cjkCharsPerToken?: number;
}

export function countTokens(text: string, opts: TokenizerOptions = {}): number {
  const asciiPer = opts.asciiCharsPerToken ?? 4;
  const cjkPer = opts.cjkCharsPerToken ?? 1;
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjk++;
    else ascii++;
  }
  return Math.ceil(ascii / asciiPer) + Math.ceil(cjk / cjkPer);
}

/** Estimate tokens for an object by JSON-stringifying it. */
export function countTokensOf(obj: unknown, opts: TokenizerOptions = {}): number {
  let text: string;
  try {
    text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch {
    text = String(obj);
  }
  return countTokens(text, opts);
}
