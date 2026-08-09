/** Pure state + reducer for the Ink TUI (testable without a TTY). */
import { wrapText, truncateWidth, strWidth } from './term.js';
import type { TodoItem } from '../tools/todo.js';
import type { ImageInput, SessionMessage } from '../kernel/types.js';

export type Block =
  | { tag: 'user'; text: string }
  | { tag: 'assistant'; text: string }
  | { tag: 'thinking'; text: string; expanded: boolean }
  | {
      tag: 'tool';
      name: string;
      args: string;
      output?: string;
      done: boolean;
      expanded: boolean;
      /** Tool call id so parallel same-name calls get their own results. */
      callId?: string;
    }
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

/** How long a sidebar flash notice (e.g. "Copied") stays visible, ms. */
export const FLASH_MS = 1600;

export interface Selection {
  /**
   * Row space the indices refer to: transcript rows or sidebar text lines.
   * Absent means transcript (all current call sites set it explicitly).
   */
  pane?: 'transcript' | 'sidebar';
  /** Absolute row index into the pane's rows (survives scrolling). */
  anchorRow: number;
  /** Character index (not terminal columns) within the row. */
  anchorCol: number;
  headRow: number;
  headCol: number;
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
  /** Mouse wheel/click moved focus to the transcript: ↑/↓ scroll it instead of input history. */
  transcriptFocus: boolean;
  /** In-app text selection (drag or Shift+arrows); cleared on transcript changes. */
  selection?: Selection;
  modal?: Modal;
  model: string;
  /** Plan mode banner + gating (read-only until plan approved). */
  planMode: boolean;
  /** Yolo mode: all tools auto-allowed, no permission prompts. */
  yolo: boolean;
  /** Per-session todo list (from Runner). */
  todos: TodoItem[];
  /** Collapsed strip (1 line) vs full list. */
  todosExpanded: boolean;
  /** Image attached via /image; sent with the next submitted message. */
  pendingImage?: ImageInput;
  /** Transient toast shown in the sidebar (e.g. "Copied"); auto-cleared after FLASH_MS. */
  flash?: { text: string; at: number };
}

export type Action =
  | { type: 'push'; block: Block }
  | { type: 'appendAssistant'; delta: string }
  | { type: 'appendThinking'; delta: string }
  | { type: 'setToolOutput'; output: string; done: boolean; name?: string; callId?: string }
  | { type: 'toggleTool'; index?: number }
  | { type: 'input'; text: string; cursor: number }
  | { type: 'submit'; text: string }
  | { type: 'runStart' }
  | { type: 'runEnd'; usage?: Usage; status: string; ctx?: number }
  | { type: 'status'; text: string }
  | { type: 'scroll'; delta: number; maxScroll?: number }
  | { type: 'setTranscriptFocus'; focus: boolean }
  | { type: 'setSelection'; selection: Selection | undefined }
  | { type: 'suggestIdx'; index: number }
  | { type: 'setModal'; modal?: Modal }
  | { type: 'setModel'; model: string }
  | { type: 'setPlanMode'; planMode: boolean }
  | { type: 'setYolo'; yolo: boolean }
  | { type: 'setTodos'; todos: TodoItem[] }
  | { type: 'toggleTodos' }
  | { type: 'setImage'; image?: ImageInput }
  | { type: 'history'; index: number }
  | { type: 'flash'; text: string }
  | { type: 'clearFlash' }
  | { type: 'setBlocks'; blocks: Block[] }
  | { type: 'clear' };

export function initial(model: string, planMode = false, yolo = false): State {
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
    transcriptFocus: false,
    model,
    planMode,
    yolo,
    todos: [],
    todosExpanded: false,
  };
}

/**
 * Convert persisted session messages into transcript blocks, mirroring how
 * live agent events build blocks (assistant text, thinking, tool call+result
 * pairs). Used to replay a resumed session instead of starting with an empty
 * transcript.
 */
