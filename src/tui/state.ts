/** Pure state + reducer for the Ink TUI (testable without a TTY). */
import { wrapText, truncateWidth } from './term.js';

export type Block =
  | { tag: 'user'; text: string }
  | { tag: 'assistant'; text: string }
  | { tag: 'thinking'; text: string; expanded: boolean }
  | { tag: 'tool'; name: string; args: string; output?: string; done: boolean; expanded: boolean }
  | { tag: 'sys'; text: string };

export type AskResponse = 'yes' | 'no' | 'always' | 'never';

export interface Option {
  label: string;
  value: string;
  hint?: string;
}

export interface PaletteItem {
  label: string;
  hint?: string;
  run: () => void;
}

export type Modal =
  | { kind: 'confirm'; prompt: string; value: string; resolve: (a: AskResponse) => void }
  | { kind: 'input'; prompt: string; value: string; resolve: (v: string | null) => void }
  | {
      kind: 'select';
      title: string;
      options: Option[];
      index: number;
      resolve: (v: string | null) => void;
    }
  | { kind: 'palette'; query: string; items: PaletteItem[]; index: number }
  | { kind: 'search'; query: string; index: number; resolve: (v: string | null) => void };

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface State {
  blocks: Block[];
  input: string;
  cursor: number;
  history: string[];
  histIdx: number;
  /** Highlighted index in the / auto-complete dropdown. */
  suggestIdx: number;
  running: boolean;
  status: string;
  usage?: Usage;
  /** Cumulative token usage across all turns of this session. */
  totalUsage?: Usage;
  /** Last estimated context tokens for the current session (from Runner). */
  ctxTokens?: number;
  scroll: number;
  modal?: Modal;
  model: string;
}

export type Action =
  | { type: 'push'; block: Block }
  | { type: 'appendAssistant'; delta: string }
  | { type: 'appendThinking'; delta: string }
  | { type: 'setToolOutput'; output: string; done: boolean; name?: string }
  | { type: 'toggleTool'; index?: number }
  | { type: 'input'; text: string; cursor: number }
  | { type: 'submit'; text: string }
  | { type: 'runStart' }
  | { type: 'runEnd'; usage?: Usage; status: string; ctx?: number }
  | { type: 'status'; text: string }
  | { type: 'scroll'; delta: number }
  | { type: 'suggestIdx'; index: number }
  | { type: 'setModal'; modal?: Modal }
  | { type: 'setModel'; model: string }
  | { type: 'history'; index: number }
  | { type: 'clear' };

export function initial(model: string): State {
  return {
    blocks: [],
    input: '',
    cursor: 0,
    history: [],
    histIdx: 0,
    suggestIdx: 0,
    running: false,
    status: 'ready',
    scroll: 0,
    model,
  };
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'push':
      return { ...s, blocks: [...s.blocks, a.block], scroll: 0 };
    case 'appendAssistant': {
      const blocks = [...s.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.tag === 'assistant') {
        blocks[blocks.length - 1] = { ...last, text: last.text + a.delta };
      } else {
        blocks.push({ tag: 'assistant', text: a.delta });
      }
      return { ...s, blocks, scroll: 0 };
    }
    case 'appendThinking': {
      const blocks = [...s.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.tag === 'thinking') {
        blocks[blocks.length - 1] = { ...last, text: last.text + a.delta };
      } else {
        blocks.push({ tag: 'thinking', text: a.delta, expanded: false });
      }
      return { ...s, blocks, scroll: 0 };
    }
    case 'setToolOutput': {
      const blocks = [...s.blocks];
      // Match by name (last matching, not-yet-done block) so concurrent tool calls
      // render each result on the right row. Falls back to the last tool block.
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.tag === 'tool' && (a.name === undefined || (b.name === a.name && !b.done))) {
          blocks[i] = { ...b, output: a.output, done: a.done };
          break;
        }
      }
      return { ...s, blocks, scroll: 0 };
    }
    case 'toggleTool': {
      const blocks = [...s.blocks];
      const idx = a.index;
      if (idx !== undefined && blocks[idx]?.tag === 'tool' && blocks[idx]!.output) {
        blocks[idx] = {
          ...(blocks[idx] as Extract<Block, { tag: 'tool' }>),
          expanded: !(blocks[idx] as Extract<Block, { tag: 'tool' }>).expanded,
        };
        return { ...s, blocks };
      }
      if (idx !== undefined && blocks[idx]?.tag === 'thinking') {
        blocks[idx] = {
          ...(blocks[idx] as Extract<Block, { tag: 'thinking' }>),
          expanded: !(blocks[idx] as Extract<Block, { tag: 'thinking' }>).expanded,
        };
        return { ...s, blocks };
      }
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.tag === 'tool' && b.output) {
          blocks[i] = { ...b, expanded: !b.expanded };
          break;
        }
      }
      return { ...s, blocks };
    }
    case 'input':
      return { ...s, input: a.text, cursor: a.cursor, suggestIdx: 0 };
    case 'suggestIdx':
      return { ...s, suggestIdx: a.index };
    case 'runStart':
      return { ...s, running: true, status: 'running…', scroll: 0 };
    case 'runEnd':
      return {
        ...s,
        running: false,
        usage: a.usage,
        status: a.status,
        ctxTokens: a.ctx,
        totalUsage: mergeUsage(s.totalUsage, a.usage),
      };
    case 'status':
      return { ...s, status: a.text };
    case 'scroll':
      return { ...s, scroll: Math.max(0, s.scroll + a.delta) };
    case 'setModal':
      return { ...s, modal: a.modal };
    case 'setModel':
      return { ...s, model: a.model };
    case 'submit': {
      const text = a.text.trim();
      const history =
        text && text !== s.history[s.history.length - 1] ? [...s.history, text] : s.history;
      return {
        ...s,
        input: '',
        cursor: 0,
        history,
        histIdx: history.length,
        scroll: 0,
        suggestIdx: 0,
      };
    }
    case 'history': {
      const h = s.history;
      if (!h.length) return s;
      const idx = Math.min(h.length, Math.max(0, a.index));
      const input = idx < h.length ? h[idx]! : '';
      return { ...s, input, cursor: input.length, histIdx: idx };
    }
    case 'clear':
      return { ...s, blocks: [], scroll: 0, modal: undefined, suggestIdx: 0 };
    default:
      return s;
  }
}

