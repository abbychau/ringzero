import React from 'react';
import { Box, Text, useAnimation, useCursor } from 'ink';
import { strWidth, truncateWidth } from './term.js';
import {
  FLASH_MS,
  inputLineCol,
  fmtSession,
  selectionRange,
  type Block,
  type Option,
  type PaletteItem,
  type Selection,
  type State,
  type Usage,
} from './state.js';
import { estimateCost, fmtCost, cacheHitRate } from '../kernel/cost.js';

/** Fixed width of the metadata/hints sidebar (opencode-style right column). */
export const SIDEBAR_W = 24;

const TAG_STYLE: Record<Block['tag'], { color?: string; bold?: boolean; dim?: boolean }> = {
  user: { color: 'cyan' },
  assistant: {},
  thinking: { color: 'gray', dim: true },
  tool: { color: 'yellow', bold: true },
  sys: { color: 'magenta' },
};

export function TranscriptRow({
  block,
  text,
  sel,
}: {
  block: Block;
  text: string;
  /** Selected char range [start, end) on this row (inverse video). */
  sel?: { start: number; end: number };
}): React.JSX.Element {
  const s = TAG_STYLE[block.tag] ?? {};
  // wrap="truncate": rows are pre-wrapped to the column width, so this only
  // ever cuts when the terminal disagrees on a rare glyph's width — wrapping
  // instead would push the row to two lines and overflow the frame.
  if (!sel || sel.end <= sel.start) {
    return (
      <Text color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate">
        {text}
      </Text>
    );
  }
  return (
    <Text color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate">
      {text.slice(0, sel.start)}
      <Text inverse>{text.slice(sel.start, sel.end)}</Text>
      {text.slice(sel.end)}
    </Text>
  );
}

function Spinner(): React.JSX.Element {
  // 160ms instead of 80ms: full-frame re-renders on every tick are the
  // heaviest write load the TUI produces while streaming; on slower consoles
  // (and under the compiled binary) aggressive repaints can garble the frame.
  const { frame } = useAnimation({ interval: 160 });
  const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  return <Text color="cyan">{chars[frame % chars.length]!}</Text>;
}

export function StatusBar({
  state,
  total = 0,
  visible = 0,
  budget,
  session,
}: {
  state: State;
  total?: number;
  visible?: number;
  budget?: number;
  session?: Usage;
}): React.JSX.Element {
  const sc = state.scroll > 0 ? `  · ↑${state.scroll} ${visible}/${total}` : '';
  const focus = state.transcriptFocus ? '  · ↑/↓ scroll · Esc to input' : '';
  const selHint = state.selection ? '  · Ctrl+Y copy · Esc clear' : '';
  const ctx =
    state.ctxTokens !== undefined
      ? `  · ctx≈${(state.ctxTokens / 1000).toFixed(1)}k${budget ? `/${Math.round(budget / 1000)}k` : ''}`
      : '';
  const ses = session
    ? `  · ${fmtSession(session)} ≈${fmtCost(estimateCost(state.model, session))}`
    : '';
  // Yolo badge is a separate colored element; status text truncates tighter to
  // leave room for it.
  const statusText = truncateWidth(state.status + sc + focus + selHint + ctx + ses, 92);
  return (
    <Box>
      {state.running ? <Spinner /> : <Text dimColor>●</Text>}
      {state.yolo ? <Text color="red"> YOLO</Text> : null}
      <Text dimColor> {statusText}</Text>
    </Box>
  );
}

function fmtBudget(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  return `${Math.round(n / 1000)}k`;
}

interface SidebarRow {
  text?: string;
  color?: 'yellow' | 'red' | 'cyan' | 'green';
  dim?: boolean;
  bold?: boolean;
  /** Status row: live ●/spinner prefix, kept at the bottom of the sidebar. */
  spinner?: boolean;
}

/**
 * Builds the sidebar's rendered rows (styles + padding) so the same content is
 * used for drawing and for the text-based selection model.
 */
