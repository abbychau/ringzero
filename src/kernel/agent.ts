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
  ChatEvent,
  ImageInput,
} from './types.js';
import { PLAN_APPROVED } from './types.js';
import { newId } from './id.js';
import { truncateOutput } from './truncate.js';
import { compactHistory, estimateContextTokens } from './context.js';
import { makeRedactor } from './redact.js';
import { PermissionGate } from '../permission/gate.js';

/** Tools that never mutate the project (allowed in plan mode before approval). */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'list_dir',
  'tree',
  'git_status',
  'git_diff',
  'git_log',
  'web_fetch',
  'web_search',
]);

/**
 * Tools that actually change the environment (write files, run commands, or
 * commit). In task mode, a text-only finish before any of these have run is
 * treated as "described work without doing it" and bounced back — merely
 * inspecting files (read/grep/list) does NOT count as completing a task.
 */
const EFFECTIVE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'bash',
  'git_commit',
  'http_request',
  'verify',
]);

/** Pure tools whose identical repeated calls are deduped within a run. */
const CACHEABLE_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'list_dir',
  'tree',
  'git_status',
  'git_diff',
  'git_log',
  'web_fetch',
]);

export const PLAN_BLOCK_TEXT = 'plan mode: present a plan with the plan tool first';

/**
 * Injected as a user turn when the step cap was hit and the user chose to
 * continue (TUI/REPL prompt). Keeps the transcript honest about why it's there.
 */
export const CONTINUE_PROMPT = '(已達步數上限,用戶選擇繼續。請完成未竟的工作)';

/** Sentinel for the stream-step race: an interrupt won over the model event. */
const INTERRUPT = { interrupt: true as const };

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; args: string; callId: string }
  | { type: 'tool_result'; name: string; output: string; truncated: boolean; callId: string }
  | { type: 'permission'; name: string; allowed: boolean }
  | { type: 'compacting' }
  | { type: 'injected'; text: string }
  | { type: 'finish'; usage?: TokenUsage; steps: number; reason: 'done' | 'max_steps' };

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
  /** Free-text question channel for ask_user (interactive sessions only). */
  promptUser?: (prompt: string) => Promise<string | null>;
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
  /** Plan mode: non-read-only tools are blocked until the user approves a plan. */
  planMode?: boolean;
  /** Max parallel tool executions per turn (default 4). */
  maxConcurrency?: number;
  /**
   * Task-oriented mode (enabled by Runner.taskMode / RINGZERO_TASK_MODE):
   * when the model answers with text alone (no tool call) and NO tool has
   * been executed yet this run, bounce the answer back instead of finishing.
   * This is the autonomous-mode analog of an interactive harness handing
   * control back to the user on a text-only step: in a headless task run
   * there is no user, so we auto-"continue with tools" instead of declaring
   * the task done. Counteracts "early finish" on autonomous benchmark tasks.
   */
  requireToolUse?: boolean;
}

function toProviderMessages(history: SessionMessage[]): ProviderMessage[] {
  return history.map((m): ProviderMessage => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return { role: 'assistant', content: m.content, toolCalls: m.toolCalls };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, toolCallId: m.toolCallId };
    return { role: m.role, content: m.content, images: m.images };
  });
}

export class Agent {
  readonly provider: Provider;
  readonly tools: Tool[];
  readonly toolDefs: ToolDefinition[];
  private readonly opts: Required<
    Pick<
      AgentOptions,
      | 'contextBudget'
      | 'preserveRecentTokens'
      | 'maxSteps'
      | 'maxToolOutputChars'
      | 'compact'
      | 'maxConcurrency'
    >
  > &
    AgentOptions;
  /** Set once the user approves a plan via the plan tool (per run). */
  private planApproved = false;
  /** Tool call counts per session, used to order tool definitions by usage. */
  private toolUsage = new Map<string, number>();
  /** True while run() is active; gates inject(). */
  private running = false;
  /** User messages queued while a run is in progress. */
  private interrupts: string[] = [];
  /** Resolver for the in-flight streaming wait (single pending waiter). */
  private interruptNotify: (() => void) | null = null;

  /**
   * Queue a user message into an active run. The running agent aborts the
   * current stream, processes the injected message, then continues.
   * Returns false when the agent is idle.
   */
  inject(text: string): boolean {
    if (!this.running) return false;
    this.interrupts.push(text);
    this.interruptNotify?.();
    return true;
  }

