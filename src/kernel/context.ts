import type { Provider, SessionMessage, ToolDefinition } from './types.js';
import { countTokensOf } from './tokenizer.js';
import { newId } from './id.js';

export interface EstimateOptions {
  system?: string[];
  tools?: ToolDefinition[];
}

/** Estimate tokens for a full context (system + tools + messages). CJK-aware. */
export function estimateContextTokens(
  _provider: Provider,
  messages: SessionMessage[],
  opts: EstimateOptions = {},
): number {
  let total = 0;
  for (const s of opts.system ?? []) total += countTokensOf(s);
  for (const t of opts.tools ?? []) total += countTokensOf(t);
  for (const m of messages) {
    total += countTokensOf(m.content);
    // Tool call arguments are part of the wire payload, so count them too.
    if (m.toolCalls?.length) total += countTokensOf(m.toolCalls);
  }
  return total;
}

export interface CompactResult {
  messages: SessionMessage[];
  summary: string;
  /** number of messages replaced by the summary */
  replaced: number;
}

const COMPACT_PROMPT = (budgetTokens: number) =>
  `You are a context compactor. Summarize the conversation below into a concise but information-dense summary (aim ≤ ${budgetTokens} tokens) for continuing the task. PRESERVE: the user's goal, decisions made, file paths touched, exact command results, error messages, and any unfinished work. DROP: praise, repetition, chit-chat. Output ONLY the summary text, no preamble.`;

/**
 * Compact the oldest messages into a single summary, keeping the tail verbatim.
 * Returns a new history. Uses the same provider (no extra tools).
 */
export async function compactHistory(
  provider: Provider,
  history: SessionMessage[],
  opts: { preserveRecentTokens: number; budgetTokens: number; system?: string[] },
): Promise<CompactResult> {
  // Walk from the tail, accumulating until we reach preserveRecentTokens; the
  // remaining prefix gets summarized.
  let tailStart = history.length;
  let tailTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t =
      countTokensOf(history[i]!.content) +
      (history[i]!.toolCalls?.length ? countTokensOf(history[i]!.toolCalls) : 0);
    if (tailTokens + t > opts.preserveRecentTokens) break;
    tailTokens += t;
    tailStart = i;
  }
  const prefix = history.slice(0, tailStart);
  const tail = history.slice(tailStart);
  if (prefix.length === 0) {
    return { messages: history, summary: '', replaced: 0 };
  }

  const compactBudget = Math.max(256, Math.floor(opts.budgetTokens / 8));
  const prompt = COMPACT_PROMPT(compactBudget);
  const msgs = [
    ...(opts.system ?? []).map((s): any => ({ role: 'system', content: s })),
    ...prefix.map((m): any => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content,
          toolCalls: m.toolCalls,
        };
      }
      if (m.role === 'tool') return { role: 'tool', toolCallId: m.toolCallId, content: m.content };
      return { role: m.role, content: m.content };
    }),
    { role: 'user', content: prompt },
  ];

  let summary = '';
  for await (const ev of provider.chat({ messages: msgs, maxTokens: compactBudget })) {
    if (ev.type === 'text') summary += ev.text;
  }
  summary = summary.trim() || '[context compacted]';

  const summaryMsg: SessionMessage = {
    id: newId('msg'),
    role: 'user',
    content: `[compacted summary of earlier conversation]\n${summary}`,
    ts: Date.now(),
  };
  return { messages: [summaryMsg, ...tail], summary, replaced: prefix.length };
}
