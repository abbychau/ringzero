/** Tool output truncation — keeps the LLM context small. */

export const DEFAULT_MAX_TOOL_OUTPUT = 30_000;

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/** Keep head+tail, replace the middle with a marker. */
export function truncateOutput(text: string, max = DEFAULT_MAX_TOOL_OUTPUT): TruncateResult {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head - 24;
  if (tail < 0) return { text: text.slice(0, max) + '\n…[truncated]…', truncated: true };
  const removed = text.length - head - tail;
  return {
    text: text.slice(0, head) + `\n…[truncated ${removed} chars]…\n` + text.slice(-tail),
    truncated: true,
  };
}
