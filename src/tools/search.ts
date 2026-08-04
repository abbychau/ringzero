import { readFileSync, statSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import type { Tool, ToolContext } from '../kernel/types.js';
import { globToRegExp, walkFiles, isBinaryBuf } from './fsutil.js';

const MAX_MATCHES = 200;

/** Resolve a search root, rejecting paths outside the workspace (if set). */
function resolveSearchRoot(
  input: string,
  ctx: ToolContext,
): { ok: true; root: string } | { ok: false; error: string } {
  const root = resolve(ctx.cwd, input);
  if (!ctx.workspace) return { ok: true, root };
  const ws = resolve(ctx.workspace);
  const rel = relative(ws, root);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `path outside workspace (${ws}): ${root}` };
  }
  return { ok: true, root };
}

export function grepTool(): Tool {
  return {
    definition: {
      name: 'grep',
      description:
        'Regex search file contents recursively (skips .git/node_modules/build). Returns `path:line: text` up to 200 matches.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'regular expression' },
          path: { type: 'string', description: 'directory to search (default cwd)' },
          include: { type: 'string', description: 'glob filter, e.g. *.ts' },
          files_only: {
            type: 'boolean',
            description: 'return only matching file paths (like grep -l)',
          },
        },
        required: ['pattern'],
      },
    },
    async execute(input, ctx) {
      const r = resolveSearchRoot(input.path ? String(input.path) : '.', ctx);
      if (!r.ok) return `error: ${r.error}`;
      const root = r.root;
      let re: RegExp;
      try {
        re = new RegExp(String(input.pattern ?? ''));
      } catch (e: any) {
        return `error: bad regex: ${e.message}`;
      }
      const include = input.include ? globToRegExp(String(input.include)) : undefined;
      const files = walkFiles(root).filter((f) => (include ? include.test(f) : true));
      const out: string[] = [];
      for (const f of files) {
        if (out.length >= MAX_MATCHES) break;
        const full = join(root, f);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.size > 2_000_000) continue;
        let buf;
        try {
          buf = readFileSync(full);
        } catch {
          continue;
        }
        if (isBinaryBuf(buf)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        if (input.files_only === true) {
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              out.push(f);
              break;
            }
          }
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${f}:${i + 1}: ${lines[i]}`);
            if (out.length >= MAX_MATCHES) break;
          }
        }
      }
      return out.length ? out.join('\n') : '(no matches)';
    },
  };
}

export function globTool(): Tool {
  return {
    definition: {
      name: 'glob',
      description:
        'List files matching a glob pattern (e.g. **/*.ts). Skips .git/node_modules/build.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'base directory (default cwd)' },
        },
        required: ['pattern'],
      },
    },
    async execute(input, ctx) {
      const r = resolveSearchRoot(input.path ? String(input.path) : '.', ctx);
      if (!r.ok) return `error: ${r.error}`;
      const root = r.root;
      const re = globToRegExp(String(input.pattern ?? ''));
      const files = walkFiles(root).filter((f) => re.test(f));
      return files.length ? files.join('\n') : '(no matches)';
    },
  };
}
