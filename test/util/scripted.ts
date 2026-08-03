/**
 * Offline "recorded provider responses" harness (P3.2): serves pre-recorded
 * conversations so agent runs are deterministic, fast, and free. Each request
 * is matched to a conversation by the longest prefix match on the LAST user
 * message (parent prompts, the compactor prompt, sub-agent task texts all
 * match this way), and conversations serve their sequences in order.
 *
 * Token usage is tracked offline: input = estimateContextTokens of every
 * request (system + tools + messages), output/cache from the served sequences.
 */
import type {
  ChatEvent,
  ChatRequest,
  Provider,
  ProviderMessage,
  SessionMessage,
  TokenUsage,
} from '../../src/kernel/types.js';
import { countTokens } from '../../src/kernel/tokenizer.js';
import { estimateContextTokens } from '../../src/kernel/context.js';

export interface ScriptedSequence {
  events: Exclude<ChatEvent, { type: 'finish' }>[];
  usage?: TokenUsage;
}

export interface ScriptedConversation {
  match: string;
  sequences: ScriptedSequence[];
}

export interface ScriptedStats {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Input tokens of the last request (final context size). */
  lastInput: number;
}

function lastUserText(msgs: ProviderMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'user') return msgs[i]!.content;
  }
  return '';
}

function toSession(m: ProviderMessage): SessionMessage {
  return {
    id: 's',
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    toolCallId: m.toolCallId,
    images: m.images,
    ts: 0,
  };
}

export function createScriptedProvider(convos: ScriptedConversation[]): {
  provider: Provider;
  stats: ScriptedStats;
} {
  const used = new Map<string, number>();
  const stats: ScriptedStats = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    lastInput: 0,
  };
  const provider: Provider = {
    id: 'scripted',
    countTokens: (t) => countTokens(t),
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
      stats.requests++;
      stats.lastInput = estimateContextTokens(provider, req.messages.map(toSession), {
        system: req.system,
        tools: req.tools,
      });
      stats.input += stats.lastInput;
      const text = lastUserText(req.messages);
      let best: ScriptedConversation | undefined;
      for (const c of convos) {
        if (text.startsWith(c.match) && (!best || c.match.length > best.match.length)) {
          best = c;
        }
      }
      const idx = best ? (used.get(best.match) ?? 0) : 0;
      if (best) used.set(best.match, idx + 1);
      const seq = best?.sequences[idx];
      if (!seq) {
        yield {
          type: 'text',
          text: `(scripted: no more sequences for "${best?.match ?? text.slice(0, 40)}")`,
        };
        yield { type: 'finish', usage: undefined };
        return;
      }
      for (const ev of seq.events) yield ev;
      const usage = seq.usage;
      if (usage) {
        stats.output += usage.output;
        stats.cacheRead += usage.cacheRead ?? 0;
        stats.cacheWrite += usage.cacheWrite ?? 0;
      }
      yield { type: 'finish', usage };
    },
  };
  return { provider, stats };
}
