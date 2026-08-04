import type { AppConfig } from '../config/config.js';
import { num } from '../config/config.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionStore } from '../session/store.js';
import { exportMarkdown } from '../session/export.js';
import { Agent } from '../kernel/agent.js';
import { defaultTools } from '../tools/index.js';
import { createTaskTool } from '../tools/task.js';
import { createDefaultProvider } from '../providers/registry.js';
import {
  createCheckpoint,
  restoreCheckpoint,
  setCheckpoint,
  gitDiff as gitDiffOutput,
  gitStatus as gitStatusOutput,
  gitCommit as runGitCommit,
} from '../tools/git.js';
import { listSkills, loadSkill, type SkillInfo } from '../skills/loader.js';
import {
  loadPlugins,
  type PluginApi,
  type CommandFn,
  type ToolBeforeInput,
  type ToolBeforeResult,
  type ToolAfterInput,
  type ToolAfterResult,
} from '../plugin/index.js';
import { createMcpTools } from '../mcp/index.js';
import { loadMcpConfig } from '../mcp/config.js';
import { makeVerifyHook } from './verify.js';
import { createVerifyTool } from '../tools/verify.js';
import { PermissionGate, type AskResponse } from '../permission/gate.js';
import { compactHistory, estimateContextTokens } from '../kernel/context.js';
import type { Provider, SessionMessage, Tool } from '../kernel/types.js';
import { createTodoTool, type TodoItem } from '../tools/todo.js';
import { askUserTool } from '../tools/ask.js';

export interface RunnerOptions {
  sessionId?: string;
  model?: string;
  /** Interactive ask handler. Defaults to deny (safe for scripts). */
  ask?: (prompt: string) => Promise<AskResponse>;
  /** Free-text prompt for ask_user (interactive sessions). */
  promptUser?: (prompt: string) => Promise<string | null>;
  /** Start in plan mode (read-only until the user approves a plan). */
  planMode?: boolean;
}

/** Wires config + store + tools + provider into a runnable Agent, per session. */
export class Runner {
  readonly config: AppConfig;
  readonly store: SessionStore;
  readonly gate: PermissionGate;
  sessionId?: string;
  model: string;
  private history: SessionMessage[];
  private checkpointsDir: string;
  private todosDir: string;
  private todos: TodoItem[] = [];
  private planMode: boolean;
  private enabledSkills: string[] = [];
  private mcpTools: Tool[] = [];
  private mcpInited = false;
  private pluginTools: Tool[] = [];
  private pluginCommands = new Map<string, { fn: CommandFn; api: PluginApi }>();
  private pluginToolHooks: ((i: ToolBeforeInput) => Promise<ToolBeforeResult | void>)[] = [];
  private pluginToolAfterHooks: ((i: ToolAfterInput) => Promise<ToolAfterResult | void>)[] = [];
  private skillTools = new Map<string, Tool[]>();
  private promptUserFn?: (prompt: string) => Promise<string | null>;
  /** Set by the UI to receive plugin say() output. */
  pluginSay?: (text: string) => void;

  constructor(config: AppConfig, opts: RunnerOptions = {}) {
    this.config = config;
    this.store = new SessionStore(config.sessionsDir);
    this.checkpointsDir = join(config.home, '.ringzero', 'checkpoints');
    this.todosDir = join(config.home, '.ringzero', 'todos');
    this.sessionId = opts.sessionId;
    this.history = this.sessionId ? this.store.load(this.sessionId) : [];
    if (this.sessionId) this.loadTodos(this.sessionId);
    this.model = opts.model ?? config.env.model;
    this.promptUserFn = opts.promptUser;
    this.planMode =
      opts.planMode ??
      (process.env.RINGZERO_PLAN_MODE === '1' || process.env.RINGZERO_PLAN_MODE === 'true');
    this.gate = new PermissionGate({
      rules: config.permissions,
      ask: opts.ask ?? (async () => 'no' as const),
    });
    // Housekeeping: archive old/excess sessions (env-tunable, off by default
    // except for the 50-session cap). Never archives the session being resumed.
    this.store.prune({
      maxSessions: num(process.env.RINGZERO_SESSION_LIMIT, 50),
      keepDays: num(process.env.RINGZERO_SESSION_KEEP_DAYS, 0),
      except: this.sessionId,
    });
  }

