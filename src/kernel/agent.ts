import { homedir } from 'node:os';
import type {
  Provider,
  SessionMessage,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  TokenUsage,
  ProviderMessage,
} from './types.js';
import { newId } from './id.js';
import { truncateOutput } from './truncate.js';
import { compactHistory, estimateContextTokens } from './context.js';
import { PermissionGate } from '../permission/gate.js';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; args: string }
  | { type: 'tool_result'; name: string; output: string; truncated: boolean }
  | { type: 'permission'; name: string; allowed: boolean }
  | { type: 'compacting' }
  | { type: 'finish'; usage?: TokenUsage; steps: number };

export interface AgentOptions {
  provider: Provider;
  tools: Tool[];
  permission: PermissionGate;
  /** Persistent history loaded from the session store (may be empty). */
  history?: SessionMessage[];
  system?: string[];
  cwd?: string;
  home?: string;
  /** Estimated context budget in tokens (default 32k). Triggers compaction. */
  contextBudget?: number;
  /** Tokens of recent history preserved verbatim across compaction. */
  preserveRecentTokens?: number;
  /** Optional root that fs tools are locked to (paths outside are rejected). */
  workspace?: string;
  maxSteps?: number;
  maxToolOutputChars?: number;
  compact?: boolean;
  onEvent?: (e: AgentEvent) => void;
  /** Map an external abort signal into the loop. */
  signal?: AbortSignal;
  /** Called for every message created by this run (used for persistence). */
  onMessage?: (m: SessionMessage) => void;
  /** Called after auto-compaction replaces the history (used to persist the result). */
  onCompact?: (messages: SessionMessage[]) => void;
  /** Plugin hook: deny or rewrite a tool call before the permission gate. */
  onBeforeTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ allowed?: boolean; args?: Record<string, unknown> } | undefined>;
  /** Plugin hook: inspect or rewrite a tool result before it is fed back to the model. */
  onToolAfter?: (
    name: string,
    args: Record<string, unknown>,
    output: string,
  ) => Promise<{ output?: string } | undefined> | { output?: string } | undefined;
}

function toProviderMessages(history: SessionMessage[]): ProviderMessage[] {
  return history.map((m): ProviderMessage => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return { role: 'assistant', content: m.content, toolCalls: m.toolCalls };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, toolCallId: m.toolCallId };
    return { role: m.role, content: m.content };
  });
}

