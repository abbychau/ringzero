import type { AppConfig } from '../config/config.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionStore } from '../session/store.js';
import { Agent } from '../kernel/agent.js';
import { defaultTools } from '../tools/index.js';
import { createTaskTool } from '../tools/task.js';
import { createDefaultProvider } from '../providers/registry.js';
import { listSkills, loadSkill, type SkillInfo } from '../skills/loader.js';
import {
  loadPlugins,
  type PluginApi,
  type CommandFn,
  type ToolBeforeInput,
  type ToolBeforeResult,
} from '../plugin/index.js';
import { createMcpTools } from '../mcp/index.js';
import { loadMcpConfig } from '../mcp/config.js';
import { PermissionGate, type AskResponse } from '../permission/gate.js';
import { compactHistory, estimateContextTokens } from '../kernel/context.js';
import type { Provider, SessionMessage, Tool } from '../kernel/types.js';

export interface RunnerOptions {
  sessionId?: string;
  model?: string;
  /** Interactive ask handler. Defaults to deny (safe for scripts). */
  ask?: (prompt: string) => Promise<AskResponse>;
}

/** Wires config + store + tools + provider into a runnable Agent, per session. */
export class Runner {
  readonly config: AppConfig;
  readonly store: SessionStore;
  readonly gate: PermissionGate;
  sessionId?: string;
  model: string;
  private history: SessionMessage[];
  private enabledSkills: string[] = [];
  private mcpTools: Tool[] = [];
  private mcpInited = false;
  private pluginTools: Tool[] = [];
  private pluginCommands = new Map<string, { fn: CommandFn; api: PluginApi }>();
  private pluginToolHooks: ((i: ToolBeforeInput) => Promise<ToolBeforeResult | void>)[] = [];
  private skillTools = new Map<string, Tool[]>();
  /** Set by the UI to receive plugin say() output. */
  pluginSay?: (text: string) => void;

  constructor(config: AppConfig, opts: RunnerOptions = {}) {
    this.config = config;
    this.store = new SessionStore(config.sessionsDir);
    this.sessionId = opts.sessionId;
    this.history = this.sessionId ? this.store.load(this.sessionId) : [];
    this.model = opts.model ?? config.env.model;
    this.gate = new PermissionGate({
      rules: config.permissions,
      ask: opts.ask ?? (async () => 'no' as const),
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
      createTaskTool({
        provider,
        permission: this.gate,
        cwd: this.config.cwd,
        home: this.config.home,
        contextBudget: this.config.contextBudget,
        preserveRecentTokens: this.config.preserveRecentTokens,
      }),
      ...[...this.skillTools.values()].flat(),
      ...this.pluginTools,
      ...this.mcpTools,
    ];
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
      signal,
      onBeforeTool: async (name, args) => {
        let current = args;
        for (const hook of this.pluginToolHooks) {
          const r = await hook({ name, args: current });
          if (r?.allowed === false) return { allowed: false };
          if (r?.args) current = r.args;
        }
        return { args: current };
      },
      onMessage: (m) => {
        this.ensureSession(m.content.slice(0, 48) || 'session');
        this.store.append(this.sessionId!, m);
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
    for (const name of this.enabledSkills) {
      const found = this.listSkills().find((s) => s.name === name);
      if (found) sys.push(`# Skill: ${name}\n${loadSkill(found.path)}`);
    }
    return sys;
  }

  setModel(model: string): void {
    this.model = model;
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
    return true;
  }

  reset(): void {
    this.sessionId = undefined;
    this.history = [];
  }
}