function sidebarContent(
  state: State,
  model: string,
  sessionId: string | undefined,
  budget: number | undefined,
  cwdName: string,
  total: number,
  visible: number,
  width: number,
  height: number,
): { visibleRows: SidebarRow[]; avail: number; contentW: number } {
  const contentW = width - 2; // '│ ' separator + content
  const rows: SidebarRow[] = [
    { text: `RingZero · ${cwdName}`, bold: true },
    { text: '', dim: true },
    { text: model, color: 'cyan', bold: true },
    ...(sessionId ? [{ text: `${sessionId.slice(0, 20)}`, dim: true }] : []),
    ...(state.flash && Date.now() - state.flash.at < FLASH_MS
      ? [{ text: `[ok] ${state.flash.text}`, color: 'green' as const, bold: true }]
      : []),
  ];
  if (state.planMode || state.yolo || state.pendingImage) {
    rows.push({ text: '' });
    if (state.planMode) rows.push({ text: '[plan] mode', color: 'yellow' });
    if (state.yolo) rows.push({ text: '[yolo] auto-allow', color: 'red' });
    if (state.pendingImage) rows.push({ text: '[img] attached', color: 'cyan' });
  }
  if (state.ctxTokens !== undefined) {
    rows.push({ text: '' });
    const pct = Math.min(1, Math.max(0, state.ctxTokens / Math.max(1, budget ?? 0)));
    const fill = Math.round(pct * contentW);
    rows.push({
      text: `ctx ${(state.ctxTokens / 1000).toFixed(1)}k / ${budget !== undefined ? fmtBudget(budget) : '?'}`,
      dim: true,
    });
    // ASCII bar (not █░): block elements are ambiguous-width and some
    // terminals render them 2 columns wide, which overflows the sidebar.
    rows.push({
      text: '#'.repeat(fill) + '-'.repeat(Math.max(0, contentW - fill)),
      dim: true,
    });
  }
  const usage = state.usage;
  const totalUsage = state.totalUsage;
  if (usage || totalUsage) {
    rows.push({ text: '' });
    rows.push({ text: 'Token Flow (in · out)', dim: true });
    if (usage) rows.push({ text: ` Last: ${usage.input} · ${usage.output}`, dim: true });
    if (totalUsage) {
      rows.push({ text: `Total: ${totalUsage.input} · ${totalUsage.output}`, dim: true });
      rows.push({
        text: `${Math.round(cacheHitRate(totalUsage) * 100)}% cached · ≈${fmtCost(estimateCost(model, totalUsage))}`,
        dim: true,
      });
    }
  }
  // Status area pinned at the bottom of the sidebar: the live ●/spinner, the
  // status text, the scroll hint and the transcript-focus hint each on their
  // own row.
  const statusRows: SidebarRow[] = [
    { text: '', dim: true },
    { text: state.status, dim: true, spinner: true },
  ];
  if (state.scroll > 0)
    statusRows.push({ text: `↑${state.scroll} ${visible}/${total}`, dim: true });
  if (state.transcriptFocus) {
    statusRows.push({ text: 'Esc to input', dim: true });
  }

  const avail = Math.max(1, height);
  // Status rows stay pinned at the bottom; body rows are trimmed from the tail
  // when there isn't enough room.
  const nStatus = Math.min(statusRows.length, avail);
  const body = rows.slice(0, Math.max(0, avail - nStatus));
  const visibleRows = [...body, ...statusRows.slice(0, nStatus)].slice(0, avail);
  return { visibleRows, avail, contentW };
}

/**
 * The sidebar's selectable text lines: one entry per rendered content row
 * (visible rows first, then padding empties), matching the box's interior
 * height. Used by the selection model (mouse mapping + copy).
 */
export function sidebarTextLines(
  state: State,
  model: string,
  sessionId: string | undefined,
  budget: number | undefined,
  cwdName: string,
  total: number,
  visible: number,
  width = SIDEBAR_W,
  height: number,
): string[] {
  if (height < 3) return [];
  const { visibleRows, avail, contentW } = sidebarContent(
    state,
    model,
    sessionId,
    budget,
    cwdName,
    total,
    visible,
    width,
    height,
  );
  const pad = Math.max(0, avail - visibleRows.length);
  const lines = visibleRows.map((r) =>
    truncateWidth(r.text ?? '', r.spinner ? contentW - 2 : contentW),
  );
  return [...lines, ...Array.from({ length: pad }, () => '')];
}

