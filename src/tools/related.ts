/**
 * related_files tool — find importers of a file and files defining the same
 * symbols, so the agent can scope edits before changing shared code.
 */
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { Tool } from '../kernel/types.js';
import { resolveFsPath } from './fs.js';
import { getSymbolIndex } from './indexer.js';

const MAX_RESULTS = 10;
const MAX_SYMBOL_NAMES = 3;

export function relatedFilesTool(): Tool {
  return {
    definition: {
      name: 'related_files',
      description:
        'Find files related to a file: files that import it and files defining the same symbols. Call before editing to find code that will be affected.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute or relative path to a source file' },
        },
        required: ['path'],
      },
    },
    async execute(input, ctx) {
      const r = resolveFsPath(String(input.path ?? ''), ctx);
      if (!r.ok) return `error: ${r.error}`;
      const root = ctx.workspace ? resolve(ctx.workspace) : ctx.cwd;
      const rel = relative(root, r.path);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return `error: path outside workspace: ${r.path}`;
      }
      const idx = getSymbolIndex(root);
      const target = idx.files.get(rel);
      if (!target) return `error: ${rel} is not an indexable file (or not found)`;

      const targetBase = basename(rel, extname(rel));
      const targetParent = basename(dirname(rel));
      const targetKeys = targetBase === 'index' ? [targetParent, 'index'] : [targetBase];
      const targetNames = new Set(target.symbols.map((s) => s.name));

      // Importers first, then files sharing symbol names — deduped, insertion order.
      const reasons = new Map<string, string>();
      for (const [f, file] of idx.files) {
        if (f === rel) continue;
        if (file.imports.some((seg) => targetKeys.includes(seg))) {
          reasons.set(f, `imports ${targetKeys[0]}`);
        }
      }
      for (const name of targetNames) {
        for (const ref of idx.byName.get(name) ?? []) {
          if (ref.file === rel) continue;
          const prev = reasons.get(ref.file);
          if (prev === undefined) {
            reasons.set(ref.file, `same symbols: ${name}`);
          } else if (prev.startsWith('same symbols: ')) {
            const names = prev.slice('same symbols: '.length).split(', ');
            if (names.length < MAX_SYMBOL_NAMES) {
              reasons.set(ref.file, `same symbols: ${[...names, name].join(', ')}`);
            }
          }
        }
      }

      const n = target.symbols.length;
      const lines = [...reasons.entries()]
        .slice(0, MAX_RESULTS)
        .map(([f, why]) => `- ${f}  (${why})`);
      if (!lines.length) return `no related files for ${rel}`;
      return `related files for ${rel} (${n} symbol${n === 1 ? '' : 's'}):\n${lines.join('\n')}`;
    },
  };
}
