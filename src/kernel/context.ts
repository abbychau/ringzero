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
    // Images are fixed-size payloads; count them flat so we never serialize base64.
    if (m.images?.length) total += m.images.length * 1000;
  }
  return total;
}

export interface CompactResult {
  messages: SessionMessage[];
  summary: string;
  /** number of messages replaced by the summary */
  replaced: number;
  /** number of compaction passes performed (incremental folding) */
  passes: number;
}

const COMPACT_PROMPT = (budgetTokens: number) =>
  `You are a context compactor. Summarize the conversation below into a concise but information-dense summary (aim ≤ ${budgetTokens} tokens) for continuing the task.

If a previous compacted summary is present at the start of the conversation, fold it into your new summary instead of repeating it.

Write the summary as a structured brief with exactly these sections:

# Goals
The user's overall objective and the current milestone being worked toward.

# Decisions
Design decisions, constraints, and trade-offs already settled. Include the reasoning in one line where it matters.

# Files
Every file path touched or inspected, with one line on what was done there.

# Errors
Exact error messages, failing commands, and any open issues, with their current status.

# Unfinished
What remains to be done next, in priority order. Be specific enough that the task can continue without re-reading the dropped messages.

PRESERVE: the user's goal, decisions made, file paths touched, exact command results, error messages, and any unfinished work.
DROP: praise, repetition, chit-chat.
Output ONLY the summary text, no preamble.`;

/**
 * Build the summarize-request messages from a history prefix.
 * Assistant tool-call arguments are omitted: they are the largest payload in the
 * history, already reflected in tool result contents, and only waste summary budget.
 */
function summarizeMessages(prefix: SessionMessage[], prompt: string): any[] {
  return [
    ...prefix.map((m): any => {
      if (m.role === 'assistant') {
        return { role: 'assistant', content: m.content };
      }
      if (m.role === 'tool') return { role: 'tool', toolCallId: m.toolCallId, content: m.content };
      return { role: m.role, content: m.content };
    }),
    { role: 'user', content: prompt },
  ];
}

async function summarizeOnce(
  provider: Provider,
  msgs: any[],
  compactBudget: number,
): Promise<string> {
  let summary = '';
  for await (const ev of provider.chat({ messages: msgs, maxTokens: compactBudget })) {
    if (ev.type === 'text') summary += ev.text;
  }
  return summary.trim() || '[context compacted]';
}

/**
 * Compact the oldest messages into a single structured summary, keeping the
 * tail verbatim. Returns a new history. Uses the same provider (no extra tools).
 *
 * Compaction 2.0:
 * - structured summary sections (goals / decisions / files / errors / unfinished),
 * - tool-call arguments are excluded from the summarize request,
 * - incremental: after the first pass, if the folded history still exceeds the
 *   budget, re-compact (up to 3 passes) so long conversations converge.
 */
export async function compactHistory(
  provider: Provider,
  history: SessionMessage[],
  opts: { preserveRecentTokens: number; budgetTokens: number; system?: string[] },
): Promise<CompactResult> {
  const compactBudget = Math.max(256, Math.floor(opts.budgetTokens / 8));
  const prompt = COMPACT_PROMPT(compactBudget);
  const systemMsgs = (opts.system ?? []).map((s): any => ({ role: 'system', content: s }));

  let current = history;
  let replaced = 0;
  let passes = 0;
  let lastSummary = '';
  const MAX_PASSES = 3;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // Walk from the tail, accumulating until we reach preserveRecentTokens; the
    // remaining prefix gets summarized.
    let tailStart = current.length;
    let tailTokens = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const m = current[i]!;
      const t =
        countTokensOf(m.content) +
        (m.toolCalls?.length ? countTokensOf(m.toolCalls) : 0) +
        (m.images?.length ? m.images.length * 1000 : 0);
      if (tailTokens + t > opts.preserveRecentTokens) break;
      tailTokens += t;
      tailStart = i;
    }
    const prefix = current.slice(0, tailStart);
    const tail = current.slice(tailStart);
    if (prefix.length === 0) {
      if (passes === 0) return { messages: history, summary: '', replaced: 0, passes: 0 };
      break; // everything fits; nothing left to fold
    }

    const summary = await summarizeOnce(
      provider,
      [...systemMsgs, ...summarizeMessages(prefix, prompt)],
      compactBudget,
    );
    lastSummary = summary;

    const summaryMsg: SessionMessage = {
      id: newId('msg'),
      role: 'user',
      content: `[compacted summary of earlier conversation]\n${summary}`,
      ts: Date.now(),
    };
    replaced += prefix.length;
    passes++;
    current = [summaryMsg, ...tail];

    // Stop early if the folded history is within budget already.
    if (estimateContextTokens(provider, current, { system: opts.system }) <= opts.budgetTokens) {
      break;
    }
  }

  return { messages: current, summary: lastSummary, replaced, passes };
}