export function Sidebar({
  state,
  model,
  sessionId,
  budget,
  height,
  cwdName,
  total = 0,
  visible = 0,
  width = SIDEBAR_W,
  selection,
}: {
  state: State;
  model: string;
  sessionId?: string;
  budget?: number;
  height: number;
  cwdName: string;
  total?: number;
  visible?: number;
  width?: number;
  /** Active selection confined to this pane (rows index into sidebarTextLines). */
  selection?: Selection;
}): React.JSX.Element | null {
  if (height < 3) return null;
  const { visibleRows, avail, contentW } = sidebarContent(
    state,
    model,
    sessionId,
    budget,
    cwdName,
    total,
    visible,
    width,
    height,
  );
  const pad = Math.max(0, avail - visibleRows.length);
  const sel = selection && selection.pane === 'sidebar' ? selection : undefined;
  return (
    <Box flexDirection="column" width={width} height={height}>
      {visibleRows.map((r, i) => {
        const limit = r.spinner ? contentW - 2 : contentW;
        const text = truncateWidth(r.text ?? '', limit);
        const range = sel ? selectionRange(sel, i, text.length) : null;
        let inner: React.ReactNode = text;
        if (range && range.end > range.start) {
          inner = (
            <>
              {text.slice(0, range.start)}
              <Text inverse>{text.slice(range.start, range.end)}</Text>
              {text.slice(range.end)}
            </>
          );
        }
        const padW = Math.max(0, limit - strWidth(text));
        return r.spinner ? (
          <Text key={i} dimColor wrap="truncate">
            {'│ '}
            {state.running ? <Spinner /> : <Text dimColor>●</Text>} {inner}
            {' '.repeat(padW)}
          </Text>
        ) : (
          // The separator is its own dim Text so the content's closing codes
          // (e.g. SGR 22 resets both bold and dim) can't un-dim it. wrap
          // truncate on the content only: a glyph the terminal renders wider
          // than string-width (ambiguous block/emoji chars) would otherwise
          // wrap the row and break the sidebar.
          <Box key={i} flexDirection="row">
            <Text dimColor>{'│ '}</Text>
            <Text color={r.color} dimColor={r.dim} bold={r.bold} wrap="truncate">
              {inner}
              {' '.repeat(padW)}
            </Text>
          </Box>
        );
      })}
      {/* Pad to the full height: the sidebar column must render exactly
          `height` rows or the frame merge with the transcript column
          misaligns (this column's rows vanish). */}
      {Array.from({ length: pad }, (_, i) => (
        <Text key={`p${i}`} dimColor>
          {'│' + ' '.repeat(width - 1)}
        </Text>
      ))}
    </Box>
  );
}

export function PromptInput({
  value,
  cursor,
  height,
  width,
  disabled,
}: {
  value: string;
  cursor: number;
  height: number;
  width: number;
  disabled?: boolean;
}): React.JSX.Element {
  const { setCursorPosition } = useCursor();
  const prefix = '❯ ';
  const lines = value.split('\n');
  const { line, col } = inputLineCol(value, cursor);
  // Rendered rows per input line: Ink wraps each at `width` columns, and the
  // ❯ prefix takes 2 columns of the first line. CJK/fullwidth count as 2 via
  // strWidth, matching how the terminal actually lays the text out.
  const rowsOf = (i: number): number =>
    Math.max(1, Math.ceil((strWidth(lines[i] ?? '') + (i === 0 ? 2 : 0)) / Math.max(1, width)));
  const totalRows = lines.reduce((n, _, i) => n + rowsOf(i), 0);
  let rowsBefore = 0;
  for (let i = 0; i < line; i++) rowsBefore += rowsOf(i);
  // Display width up to the cursor within the CURRENT line (prefix on line 0).
  const colWidth = strWidth((line === 0 ? prefix : '') + (lines[line]?.slice(0, col) ?? ''));
  // Column within the wrapped row the cursor is on; row counted from the top
  // of the frame (our app is fullscreen, so Ink's cursor y is 1-based rows).
  const x = colWidth % Math.max(1, width);
  const y = height - totalRows + rowsBefore + Math.floor(colWidth / Math.max(1, width)) + 1;
  setCursorPosition({ x, y });
  return (
    <Box flexDirection="column">
      {lines.map((ln, i) => (
        <Text key={i} dimColor={disabled}>
          {i === 0 ? <Text color="green">{prefix}</Text> : null}
          {ln}
        </Text>
      ))}
    </Box>
  );
}

