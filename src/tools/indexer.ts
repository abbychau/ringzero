/**
 * Zero-dep ctags-style symbol index for `related_files`.
 *
 * Indexes outline-supported files (see outline.ts) with their symbols and
 * normalized import specifiers. The index is cached per root and invalidated
 * by a signature of file sizes + mtimes, so repeated calls only pay for the
 * stat walk.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { walkFiles } from './fsutil.js';
import { extractOutline, outlineExts, type OutlineSymbol } from './outline.js';

export interface IndexedFile {
  path: string;
  symbols: OutlineSymbol[];
  /** Normalized module specifiers this file imports (e.g. './lib/util' → 'util'). */
  imports: string[];
}

export interface SymbolRef {
  file: string;
  line: number;
}

export interface SymbolIndex {
  root: string;
  files: Map<string, IndexedFile>;
  byName: Map<string, SymbolRef[]>;
}

const MAX_INDEX_FILE = 1_000_000;
const MAX_SYMBOLS_PER_FILE = 500;
/** Matches `from 'x'`, `import 'x'`, `require('x')`, `import('x')`. */
const IMPORT_RE = /(?:from|import|require)\s*(?:\(\s*)?['"]([^'"]+)['"]/g;

const cache = new Map<string, { sig: string; index: SymbolIndex }>();

interface FileMeta {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Reduce an import specifier to a comparable module name. */
function normalizeImport(spec: string): string {
  let p = spec.replace(/\\/g, '/').split(/[?#]/)[0]!;
  while (p.startsWith('./')) p = p.slice(2);
  const parts = p.split('/');
  let seg = parts[parts.length - 1]!;
  const dot = seg.lastIndexOf('.');
  if (dot > 0) seg = seg.slice(0, dot);
  // './lib' and './lib/index' both mean the `lib` module.
  if (seg === 'index' && parts.length > 1) seg = parts[parts.length - 2]!;
  return seg;
}

/** Index of all indexable files under root, cached until the tree changes. */
export function getSymbolIndex(root: string): SymbolIndex {
  const metas: FileMeta[] = [];
  const sigEntries: string[] = [];
  for (const f of walkFiles(root)) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(root, f));
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_INDEX_FILE) continue;
    if (!outlineExts().includes(extname(f).slice(1))) continue;
    metas.push({ path: f, size: st.size, mtimeMs: st.mtimeMs });
    sigEntries.push(`${f}:${st.size}:${st.mtimeMs}`);
  }
  const sig = sigEntries.join('|');
  const cached = cache.get(root);
  if (cached?.sig === sig) return cached.index;
  const index = buildIndex(root, metas);
  cache.set(root, { sig, index });
  return index;
}

function buildIndex(root: string, metas: FileMeta[]): SymbolIndex {
  const files = new Map<string, IndexedFile>();
  const byName = new Map<string, SymbolRef[]>();
  for (const m of metas) {
    let text: string;
    try {
      text = readFileSync(join(root, m.path), 'utf8');
    } catch {
      continue;
    }
    const symbols = extractOutline(text, extname(m.path).slice(1)).slice(0, MAX_SYMBOLS_PER_FILE);
    const imports: string[] = [];
    for (const match of text.matchAll(IMPORT_RE)) imports.push(normalizeImport(match[1]!));
    files.set(m.path, { path: m.path, symbols, imports });
    for (const s of symbols) {
      let refs = byName.get(s.name);
      if (!refs) byName.set(s.name, (refs = []));
      refs.push({ file: m.path, line: s.line });
    }
  }
  return { root, files, byName };
}
