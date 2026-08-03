import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tool } from '../kernel/types.js';

export interface ToolBeforeInput {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolBeforeResult {
  allowed?: boolean;
  args?: Record<string, unknown>;
}

export type CommandFn = (args: string[], api: PluginApi) => Promise<void> | void;
export type ToolBeforeHook = (
  input: ToolBeforeInput,
) => Promise<ToolBeforeResult | void> | ToolBeforeResult | void;

/** API handed to a plugin's init(). */
export interface PluginApi {
  readonly name: string;
  registerTool(tool: Tool): void;
  registerCommand(name: string, fn: CommandFn): void;
  onToolBefore(fn: ToolBeforeHook): void;
  /** Push a line into the active UI transcript (falls back to console.log). */
  say(text: string): void;
}

export interface LoadedPlugin {
  name: string;
  path: string;
  init(api: PluginApi): Promise<void> | void;
}

/** Load single-file ESM/CJS plugins from dirs (default export = init function). */
export async function loadPlugins(dirs: string[]): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.(mjs|js|cjs)$/.test(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) continue;
      try {
        const mod = await import(pathToFileURL(p).href);
        const init = mod.default ?? mod.init;
        if (typeof init !== 'function') continue;
        out.push({ name: name.replace(/\.(mjs|js|cjs)$/, ''), path: p, init });
      } catch (e) {
        console.error(
          `[plugin] failed to load ${name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  return out;
}
