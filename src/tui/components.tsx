import React from 'react';
import { Box, Text, useAnimation, useCursor } from 'ink';
import { strWidth, truncateWidth } from './term.js';
import {
  inputLineCol,
  fmtSession,
  type Block,
  type Option,
  type PaletteItem,
  type State,
  type Usage,
} from './state.js';
import { estimateCost, fmtCost, cacheHitRate } from '../kernel/cost.js';

/** Fixed width of the metadata/hints sidebar (opencode-style right column). */
export const SIDEBAR_W = 26;

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
  if (!sel || sel.end <= sel.start) {
    return (
      <Text color={s.color} bold={s.bold} dimColor={s.dim}>
        {text}
      </Text>
    );
  }
  return (
    <Text color={s.color} bold={s.bold} dimColor={s.dim}>
      {text.slice(0, sel.start)}
      <Text inverse>{text.slice(sel.start, sel.end)}</Text>
      {text.slice(sel.end)}
    </Text>
  );
}

function Spinner(): React.JSX.Element {
  const { frame } = useAnimation({ interval: 80 });
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

function padWidth(s: string, w: number): string {
  const cur = strWidth(s);
  return s + ' '.repeat(Math.max(0, w - cur));
}

function fmtBudget(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  return `${Math.round(n / 1000)}k`;
}

function compactUsage(u: Usage): string {
  return `in ${u.input} · out ${u.output}${u.cacheRead ? ` · c ${u.cacheRead}` : ''}`;
}

interface SidebarRow {
  text?: string;
  color?: 'yellow' | 'red' | 'cyan';
  dim?: boolean;
  bold?: boolean;
  /** Status row: live ●/spinner prefix, kept at the bottom of the sidebar. */
  spinner?: boolean;
}

/**
 * Right-side column (opencode style): header + metadata + status line, inside
 * a box border. Rows it can't fit are trimmed from the tail; the status row is
 * always pinned to the bottom.
 */
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
}): React.JSX.Element | null {
  if (height < 3) return null;
  const contentW = width - 4; // '│ ' + content + ' │'
  const rows: SidebarRow[] = [
    { text: `RingZero · ${cwdName}`, bold: true },
    { text: '' },
    { text: 'model', dim: true },
    { text: model, color: 'cyan', bold: true },
    ...(sessionId ? [{ text: `session ${sessionId.slice(0, 8)}`, dim: true }] : []),
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
    rows.push({ text: '█'.repeat(fill) + '░'.repeat(Math.max(0, contentW - fill)), dim: true });
  }
  const usage = state.usage;
  const totalUsage = state.totalUsage;
  if (usage || totalUsage) {
    rows.push({ text: '' });
    if (usage) rows.push({ text: `last ${compactUsage(usage)}`, dim: true });
    if (totalUsage) {
      rows.push({ text: `sess ${compactUsage(totalUsage)}`, dim: true });
      rows.push({
        text: `${Math.round(cacheHitRate(totalUsage) * 100)}% cached · ≈${fmtCost(estimateCost(model, totalUsage))}`,
        dim: true,
      });
    }
  }
  // The status line lives here instead of a full-width bottom bar.
  const sc = state.scroll > 0 ? `  · ↑${state.scroll} ${visible}/${total}` : '';
  const focus = state.transcriptFocus ? '  · ↑/↓ scroll · Esc to input' : '';
  const status: SidebarRow = { text: state.status + sc + focus, spinner: true };

  const avail = Math.max(1, height - 2);
  const visibleRows = [...rows.slice(0, Math.max(0, avail - 1)), status].slice(0, avail);
  const pad = Math.max(0, avail - visibleRows.length);
  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor>{'┌' + '─'.repeat(width - 2) + '┐'}</Text>
      {visibleRows.map((r, i) =>
        r.spinner ? (
          <Text key={i} dimColor>
            {'│ '}
            {state.running ? <Spinner /> : <Text dimColor>●</Text>}{' '}
            {padWidth(truncateWidth(r.text ?? '', contentW - 2), contentW - 2)}
            {' │'}
          </Text>
        ) : (
          <Text key={i} color={r.color} dimColor={r.dim} bold={r.bold}>
            {'│ '}
            {padWidth(truncateWidth(r.text ?? '', contentW), contentW)}
            {' │'}
          </Text>
        ),
      )}
      {Array.from({ length: pad }, (_, i) => (
        <Text key={`p${i}`} dimColor>
          {'│' + ' '.repeat(width - 2) + '│'}
        </Text>
      ))}
      <Text dimColor>{'└' + '─'.repeat(width - 2) + '┘'}</Text>
    </Box>
  );
}

export function PromptInput({
  value,
  cursor,
  height,
  disabled,
}: {
  value: string;
  cursor: number;
  height: number;
  disabled?: boolean;
}): React.JSX.Element {
  const { setCursorPosition } = useCursor();
  const prefix = '❯ ';
  const lines = value.split('\n');
  const { line, col } = inputLineCol(value, cursor);
  // x: display width up to the cursor within the CURRENT line (prefix only on
  // line 0). Uses strWidth so CJK/fullwidth count as 2 columns.
  const x = strWidth((line === 0 ? prefix : '') + (lines[line]?.slice(0, col) ?? ''));
  // y: the input occupies `lines.length` rows at the bottom of the frame. Our
  // app is fullscreen, so Ink's cursor convention is y = totalLineCount for the
  // LAST row — subtract the rows above the cursor's line to land on it.
  const y = height - (lines.length - 1) + line;
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
