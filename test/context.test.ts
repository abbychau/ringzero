import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory } from '../src/kernel/context.js';
import type { ChatEvent, ChatRequest, Provider } from '../src/kernel/types.js';

/**
 * Regression: compaction must never produce (or SEND) a `tool` message without
 * a preceding assistant(tool_calls). OpenAI-compatible APIs reject that with
 * HTTP 400 ("Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'"), which crashed long tool-heavy runs right after
 * `[compacting context…]`.
 */
function makeHistory(): unknown[] {
  const msgs: unknown[] = [];
  msgs.push({ id: 'u0', role: 'user', content: 'start', ts: 1 });
  for (let i = 0; i < 8; i++) {
    msgs.push({
      id: `a${i}`,
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'bash', args: '{}' }],
      ts: 2 + i * 2,
    });
    msgs.push({
      id: `t${i}`,
      role: 'tool',
      toolCallId: `c${i}`,
      toolName: 'bash',
      content: `out${i}`,
      ts: 3 + i * 2,
    });
  }
  return msgs;
}

interface MaybeTool {
  role?: string;
  toolCallId?: string;
  tool_call_id?: string;
  toolCalls?: { id: string }[];
  tool_calls?: { id: string }[];
}

/** True if a `tool`-role message is preceded by an assistant carrying its id. */
function hasPrecedingToolCalls(msgs: MaybeTool[], i: number): boolean {
  const prev = msgs[i - 1];
  if (!prev || prev.role !== 'assistant') return false;
  const ids = prev.toolCalls ?? prev.tool_calls;
  const id = msgs[i]!.toolCallId ?? msgs[i]!.tool_call_id;
  return !!ids && ids.some((t) => t.id === id);
}

test('compactHistory keeps tool pairs intact and never sends an orphan tool message', async () => {
  const summarizeRequests: MaybeTool[][] = [];
  const provider: Provider = {
    countTokens: (t: unknown) => (typeof t === 'string' ? t.length : 100),
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
      summarizeRequests.push(req.messages as MaybeTool[]);
      yield { type: 'text', text: 'summary' };
      yield { type: 'finish' };
    },
  } as unknown as Provider;

  const res = await compactHistory(provider, makeHistory() as never, {
    preserveRecentTokens: 5,
    budgetTokens: 100,
    system: [],
  });

  // 1. The compacted history must not contain an orphan `tool` message.
  for (let i = 0; i < res.messages.length; i++) {
    const m = res.messages[i] as MaybeTool;
    if (m.role === 'tool') {
      assert.ok(
        hasPrecedingToolCalls(res.messages as MaybeTool[], i),
        `compacted history has orphan tool: ${JSON.stringify(res.messages)}`,
      );
    }
  }

  // 2. Every summarize request must be API-valid: either the assistant keeps
  //    tool_calls, or tool results are re-emitted as user (never raw `tool`
  //    without a preceding assistant tool_calls).
  assert.ok(summarizeRequests.length > 0, 'expected at least one summarize call');
  for (const req of summarizeRequests) {
    for (let i = 0; i < req.length; i++) {
      if (req[i]!.role === 'tool') {
        assert.ok(
          hasPrecedingToolCalls(req, i),
          `summarize request has orphan tool: ${JSON.stringify(req)}`,
        );
      }
    }
  }
});