export function ConfirmModal({ prompt }: { prompt: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color="yellow">{truncateWidth(prompt, 110)}</Text>
      <Text dimColor> [y]es [n]o [a]lways ne[v]er</Text>
    </Box>
  );
}

export function InputModal({
  prompt,
  value,
}: {
  prompt: string;
  value: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color="yellow">{prompt}</Text>
      <Text>
        {' > '}
        {value}
      </Text>
    </Box>
  );
}

export function SelectModal({
  title,
  options,
  index,
}: {
  title: string;
  options: Option[];
  index: number;
}): React.JSX.Element {
  // Window around the selected index so long lists (e.g. /tools) fit any
  // terminal height; the selection always stays in view.
  const WINDOW = 10;
  const start = Math.max(0, Math.min(index - Math.floor(WINDOW / 2), options.length - WINDOW));
  const shown = options.slice(start, start + WINDOW);
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {start > 0 ? <Text dimColor>… {start} more above</Text> : null}
      {shown.map((o, i) => {
        const realIndex = start + i;
        return (
          <Text
            key={o.value}
            color={realIndex === index ? 'cyan' : undefined}
            inverse={realIndex === index}
          >
            {realIndex === index ? '▸ ' : '  '}
            {truncateWidth(o.label, 60)}
            {o.hint ? <Text dimColor> {o.hint}</Text> : null}
          </Text>
        );
      })}
      {options.length - start - shown.length > 0 ? (
        <Text dimColor>… {options.length - start - shown.length} more below</Text>
      ) : null}
    </Box>
  );
}

export function SlashSuggest({
  items,
  index,
}: {
  items: string[];
  index: number;
}): React.JSX.Element {
  const shown = items.slice(0, 8);
  return (
    <Box flexDirection="column">
      {shown.map((c, i) => (
        <Text key={c} color={i === index ? 'cyan' : undefined} inverse={i === index}>
          {i === index ? '▸ ' : '  '}/<Text dimColor={i !== index}>{c}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function SearchModal({
  query,
  matches,
  index,
}: {
  query: string;
  matches: string[];
  index: number;
}): React.JSX.Element {
  const start = Math.max(0, matches.length - 8);
  const shown = matches.slice(start);
  const off = index - start;
  return (
    <Box flexDirection="column">
      <Text bold>reverse-i-search</Text>
      <Text>
        {'`'}
        <Text color="cyan">{query}</Text>
        {'`'}
      </Text>
      {shown.map((m, i) => (
        <Text key={`${i}-${m}`} color={i === off ? 'cyan' : undefined} inverse={i === off}>
          {i === off ? '▸ ' : '  '}
          {truncateWidth(m.replace(/\n/g, '⏎'), 60)}
        </Text>
      ))}
      {!matches.length ? <Text dimColor> (no matches)</Text> : null}
    </Box>
  );
}

export function PaletteModal({
  items,
  index,
}: {
  items: PaletteItem[];
  index: number;
}): React.JSX.Element {
  const shown = items.slice(0, 10);
  return (
    <Box flexDirection="column">
      <Text bold>Command palette</Text>
      {shown.map((it, i) => (
        <Text key={it.label} color={i === index ? 'cyan' : undefined} inverse={i === index}>
          {i === index ? '▸ ' : '  '}
          {it.label}
          {it.hint ? <Text dimColor> {it.hint}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