  /** Resolves immediately when an interrupt is queued, or fires on the next one. */
  private waitForInterrupt(): Promise<boolean> {
    if (this.interrupts.length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.interruptNotify = () => {
        this.interruptNotify = null;
        resolve(true);
      };
    });
  }

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
      maxConcurrency: 4,
      ...options,
    };
  }

  /**
   * Run the agent for one user turn (multi-step until no more tool calls).
   * Yields events; `finish` is always the last event.
   * `images` attach to the first user message (one-shot: they are not persisted
   * to the session store, so later turns do not resend them).
   */
  async *run(userText: string, opts: { images?: ImageInput[] } = {}): AsyncGenerator<AgentEvent> {
    this.running = true;
    try {
      yield* this.runInternal(userText, opts);
    } finally {
      this.running = false;
      this.interrupts.length = 0;
      this.interruptNotify = null;
    }
  }

  private async *runInternal(
    userText: string,
    opts: { images?: ImageInput[] } = {},
  ): AsyncGenerator<AgentEvent> {
    const emit = (e: AgentEvent) => {
      this.opts.onEvent?.(e);
      return e;
    };
    let history: SessionMessage[] = [...(this.opts.history ?? [])];
    const cwd = this.opts.cwd ?? process.cwd();
    const home = this.opts.home ?? homedir();
    const redact = makeRedactor();
    // Tool definitions ordered by usage frequency (stable within a run, which
    // keeps the provider prompt cache stable across runs).
    const toolDefs = this.orderedToolDefs();
    // Per-run dedupe for pure tools (repeated read_file/grep/glob results).
    // inFlight coalesces concurrent identical calls; toolCache holds settled results.
    const toolCache = new Map<string, string>();
    const toolInFlight = new Map<string, Promise<string>>();

    const toolCtx: ToolContext = {
      cwd,
      home,
      workspace: this.opts.workspace,
      signal: this.opts.signal ?? new AbortController().signal,
      promptUser: this.opts.promptUser,
      ask: async (p) => {
        const r = await this.opts.permission.check('__ask__', p);
        return r.allowed;
      },
    };

    const push = (m: SessionMessage): void => {
      history.push(m);
      this.opts.onMessage?.(m);
    };
    push({
      id: newId('msg'),
      role: 'user',
      content: userText,
      images: opts.images,
      ts: Date.now(),
    });
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
    // maxSteps < 0 (MAX_STEPS=-1) disables the step cap entirely.
    const stepCap = this.opts.maxSteps < 0 ? Number.POSITIVE_INFINITY : this.opts.maxSteps;
    // A natural loop exit (steps >= stepCap) means the cap was hit; only the
    // calls.length === 0 break means the model finished on its own.
    let reason: 'done' | 'max_steps' = 'max_steps';

    while (steps < stepCap) {
      // Mid-run injection: process queued user messages before the next model call.
      if (this.interrupts.length > 0) {
        for (const t of this.interrupts.splice(0)) {
          push({ id: newId('msg'), role: 'user', content: t, ts: Date.now() });
          yield emit({ type: 'injected', text: t });
        }
        continue;
      }
      // Budget check → compact oldest messages, keep tail verbatim.
      if (this.opts.compact && history.length > 2) {
        const est = estimateContextTokens(this.provider, history, {
          system: this.opts.system,
          tools: toolDefs,
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
      let interrupted = false;
      for (;;) {
        const interruptAbort = new AbortController();
        const signal = this.opts.signal
          ? AbortSignal.any([this.opts.signal, interruptAbort.signal])
          : interruptAbort.signal;
        try {
          const it = this.provider.chat({
            system: this.opts.system,
            messages,
            tools: toolDefs,
            signal,
          });
          // Manual iteration: race each stream step against mid-run injection so
          // an injected message aborts the current model call immediately.
          for (;;) {
            const stepP = it.next();
            const stepped: IteratorResult<ChatEvent> | typeof INTERRUPT = await Promise.race([
              stepP,
              this.waitForInterrupt().then(() => INTERRUPT),
            ]);
            if ('interrupt' in stepped) {
              interrupted = true;
              interruptAbort.abort();
              try {
                await stepP;
              } catch {
                // Aborted stream; nothing to salvage.
              }
              break;
            }
            if (stepped.done) break;
            const ev = stepped.value;
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
          if (interrupted) break; // abort caused by our own injection
          if (err instanceof Error && err.name === 'AbortError' && this.opts.signal?.aborted) {
            throw err;
          }
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

      if (interrupted) continue; // next iteration drains the injected messages
      if (calls.length === 0) {
        // Task mode: never accept a text-only "answer" before the agent has
        // actually DONE the work — i.e. executed an effective tool (wrote a
        // file, ran a command, committed). Inspecting alone (read/grep/list)
        // or just describing work does not count. Bounce it back as a user
        // message so the model continues and finishes the work with tools.
        const hasEffectiveWork = [...this.toolUsage.keys()].some((n) => EFFECTIVE_TOOLS.has(n));
        if (this.opts.requireToolUse && !hasEffectiveWork) {
          push({
            id: newId('msg'),
            role: 'user',
            content:
              'You have not actually completed the task yet: you must create the ' +
              'required output artifact(s) (write files) and/or run commands to ' +
              'produce and verify the result. Merely inspecting files or describing ' +
              'what to do is not enough. Use write_file/edit_file/bash to create the ' +
              'deliverable, verify it, then finish.',
            ts: Date.now(),
          });
          continue;
        }
        reason = 'done';
        break;
      }

      // Phase 1 (sequential): resolve + authorize each call. Permission checks may
      // ask the user, so they run one at a time. Unknown/blocked/denied calls are
      // reported immediately; approved ones are queued for concurrent execution.
      const work: { call: ToolCall; tool: Tool; args: Record<string, unknown> }[] = [];
      for (const call of calls) {
        const tool = this.tools.find((t) => t.definition.name === call.name);
        if (!tool) {
          // Unknown tools still surface in the event stream so the UI shows them.
          yield emit({ type: 'tool_start', name: call.name, args: call.args, callId: call.id });
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
            callId: call.id,
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
        yield emit({
          type: 'tool_start',
          name: call.name,
          args: redact(call.args),
          callId: call.id,
        });
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
            callId: call.id,
          });
          continue;
        }
        // Plan mode: only read-only tools + the plan tool run until the user
        // approves. Non-read-only calls are blocked with a hint to plan first.
        // Yolo mode bypasses plan mode entirely (no prompts, no gates).
        if (
          this.opts.planMode &&
          !this.opts.permission.yolo &&
          !this.planApproved &&
          call.name !== 'plan' &&
          !READ_ONLY_TOOLS.has(call.name)
        ) {
          push({
            id: newId('msg'),
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: PLAN_BLOCK_TEXT,
            ts: Date.now(),
          });
          yield emit({ type: 'permission', name: call.name, allowed: false });
          yield emit({
            type: 'tool_result',
            name: call.name,
            output: PLAN_BLOCK_TEXT,
            truncated: false,
            callId: call.id,
          });
          continue;
        }
        // The plan tool self-gates through ctx.ask; after approval, tools run
        // without further permission prompts.
        let allowed = true;
        if (call.name !== 'plan' && !(this.opts.planMode && this.planApproved)) {
          const r = await this.opts.permission.check(call.name, call.args);
          allowed = r.allowed;
        }
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
            callId: call.id,
          });
          continue;
        }
        this.toolUsage.set(call.name, (this.toolUsage.get(call.name) ?? 0) + 1);
        work.push({ call, tool, args });
      }

      // Phase 2 (concurrent, capped): execute approved tools with a concurrency
      // limit, then report results in the ORIGINAL call order so consumers can
      // attribute each output to the right tool block.
      const results: { call: ToolCall; truncated: string; wasTruncated: boolean }[] = new Array(
        work.length,
      );
      const limit = Math.max(1, this.opts.maxConcurrency);
      let next = 0;
      const runOne = async () => {
        while (next < work.length) {
          const i = next++;
          const { call, tool, args } = work[i]!;
          const key = CACHEABLE_TOOLS.has(call.name)
            ? `${call.name}\u0000${JSON.stringify(args)}`
            : null;
          let output: string;
          const cached = key !== null ? toolCache.get(key) : undefined;
          if (cached !== undefined) {
            output = `${cached}\n[cached result]`;
          } else {
            let pending = key !== null ? toolInFlight.get(key) : undefined;
            if (pending) {
              // Concurrent duplicate: wait for the in-flight execution.
              output = `${await pending}\n[cached result]`;
            } else {
              const run = (async () => {
                try {
                  return await tool.execute(args, toolCtx);
                } catch (err) {
                  return `error: ${err instanceof Error ? err.message : String(err)}`;
                }
              })();
              if (key !== null) toolInFlight.set(key, run);
              output = await run;
              if (key !== null) {
                toolInFlight.delete(key);
                toolCache.set(key, output);
              }
            }
          }
          if (call.name === 'plan' && output === PLAN_APPROVED) this.planApproved = true;
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
          text = redact(text);
          results[i] = { call, truncated: text, wasTruncated };
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, work.length) }, () => runOne()));
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
          callId: call.id,
        });
      }

      steps++;
    }

    yield emit({ type: 'finish', usage, steps, reason });
  }

  private orderedToolDefs(): ToolDefinition[] {
    if (this.toolUsage.size === 0) return this.toolDefs;
    return [...this.toolDefs].sort(
      (a, b) =>
        (this.toolUsage.get(b.name) ?? 0) - (this.toolUsage.get(a.name) ?? 0) ||
        a.name.localeCompare(b.name),
    );
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