export class Agent {
  readonly provider: Provider;
  readonly tools: Tool[];
  readonly toolDefs: ToolDefinition[];
  private readonly opts: Required<
    Pick<
      AgentOptions,
      'contextBudget' | 'preserveRecentTokens' | 'maxSteps' | 'maxToolOutputChars' | 'compact'
    >
  > &
    AgentOptions;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.toolDefs = options.tools.map((t) => t.definition);
    this.opts = {
      contextBudget: 32_000,
      preserveRecentTokens: 8_000,
      maxSteps: 24,
      maxToolOutputChars: 30_000,
      compact: true,
      ...options,
    };
  }

  /**
   * Run the agent for one user turn (multi-step until no more tool calls).
   * Yields events; `finish` is always the last event.
   */
  async *run(userText: string): AsyncGenerator<AgentEvent> {
    const emit = (e: AgentEvent) => {
      this.opts.onEvent?.(e);
      return e;
    };
    let history: SessionMessage[] = [...(this.opts.history ?? [])];
    const cwd = this.opts.cwd ?? process.cwd();
    const home = this.opts.home ?? homedir();

    const toolCtx: ToolContext = {
      cwd,
      home,
      workspace: this.opts.workspace,
      signal: this.opts.signal ?? new AbortController().signal,
      ask: async (p) => {
        const r = await this.opts.permission.check('__ask__', p);
        return r.allowed;
      },
    };

    const push = (m: SessionMessage): void => {
      history.push(m);
      this.opts.onMessage?.(m);
    };
    push({ id: newId('msg'), role: 'user', content: userText, ts: Date.now() });
    // Cumulative token usage across ALL model calls in this run (not just the last).
    let usage: TokenUsage | undefined;
    const addUsage = (u: TokenUsage | undefined): void => {
      if (!u) return;
      const cacheRead = (usage?.cacheRead ?? 0) + (u.cacheRead ?? 0);
      const cacheWrite = (usage?.cacheWrite ?? 0) + (u.cacheWrite ?? 0);
      usage = {
        input: (usage?.input ?? 0) + u.input,
        output: (usage?.output ?? 0) + u.output,
        ...(cacheRead > 0 ? { cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWrite } : {}),
      };
    };
    let steps = 0;

    while (steps < this.opts.maxSteps) {
      // Budget check → compact oldest messages, keep tail verbatim.
      if (this.opts.compact && history.length > 2) {
        const est = estimateContextTokens(this.provider, history, {
          system: this.opts.system,
          tools: this.toolDefs,
        });
        if (est > this.opts.contextBudget) {
          yield emit({ type: 'compacting' });
          const result = await compactHistory(this.provider, history, {
            preserveRecentTokens: this.opts.preserveRecentTokens,
            budgetTokens: this.opts.contextBudget,
            system: this.opts.system,
          });
          history = result.messages;
          this.opts.onCompact?.(history);
        }
      }

      let messages = toProviderMessages(history);
      const calls: NonNullable<ProviderMessage['toolCalls']> = [];
      let text = '';
      let turnUsage: TokenUsage | undefined;
      let overflowTries = 0;
      for (;;) {
        try {
          for await (const ev of this.provider.chat({
            system: this.opts.system,
            messages,
            tools: this.toolDefs,
            signal: this.opts.signal,
          })) {
            if (ev.type === 'text') {
              text += ev.text;
              yield emit({ type: 'text', text: ev.text });
            } else if (ev.type === 'thinking') {
              // Reasoning text is streamed to the UI but never persisted: it is
              // provider-specific and must not be replayed as conversation.
              yield emit({ type: 'thinking', text: ev.text });
            } else if (ev.type === 'tool_calls') {
              calls.push(...ev.calls);
            } else if (ev.type === 'finish') {
              turnUsage = ev.usage;
            }
          }
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isOverflow =
            this.opts.compact && overflowTries < 2 && /context|token|length|maximum/i.test(msg);
          if (!isOverflow) throw err;
          overflowTries++;
          yield emit({ type: 'compacting' });
          const result = await compactHistory(this.provider, history, {
            preserveRecentTokens: this.opts.preserveRecentTokens,
            budgetTokens: this.opts.contextBudget,
            system: this.opts.system,
          });
          history = result.messages;
          this.opts.onCompact?.(history);
          messages = toProviderMessages(history);
          text = '';
          calls.length = 0;
          turnUsage = undefined;
        }
      }
      addUsage(turnUsage);

      push({
        id: newId('msg'),
        role: 'assistant',
        content: text,
        toolCalls: calls,
        usage: turnUsage,
        ts: Date.now(),
      });

      if (calls.length === 0) break;

      // Phase 1 (sequential): resolve + authorize each call. Permission checks may
      // ask the user, so they run one at a time. Unknown/blocked/denied calls are
      // reported immediately; approved ones are queued for concurrent execution.
      const work: { call: ToolCall; tool: Tool; args: Record<string, unknown> }[] = [];
      for (const call of calls) {
        const tool = this.tools.find((t) => t.definition.name === call.name);
        if (!tool) {
          // Unknown tools still surface in the event stream so the UI shows them.
          yield emit({ type: 'tool_start', name: call.name, args: call.args });
          push({
            id: newId('msg'),
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: `unknown tool: ${call.name}`,
            ts: Date.now(),
          });
          yield emit({
            type: 'tool_result',
            name: call.name,
            output: `unknown tool: ${call.name}`,
            truncated: false,
          });
          continue;
        }
        let args = safeParseArgs(call.args);
        let blocked = false;
        if (this.opts.onBeforeTool) {
          const r = await this.opts.onBeforeTool(call.name, args);
          if (r?.allowed === false) blocked = true;
          else if (r?.args) args = r.args;
        }
        yield emit({ type: 'tool_start', name: call.name, args: call.args });
        if (blocked) {
          push({
            id: newId('msg'),
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: '[blocked by plugin]',
            ts: Date.now(),
          });
          yield emit({ type: 'permission', name: call.name, allowed: false });
          yield emit({
            type: 'tool_result',
            name: call.name,
            output: '[blocked by plugin]',
            truncated: false,
          });
          continue;
        }
        const { allowed } = await this.opts.permission.check(call.name, call.args);
        yield emit({ type: 'permission', name: call.name, allowed });
        if (!allowed) {
          push({
            id: newId('msg'),
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: '[permission denied by user]',
            ts: Date.now(),
          });
          yield emit({
            type: 'tool_result',
            name: call.name,
            output: '[permission denied by user]',
            truncated: false,
          });
          continue;
        }
        work.push({ call, tool, args });
      }

      // Phase 2 (concurrent): execute all approved tools in parallel, then report
      // results in the ORIGINAL call order so consumers can attribute each output
      // to the right tool block.
      const results = await Promise.all(
        work.map(async ({ call, tool, args }) => {
          let output: string;
          try {
            output = await tool.execute(args, toolCtx);
          } catch (err) {
            output = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
          const first = truncateOutput(output, this.opts.maxToolOutputChars);
          let text = first.text;
          let wasTruncated = first.truncated;
          if (this.opts.onToolAfter) {
            const r = await this.opts.onToolAfter(call.name, args, text);
            if (r && r.output !== undefined) {
              // Rewrites are re-truncated so a hook can't blow the budget.
              const again = truncateOutput(r.output, this.opts.maxToolOutputChars);
              text = again.text;
              wasTruncated = again.truncated;
            }
          }
          return { call, truncated: text, wasTruncated };
        }),
      );
      for (const { call, truncated, wasTruncated } of results) {
        push({
          id: newId('msg'),
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: truncated,
          ts: Date.now(),
        });
        yield emit({
          type: 'tool_result',
          name: call.name,
          output: truncated,
          truncated: wasTruncated,
        });
      }

      steps++;
    }

    yield emit({ type: 'finish', usage, steps });
  }
}

function safeParseArgs(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