export function historyToBlocks(msgs: SessionMessage[]): Block[] {
  const blocks: Block[] = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m.content.trim()) blocks.push({ tag: 'user', text: m.content });
    } else if (m.role === 'assistant') {
      if (m.content.trim()) blocks.push({ tag: 'assistant', text: m.content });
      // Replayed tool calls are shown collapsed like live ones; their results
      // arrive as separate role:'tool' messages right after.
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ tag: 'tool', name: tc.name, args: tc.args, done: false, expanded: false });
      }
    } else if (m.role === 'tool') {
      // Match the pending tool block by name (last not-yet-done one), same as
      // the live `setToolOutput` reducer.
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b && b.tag === 'tool' && !b.done && b.name === m.toolName) {
          blocks[i] = { ...b, output: m.content, done: true };
          break;
        }
      }
    }
  }
  return blocks;
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    // New content only auto-scrolls to the bottom when the user is already
    // there (scroll === 0); if they scrolled up, keep their position instead
    // of yanking the view down.
    case 'push':
      return {
        ...s,
        blocks: [...s.blocks, a.block],
        scroll: s.scroll,
        transcriptFocus: false,
        selection: undefined,
      };
    case 'appendAssistant': {
      const blocks = [...s.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.tag === 'assistant') {
        blocks[blocks.length - 1] = { ...last, text: last.text + a.delta };
      } else {
        blocks.push({ tag: 'assistant', text: a.delta });
      }
      return { ...s, blocks, scroll: s.scroll, transcriptFocus: false, selection: undefined };
    }
    case 'appendThinking': {
      const blocks = [...s.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.tag === 'thinking') {
        blocks[blocks.length - 1] = { ...last, text: last.text + a.delta };
      } else {
        blocks.push({ tag: 'thinking', text: a.delta, expanded: false });
      }
      return { ...s, blocks, scroll: s.scroll, transcriptFocus: false, selection: undefined };
    }
    case 'setToolOutput': {
      const blocks = [...s.blocks];
      // Match by call id first (parallel same-name calls keep their own
      // results), then by name (last matching, not-yet-done block) for events
      // that predate call ids. Falls back to the last tool block.
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.tag !== 'tool' || b.done) continue;
        if (a.callId !== undefined) {
          if (b.callId === a.callId) {
            blocks[i] = { ...b, output: a.output, done: a.done };
            break;
          }
        } else if (a.name === undefined || b.name === a.name) {
          blocks[i] = { ...b, output: a.output, done: a.done };
          break;
        }
      }
      return { ...s, blocks, scroll: s.scroll, transcriptFocus: false, selection: undefined };
    }
    case 'toggleTool': {
      const blocks = [...s.blocks];
      const idx = a.index;
      if (idx !== undefined && blocks[idx]?.tag === 'tool' && blocks[idx]!.output) {
        blocks[idx] = {
          ...(blocks[idx] as Extract<Block, { tag: 'tool' }>),
          expanded: !(blocks[idx] as Extract<Block, { tag: 'tool' }>).expanded,
        };
        return { ...s, blocks, selection: undefined };
      }
      if (idx !== undefined && blocks[idx]?.tag === 'thinking') {
        blocks[idx] = {
          ...(blocks[idx] as Extract<Block, { tag: 'thinking' }>),
          expanded: !(blocks[idx] as Extract<Block, { tag: 'thinking' }>).expanded,
        };
        return { ...s, blocks, selection: undefined };
      }
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.tag === 'tool' && b.output) {
          blocks[i] = { ...b, expanded: !b.expanded };
          break;
        }
      }
      return { ...s, blocks, selection: undefined };
    }
    case 'input':
      return { ...s, input: a.text, cursor: a.cursor, suggestIdx: 0 };
    case 'suggestIdx':
      return { ...s, suggestIdx: a.index };
    case 'runStart':
      return {
        ...s,
        running: true,
        status: 'running…',
        scroll: 0,
        transcriptFocus: false,
        selection: undefined,
      };
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
      // Clamp both ends: 0 = bottom, maxScroll = top. Without the upper clamp
      // the state could grow past the available transcript and scrolling back
      // down took as many steps as were accumulated.
      return {
        ...s,
        scroll: Math.max(0, Math.min(s.scroll + a.delta, a.maxScroll ?? Number.POSITIVE_INFINITY)),
      };
    case 'setTranscriptFocus':
      return { ...s, transcriptFocus: a.focus };
    case 'setSelection':
      return { ...s, selection: a.selection };
    case 'setModal':
      return { ...s, modal: a.modal };
    case 'setModel':
      return { ...s, model: a.model };
    case 'setPlanMode':
      return { ...s, planMode: a.planMode };
    case 'setYolo':
      return { ...s, yolo: a.yolo };
    case 'setTodos':
      return { ...s, todos: a.todos };
    case 'toggleTodos':
      return { ...s, todosExpanded: !s.todosExpanded };
    case 'setImage':
      return { ...s, pendingImage: a.image };
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
        transcriptFocus: false,
        selection: undefined,
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
    case 'flash':
      return { ...s, flash: { text: a.text, at: Date.now() } };
    case 'clearFlash':
      return { ...s, flash: undefined };
    case 'setBlocks':
      // Bulk-load (e.g. resumed session transcript); jump to the bottom.
      return {
        ...s,
        blocks: a.blocks,
        scroll: 0,
        transcriptFocus: false,
        selection: undefined,
      };
    case 'clear':
      return {
        ...s,
        blocks: [],
        scroll: 0,
        transcriptFocus: false,
        selection: undefined,
        modal: undefined,
        suggestIdx: 0,
      };
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