/** Format usage for the status line. */
export function fmtUsage(u?: Usage): string {
  if (!u) return 'no usage data';
  return `in=${u.input} out=${u.output}${u.cacheRead ? ` cached=${u.cacheRead}` : ''}${
    u.cacheWrite ? ` cw=${u.cacheWrite}` : ''
  }`;
}

/** Accumulate two usage snapshots (zero cache fields are omitted). */
export function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!b) return a;
  if (!a) return b;
  const cacheRead = (a.cacheRead ?? 0) + (b.cacheRead ?? 0);
  const cacheWrite = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

/** Compact session total for the status line. */
export function fmtSession(u: Usage): string {
  return `Σ in=${u.input} out=${u.output}${u.cacheRead ? ` cached=${u.cacheRead}` : ''}`;
}

/** 0-based line index and char column (within that line) for a cursor offset. */
export function inputLineCol(value: string, cursor: number): { line: number; col: number } {
  const before = value.slice(0, cursor);
  const nl = before.lastIndexOf('\n');
  const line = before.split('\n').length - 1;
  return { line, col: nl === -1 ? before.length : before.length - nl - 1 };
}

/** Number of rendered lines for the input (at least 1). */
export function inputLines(value: string): number {
  return value ? value.split('\n').length : 1;
}

/** Built-in slash commands (for the / auto-complete dropdown). */
export function slashCommands(): string[] {
  return [
    'help',
    'usage',
    'context',
    'model',
    'compact',
    'permission',
    'skills',
    'sessions',
    'resume',
    'new',
    'diff',
    'status',
    'checkpoint',
    'rollback',
    'exit',
  ];
}

/** Commands matching the current input ("/" → all; else prefix filter). */
export function slashMatches(input: string, extra: string[] = []): string[] {
  if (!input.startsWith('/')) return [];
  const q = input.slice(1).toLowerCase();
  const base = slashCommands();
  const all = [...base, ...extra.filter((c) => !base.includes(c))];
  if (!q) return all;
  return all.filter((c) => c.toLowerCase().startsWith(q));
}

const TOOL_PREVIEW_LINES = 3;
const THINKING_PREVIEW_CHARS = 160;
const PREFIX: Record<Block['tag'], string> = {
  user: '› ',
  assistant: '',
  thinking: '💭 ',
  tool: '⛏ ',
  sys: '— ',
};

export interface Row {
  blockIdx: number;
  text: string;
}

function toolLines(b: Extract<Block, { tag: 'tool' }>): string[] {
  const head = `⛏ ${b.name} ${truncateWidth(b.args.replace(/\s+/g, ' '), 40)}`;
  if (!b.output) return [head + (b.done ? '' : ' …')];
  if (!b.expanded) {
    const lines = b.output.split('\n');
    const preview = lines.slice(0, TOOL_PREVIEW_LINES);
    const more =
      lines.length > TOOL_PREVIEW_LINES
        ? `  …[+${lines.length - TOOL_PREVIEW_LINES} lines · Ctrl+O/mouse]`
        : '';
    return [head, ...preview, ...(more ? [more] : [])];
  }
  return [head, ...b.output.split('\n')];
}

function thinkingLines(b: Extract<Block, { tag: 'thinking' }>): string[] {
  if (!b.expanded) {
    const preview = truncateWidth(b.text.replace(/\s+/g, ' '), THINKING_PREVIEW_CHARS);
    const more =
      b.text.length > THINKING_PREVIEW_CHARS ? ` …[${b.text.length} chars · Ctrl+O/mouse]` : '';
    return [preview + more];
  }
  return [b.text];
}

/** Layout blocks into display rows (each row fits `width`), with block index mapping. */
export function layoutBlocks(blocks: Block[], width: number): Row[] {
  const rows: Row[] = [];
  blocks.forEach((b, blockIdx) => {
    const lines =
      b.tag === 'tool'
        ? toolLines(b as Extract<Block, { tag: 'tool' }>)
        : b.tag === 'thinking'
          ? thinkingLines(b as Extract<Block, { tag: 'thinking' }>)
          : [PREFIX[b.tag] + b.text];
    for (const line of lines) {
      for (const wrapped of wrapText(line, Math.max(1, width))) {
        rows.push({ blockIdx, text: wrapped });
      }
    }
  });
  return rows;
}

/** Visible window given scroll (0 = bottom). Returns { start, visible, maxScroll }. */
export function windowRows(
  rows: Row[],
  height: number,
  scroll: number,
): { start: number; visible: Row[]; maxScroll: number } {
  const maxScroll = Math.max(0, rows.length - height);
  const sc = Math.min(scroll, maxScroll);
  const start = Math.max(0, rows.length - height - sc);
  return { start, visible: rows.slice(start, start + height), maxScroll };
}
