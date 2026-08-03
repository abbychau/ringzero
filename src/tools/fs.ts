import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname, relative, isAbsolute, extname } from 'node:path';
import type { Tool, ToolContext } from '../kernel/types.js';
import { isBinaryBuf } from './fsutil.js';
import { extractOutline, formatOutline } from './outline.js';

const MAX_READ = 5_000_000;
/** Files larger than this default to outline mode unless mode/range is given. */
const OUTLINE_AUTO_LINES = 300;

/**
 * Resolve a tool-supplied path against cwd, then (if a workspace root is
 * configured) reject paths outside it so fs tools can't touch arbitrary files.
 */
export function resolveFsPath(
  input: string,
  ctx: ToolContext,
): { ok: true; path: string } | { ok: false; error: string } {
  const p = resolve(ctx.cwd, input);
  if (!ctx.workspace) return { ok: true, path: p };
  const ws = resolve(ctx.workspace);
  const rel = relative(ws, p);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `path outside workspace (${ws}): ${p}` };
  }
  return { ok: true, path: p };
}

export function readFileTool(): Tool {
  return {
    definition: {
      name: 'read_file',
      description:
        'Read a text file (optionally a line range via start_line/end_line, 1-based inclusive). If path is a directory, lists its entries. Rejects binary files. Large files (>300 lines) return a symbol outline unless mode="full" or a range is given; mode="outline" forces outline.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute or relative path' },
          start_line: { type: 'number', description: 'first line to read (1-based)' },
          end_line: { type: 'number', description: 'last line to read (1-based, inclusive)' },
          mode: {
            type: 'string',
            enum: ['outline', 'full'],
            description: 'outline = symbols only; full = raw content',
          },
        },
        required: ['path'],
      },
    },
    async execute(input, ctx) {
      const r = resolveFsPath(String(input.path ?? ''), ctx);
      if (!r.ok) return `error: ${r.error}`;
      const p = r.path;
      if (!existsSync(p)) return `error: no such file: ${p}`;
      const st = statSync(p);
      if (st.isDirectory()) {
        return readdirSync(p)
          .map((n) => {
            let s;
            try {
              s = statSync(join(p, n));
            } catch {
              return n;
            }
            return n + (s.isDirectory() ? '/' : '');
          })
          .join('\n');
      }
      if (st.size > MAX_READ)
        return `error: file too large (${st.size} bytes); use grep or read a range`;
      const buf = readFileSync(p);
      if (isBinaryBuf(buf)) return `error: binary file (${basename(p)})`;
      const text = buf.toString('utf8');
      const start = input.start_line !== undefined ? Number(input.start_line) : undefined;
      const end = input.end_line !== undefined ? Number(input.end_line) : undefined;
      const lines = text.split(/\r?\n/);
      const mode =
        input.mode === 'outline' ? 'outline' : input.mode === 'full' ? 'full' : undefined;
      // Outline mode: explicit, or automatic for large files without a range.
      if (
        mode === 'outline' ||
        (mode === undefined &&
          start === undefined &&
          end === undefined &&
          lines.length > OUTLINE_AUTO_LINES)
      ) {
        const ext = extname(p).slice(1).toLowerCase();
        const symbols = extractOutline(text, ext);
        const outline = formatOutline(symbols);
        const hint =
          lines.length > OUTLINE_AUTO_LINES
            ? `pass mode:"full" or start_line/end_line to read content`
            : `pass mode:"full" to read content`;
        return `[${lines.length} lines; ${symbols.length} symbols — outline mode; ${hint}]\n${
          outline || '(no symbols detected)'
        }`;
      }
      if (start === undefined && end === undefined) return text;
      const s = Math.max(1, Math.floor(start ?? 1));
      const e = Math.min(lines.length, Math.floor(end ?? lines.length));
      if (s > e) return `error: start_line (${s}) > end_line (${e})`;
      return (
        lines
          .slice(s - 1, e)
          .map((l, i) => `${s + i}: ${l}`)
          .join('\n') + `\n[${lines.length} lines total; showing ${s}-${e}]`
      );
    },
  };
}

export function writeFileTool(): Tool {
  return {
    definition: {
      name: 'write_file',
      description:
        'Create or fully overwrite a file with the given content. Creates parent directories.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    async execute(input, ctx) {
      const r = resolveFsPath(String(input.path ?? ''), ctx);
      if (!r.ok) return `error: ${r.error}`;
      const p = r.path;
      const content = String(input.content ?? '');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
      return `wrote ${content.length} chars to ${p}`;
    },
  };
}

export function editFileTool(): Tool {
  return {
    definition: {
      name: 'edit_file',
      description:
        'Apply a targeted string replacement in a file (first occurrence, or all when replace_all=true). Prefer this over write_file to save tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async execute(input, ctx) {
      const r = resolveFsPath(String(input.path ?? ''), ctx);
      if (!r.ok) return `error: ${r.error}`;
      const p = r.path;
      if (!existsSync(p)) return `error: no such file: ${p}`;
      const oldS = String(input.old_string ?? '');
      const newS = String(input.new_string ?? '');
      if (!oldS) return 'error: old_string is empty';
      let content = readFileSync(p, 'utf8');
      const count = content.split(oldS).length - 1;
      if (count === 0) return `error: old_string not found in ${p}`;
      content =
        input.replace_all === true ? content.split(oldS).join(newS) : content.replace(oldS, newS);
      writeFileSync(p, content, 'utf8');
      return `replaced ${count} occurrence(s) in ${p}`;
    },
  };
}