  ensureSession(title = 'New session'): string {
    if (!this.sessionId) {
      this.sessionId = this.store.create(title);
    }
    return this.sessionId;
  }

  /** Connect configured MCP servers + load plugins once. */
  async init(): Promise<void> {
    if (this.mcpInited) return;
    this.mcpInited = true;
    const cfg = loadMcpConfig(this.config.cwd, this.config.home);
    this.mcpTools = await createMcpTools(cfg, this.config.cwd);
    const plugins = await loadPlugins(this.config.pluginDirs);
    for (const p of plugins) {
      try {
        await p.init(this.makePluginApi(p.name));
      } catch (e) {
        console.error(
          `[plugin] ${p.name} init failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** Build a fresh Agent; reloads history from the store so multi-turn works. */
  agent(signal?: AbortSignal): Agent {
    this.history = this.sessionId ? this.store.load(this.sessionId) : this.history;
    const provider = this.makeProvider();
    const tools = [
      ...defaultTools(),
      askUserTool(),
      createTodoTool(this.todos, () => this.saveTodos()),
      createTaskTool({
        provider,
        permission: this.gate,
        cwd: this.config.cwd,
        home: this.config.home,
        contextBudget: this.config.contextBudget,
        preserveRecentTokens: this.config.preserveRecentTokens,
      }),
      ...(this.config.verifyCommand
        ? [createVerifyTool(this.config.verifyCommand, this.config.cwd)]
        : []),
      ...[...this.skillTools.values()].flat(),
      ...this.pluginTools,
      ...this.mcpTools,
    ];
    // Snapshot the worktree once per run, before the first tool call, so
    // /rollback can undo everything the agent did in this run.
    let checkpointed = false;
    // Fresh verify hook per run: it fires at most once after the first
    // write/edit so the model reacts to a broken build/test early.
    const verifyHook = this.config.verifyCommand
      ? makeVerifyHook(this.config.verifyCommand, this.config.cwd)
      : undefined;
    return new Agent({
      provider,
      tools,
      permission: this.gate,
      history: this.history,
      system: this.currentSystem(),
      cwd: this.config.cwd,
      home: this.config.home,
      workspace: this.config.workspace,
      contextBudget: this.config.contextBudget,
      preserveRecentTokens: this.config.preserveRecentTokens,
      maxSteps: this.config.maxSteps,
      planMode: this.planMode,
      signal,
      promptUser: this.promptUserFn,
      onBeforeTool: async (name, args) => {
        if (!checkpointed && this.sessionId) {
          checkpointed = true;
          this.checkpoint(this.sessionId);
        }
        let current = args;
        for (const hook of this.pluginToolHooks) {
          const r = await hook({ name, args: current });
          if (r?.allowed === false) return { allowed: false };
          if (r?.args) current = r.args;
        }
        return { args: current };
      },
      onToolAfter: async (name, args, output) => {
        let current = output;
        for (const hook of this.pluginToolAfterHooks) {
          const r = await hook({ name, args, output: current });
          if (r?.output !== undefined) current = r.output;
        }
        if (verifyHook) {
          const r = await verifyHook(name, args, current);
          if (r?.output !== undefined) current = r.output;
        }
        return current === output ? undefined : { output: current };
      },
      onMessage: (m) => {
        this.ensureSession(m.content.slice(0, 48) || 'session');
        // Images are one-shot: they live in memory for this turn only and are
        // never persisted (base64 would bloat the session store), so they can
        // never be replayed from a loaded history.
        if (m.images) {
          const { images, ...rest } = m;
          void images;
          this.store.append(this.sessionId!, rest);
        } else {
          this.store.append(this.sessionId!, m);
        }
      },
      // Persist auto-compaction so the store shrinks with the context instead of
      // re-summarizing the same old messages on every turn.
      onCompact: (messages) => {
        if (!this.sessionId) return;
        this.store.replace(this.sessionId, messages);
        this.history = messages;
      },
    });
  }

  listSkills(): SkillInfo[] {
    return listSkills(...this.config.skillsDirs);
  }

  hasSkill(name: string): boolean {
    return this.enabledSkills.includes(name);
  }

  async enableSkill(name: string): Promise<boolean> {
    const found = this.listSkills().find((s) => s.name === name);
    if (!found) return false;
    if (!this.enabledSkills.includes(name)) this.enabledSkills.push(name);
    const tp = join(found.path, 'tools.mjs');
    if (existsSync(tp)) {
      try {
        const mod = await import(pathToFileURL(tp).href);
        const tools = (mod.default ?? mod.tools) as Tool[] | undefined;
        if (Array.isArray(tools)) this.skillTools.set(name, tools);
      } catch (e) {
        console.error(
          `[skill] ${name} tools load failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return true;
  }

  disableSkill(name: string): void {
    this.enabledSkills = this.enabledSkills.filter((s) => s !== name);
    this.skillTools.delete(name);
  }

  private makePluginApi(name: string): PluginApi {
    const api: PluginApi = {
      name,
      registerTool: (t) => this.pluginTools.push(t),
      registerCommand: (cmd, fn) => this.pluginCommands.set(cmd, { fn, api }),
      onToolBefore: (fn) => this.pluginToolHooks.push(async (i) => fn(i)),
      onToolAfter: (fn) => this.pluginToolAfterHooks.push(async (i) => fn(i)),
      say: (text) => {
        if (this.pluginSay) this.pluginSay(text);
        else console.log(`[${name}] ${text}`);
      },
    };
    return api;
  }

  /** Dispatch a slash command registered by a plugin. Returns false if unknown. */
  async runPluginCommand(name: string, args: string[]): Promise<boolean> {
    const entry = this.pluginCommands.get(name);
    if (!entry) return false;
    await entry.fn(args, entry.api);
    return true;
  }

  /** Names of all slash commands registered by plugins (for auto-complete). */
  listPluginCommands(): string[] {
    return [...this.pluginCommands.keys()];
  }

  /** System prompt = base + AGENTS/SYSTEM + enabled skills appended AFTER the stable prefix. */
  private currentSystem(): string[] {
    const sys = [...this.config.systemPrompt];
    if (this.config.verifyCommand) {
      sys.push(
        'A verify command is configured. After each write/edit, call the verify tool to ' +
          'check the build/tests; if it fails, fix the issue and re-verify (up to 3 times), ' +
          'then report the final result.',
      );
    }
    if (this.planMode) {
      sys.push(
        'Plan mode is ON: call the plan tool to present a plan and get approval before any changes. ' +
          'Only read-only tools are allowed until the plan is approved.',
      );
    }
    for (const name of this.enabledSkills) {
      const found = this.listSkills().find((s) => s.name === name);
      if (found) sys.push(`# Skill: ${name}\n${loadSkill(found.path)}`);
    }
    return sys;
  }

  /**
   * Export a session to a Markdown transcript. Defaults to the current
   * session and writes `<cwd>/transcript-<id>.md` unless outPath is given.
   */
  exportSession(id?: string, outPath?: string): { path?: string; error?: string } {
    const sessionId = id ?? this.sessionId;
    if (!sessionId) return { error: 'no session' };
    try {
      const md = exportMarkdown(this.store, sessionId);
      if (md === null) return { error: 'session not found' };
      const p = outPath ?? join(this.config.cwd, `transcript-${sessionId}.md`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, md);
      return { path: p };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  setModel(model: string): void {
    this.model = model;
  }

  /** Toggle plan mode for new runs (takes effect next turn). */
  setPlanMode(on: boolean): void {
    this.planMode = on;
  }

  isPlanMode(): boolean {
    return this.planMode;
  }

  // ---- Todos -------------------------------------------------------------------

  /** Current todo list (shared with the todo tool). */
  listTodos(): TodoItem[] {
    return this.todos;
  }

  private todosFile(sessionId: string): string {
    return join(this.todosDir, `${sessionId}.json`);
  }

  private loadTodos(sessionId: string): void {
    try {
      const raw = readFileSync(this.todosFile(sessionId), 'utf8');
      const arr: unknown = JSON.parse(raw);
      this.todos = Array.isArray(arr)
        ? arr.filter(
            (t): t is TodoItem =>
              !!t && typeof t === 'object' && typeof (t as TodoItem).text === 'string',
          )
        : [];
    } catch {
      this.todos = [];
    }
  }

  private saveTodos(): void {
    if (!this.sessionId) return;
    try {
      mkdirSync(this.todosDir, { recursive: true });
      writeFileSync(this.todosFile(this.sessionId), JSON.stringify(this.todos));
    } catch {
      /* ignore */
    }
  }

  private makeProvider(): Provider {
    return createDefaultProvider({ ...this.config.env, model: this.model });
  }

  /** Estimated context tokens for the current session history. */
  estimateContext(): number {
    const history = this.sessionId ? this.store.load(this.sessionId) : this.history;
    return estimateContextTokens(this.makeProvider(), history, { system: this.currentSystem() });
  }

  /** Manually compact the current session history, persisting the result. */
  async compact(): Promise<{ before: number; after: number; replaced: number } | null> {
    if (!this.sessionId) return null;
    const history = this.store.load(this.sessionId);
    if (history.length < 2) return null;
    const provider = this.makeProvider();
    const system = this.currentSystem();
    const before = estimateContextTokens(provider, history, { system });
    const result = await compactHistory(provider, history, {
      preserveRecentTokens: this.config.preserveRecentTokens,
      budgetTokens: this.config.contextBudget,
      system,
    });
    if (result.replaced === 0) return null;
    this.store.replace(this.sessionId, result.messages);
    this.history = result.messages;
    const after = estimateContextTokens(provider, result.messages, { system });
    return { before, after, replaced: result.replaced };
  }

  listSessions() {
    return this.store.list();
  }

  /** Switch to an existing session by id. Returns false if not found. */
  resume(id: string): boolean {
    const found = this.store.list().find((s) => s.id === id);
    if (!found) return false;
    this.sessionId = id;
    this.history = this.store.load(id);
    this.loadTodos(id);
    return true;
  }

  reset(): void {
    this.sessionId = undefined;
    this.history = [];
    this.todos = [];
  }

  // ---- Git checkpoints -------------------------------------------------------

  gitStatus(): string {
    return gitStatusOutput(this.config.cwd);
  }

  gitDiff(): string {
    return gitDiffOutput(this.config.cwd);
  }

  /** Stage everything and commit; returns the short id or a status string. */
  gitCommit(message: string): string {
    return runGitCommit(this.config.cwd, message);
  }

  /** Snapshot the worktree before agent changes; returns the sha or null. */
  checkpoint(sessionId = this.sessionId): string | null {
    if (!sessionId) return null;
    const ref = this.checkpointRef(sessionId);
    const sha = createCheckpoint(this.config.cwd, ref);
    if (!sha) return null;
    const stack = this.loadCheckpointStack(sessionId);
    stack.push(sha);
    this.saveCheckpointStack(sessionId, stack);
    return sha;
  }

  /** Restore the worktree to the most recent checkpoint; returns the sha or null. */
  rollback(sessionId = this.sessionId): string | null {
    if (!sessionId) return null;
    const stack = this.loadCheckpointStack(sessionId);
    const sha = stack.pop();
    if (!sha) return null;
    const ref = this.checkpointRef(sessionId);
    if (!restoreCheckpoint(this.config.cwd, sha)) {
      stack.push(sha);
      this.saveCheckpointStack(sessionId, stack);
      return null;
    }
    setCheckpoint(this.config.cwd, ref, stack[stack.length - 1] ?? null);
    this.saveCheckpointStack(sessionId, stack);
    return sha;
  }

  private checkpointRef(sessionId: string): string {
    return `refs/ringzero/checkpoints/${sessionId}`;
  }

  private checkpointFile(sessionId: string): string {
    return join(this.checkpointsDir, `${sessionId}.json`);
  }

  private loadCheckpointStack(sessionId: string): string[] {
    try {
      const raw = readFileSync(this.checkpointFile(sessionId), 'utf8');
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  private saveCheckpointStack(sessionId: string, stack: string[]): void {
    try {
      mkdirSync(this.checkpointsDir, { recursive: true });
      writeFileSync(this.checkpointFile(sessionId), JSON.stringify(stack));
    } catch {
      /* ignore */
    }
  }
}