/**
 * Number of RENDERED rows for the input (at least 1), including lines wrapped
 * at `width` columns. The ❯ prefix renders on line 0, so that line's text
 * starts 2 columns in. CJK/fullwidth chars count as 2 columns. The layout
 * must reserve exactly this many rows — underestimating lets Ink shrink the
 * transcript when the input wraps, cutting off its last rows.
 */
export function inputLines(value: string, width: number): number {
  const lines = value.split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const w = strWidth(lines[i]!) + (i === 0 ? 2 : 0);
    n += Math.max(1, Math.ceil(w / Math.max(1, width)));
  }
  return n;
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
    'commit',
    'checkpoint',
    'rollback',
    'plan',
    'todos',
    'tools',
    'yolo',
    'image',
    'export',
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
  user: '[user] ',
  assistant: '',
  thinking: '[thinking] ',
  tool: '[tool-call] ',
  sys: '[sys] ',
};

export interface Row {
  blockIdx: number;
  text: string;
}

function toolLines(b: Extract<Block, { tag: 'tool' }>): string[] {
  const head = `[tool-call] ${b.name} ${truncateWidth(b.args.replace(/\s+/g, ' '), 40)}`;
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

/**
 * Char range [start, end) covered by the selection on one row (absolute row
 * index, row length in chars), or null when the row is outside the selection.
 * End-exclusive; cols are char indices and clamp to the row length.
 */
export function selectionRange(
  sel: Selection,
  row: number,
  len: number,
): { start: number; end: number } | null {
  const topRow = Math.min(sel.anchorRow, sel.headRow);
  const bottomRow = Math.max(sel.anchorRow, sel.headRow);
  if (row < topRow || row > bottomRow) return null;
  const topCol = sel.anchorRow < sel.headRow ? sel.anchorCol : sel.headCol;
  const bottomCol = sel.anchorRow < sel.headRow ? sel.headCol : sel.anchorCol;
  if (row === topRow && row === bottomRow) {
    const start = Math.min(topCol, bottomCol, len);
    const end = Math.min(Math.max(topCol, bottomCol), len);
    return { start, end };
  }
  if (row === topRow) return { start: Math.min(topCol, len), end: len };
  if (row === bottomRow) return { start: 0, end: Math.min(bottomCol, len) };
  return { start: 0, end: len };
}

/** The selected text across rows (for Ctrl+Y copy), joined with newlines. */
export function selectionText(rows: Row[], sel: Selection): string {
  const topRow = Math.min(sel.anchorRow, sel.headRow);
  const bottomRow = Math.max(sel.anchorRow, sel.headRow);
  const out: string[] = [];
  for (let r = topRow; r <= bottomRow && r < rows.length; r++) {
    const range = selectionRange(sel, r, rows[r]!.text.length);
    out.push(range ? rows[r]!.text.slice(range.start, range.end) : '');
  }
  return out.join('\n');
}

/**
 * Shift+arrow keyboard selection: extend the selection head by `delta` rows,
 * or start one at `fromRow` when there is no selection yet. Keyboard selection
 * always operates on the transcript pane.
 */
export function shiftSelect(
  sel: Selection | undefined,
  total: number,
  fromRow: number,
  delta: number,
): Selection {
  const anchorRow = sel ? sel.anchorRow : fromRow;
  const anchorCol = sel ? sel.anchorCol : 0;
  const headRow = Math.max(0, Math.min(total - 1, (sel ? sel.headRow : fromRow) + delta));
  return { pane: 'transcript', anchorRow, anchorCol, headRow, headCol: sel ? sel.headCol : 0 };
}
