/**
 * Zero-dep symbol outline extraction — token-efficient read_file mode.
 * Regex-based: good enough for navigation, no parser needed.
 */

export interface OutlineSymbol {
  kind: string;
  name: string;
  /** 1-based line number. */
  line: number;
}

interface OutlineRule {
  exts: string[];
  re: RegExp;
  kind: string;
}

const RULES: OutlineRule[] = [
  // TypeScript / JavaScript
  {
    exts: ['ts', 'tsx', 'mjs', 'js', 'jsx', 'cjs'],
    re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    kind: 'function',
  },
  {
    exts: ['ts', 'tsx', 'mjs', 'js', 'jsx', 'cjs'],
    re: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)/,
    kind: 'const',
  },
  {
    exts: ['ts', 'tsx', 'mjs', 'js', 'jsx', 'cjs'],
    re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    kind: 'class',
  },
  { exts: ['ts', 'tsx'], re: /^\s*(?:export\s+)?interface\s+(\w+)/, kind: 'interface' },
  { exts: ['ts', 'tsx'], re: /^\s*(?:export\s+)?type\s+(\w+)\s*=/, kind: 'type' },
  { exts: ['ts', 'tsx', 'mjs', 'js', 'jsx', 'cjs'], re: /^\s*import\b/, kind: 'import' },
  // Python
  { exts: ['py'], re: /^\s*(?:async\s+)?def\s+(\w+)/, kind: 'def' },
  { exts: ['py'], re: /^\s*class\s+(\w+)/, kind: 'class' },
  // Rust
  { exts: ['rs'], re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'fn' },
  { exts: ['rs'], re: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: 'struct' },
  { exts: ['rs'], re: /^\s*(?:pub\s+)?enum\s+(\w+)/, kind: 'enum' },
  { exts: ['rs'], re: /^\s*(?:pub\s+)?trait\s+(\w+)/, kind: 'trait' },
  { exts: ['rs'], re: /^\s*(?:pub\s+)?impl\b(?:\s*<[^>]*>)?(?:\s+(\w+))?/, kind: 'impl' },
  // Go
  { exts: ['go'], re: /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)/, kind: 'func' },
  { exts: ['go'], re: /^\s*type\s+(\w+)\s+(?:struct|interface)\b/, kind: 'type' },
  // C-like / Java / C# / Kotlin / Swift
  {
    exts: ['java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'kt', 'swift'],
    re: /^\s*(?:public|private|protected|internal|fileprivate)?\s*(?:abstract|final|sealed|static|open)?\s*(?:class|interface|struct|enum|protocol|extension)\s+(\w+)/,
    kind: 'type',
  },
];

export function extractOutline(text: string, ext?: string): OutlineSymbol[] {
  const rules = ext ? RULES.filter((r) => r.exts.includes(ext)) : RULES;
  const out: OutlineSymbol[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (m) {
        out.push({ kind: rule.kind, name: m[1] ?? '', line: i + 1 });
        break;
      }
    }
  }
  return out;
}

export const OUTLINE_MAX_SYMBOLS = 300;

/** Format an outline for the model (1 symbol per line, capped). */
export function formatOutline(symbols: OutlineSymbol[]): string {
  const capped = symbols.slice(0, OUTLINE_MAX_SYMBOLS);
  const lines = capped.map((s) => `${s.line}: ${s.kind} ${s.name}`);
  if (symbols.length > OUTLINE_MAX_SYMBOLS) {
    lines.push(`… (${symbols.length - OUTLINE_MAX_SYMBOLS} more symbols)`);
  }
  return lines.join('\n');
}
