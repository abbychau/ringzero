/** list_dir + tree: zero-dep directory exploration for the agent. */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { Tool, ToolContext } from '../kernel/types.js';
import { IGNORE_DIRS } from './fsutil.js';

const MAX_ENTRIES = 200;
const MAX_TREE_LINES = 300;

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/** Resolve a directory, rejecting paths outside the workspace (if set). */
function resolveDir(
  input: string,
  ctx: ToolContext,
): { ok: true; dir: string; rel: string } | { ok: false; error: string } {
  const dir = resolve(ctx.cwd, input);
  if (!ctx.workspace) return { ok: true, dir, rel: relative(ctx.cwd, dir) || '.' };
  const ws = resolve(ctx.workspace);
  const rel = relative(ws, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `path outside workspace (${ws}): ${dir}` };
  }
  return { ok: true, dir, rel: relative(ctx.cwd, dir) || '.' };
}

export function listDirTool(): Tool {
  return {
    definition: {
      name: 'list_dir',
      description:
        'List a directory: one line per entry, dirs marked with /, files with size and mtime. Skips .git/node_modules/build/etc. Returns up to 200 entries.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'directory to list (default cwd)' },
        },
      },
    },
    async execute(input, ctx) {
      const r = resolveDir(input.path ? String(input.path) : '.', ctx);
      if (!r.ok) return `error: ${r.error}`;
      let names: string[];
      try {
        names = readdirSync(r.dir);
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      const entries: { name: string; dir: boolean; size: number; mtime: number }[] = [];
      for (const name of names) {
        if (IGNORE_DIRS.has(name)) continue;
        let st;
        try {
          st = statSync(join(r.dir, name));
        } catch {
          continue;
        }
        entries.push({
          name,
          dir: st.isDirectory(),
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      const out = entries
        .slice(0, MAX_ENTRIES)
        .map((e) => (e.dir ? `${e.name}/` : `${e.name}  ${fmtSize(e.size)}  ${fmtTime(e.mtime)}`));
      const extra = entries.length - MAX_ENTRIES;
      if (extra > 0) out.push(`… (+${extra} more)`);
      return out.length ? `list of ${r.rel}\n${out.join('\n')}` : `(empty) ${r.rel}`;
    },
  };
}

export function treeTool(): Tool {
  return {
    definition: {
      name: 'tree',
      description:
        'Show the project structure as a tree (directories and files, up to max_depth). Skips .git/node_modules/build/etc. Capped at 300 lines — use list_dir for a single directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'root directory (default cwd)' },
          max_depth: { type: 'number', description: 'depth limit, 1-8 (default 3)' },
        },
      },
    },
    async execute(input, ctx) {
      const r = resolveDir(input.path ? String(input.path) : '.', ctx);
      if (!r.ok) return `error: ${r.error}`;
      const maxDepth = Math.min(8, Math.max(1, Math.floor(Number(input.max_depth) || 3)));
      const lines: string[] = [`tree of ${r.rel}`];
      const visit = (dir: string, depth: number, prefix: string): void => {
        if (lines.length >= MAX_TREE_LINES) return;
        let names: string[];
        try {
          names = readdirSync(dir).filter((n) => !IGNORE_DIRS.has(n));
        } catch {
          return;
        }
        const items = names
          .map((n) => {
            let st;
            try {
              st = statSync(join(dir, n));
            } catch {
              return undefined;
            }
            return { name: n, dir: st.isDirectory() };
          })
          .filter((x): x is { name: string; dir: boolean } => x !== undefined)
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        items.forEach((item, i) => {
          if (lines.length >= MAX_TREE_LINES) return;
          const last = i === items.length - 1;
          lines.push(`${prefix}${last ? '\\-- ' : '|-- '}${item.name}${item.dir ? '/' : ''}`);
          if (item.dir && depth < maxDepth) {
            visit(join(dir, item.name), depth + 1, prefix + (last ? '    ' : '|   '));
          }
        });
      };
      visit(r.dir, 1, '');
      if (lines.length === 1) return `(empty) ${r.rel}`;
      if (lines.length >= MAX_TREE_LINES) lines.push('… [truncated at 300 lines]');
      return lines.join('\n');
    },
  };
}
