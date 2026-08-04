import React from 'react';
import { Box, Text, useAnimation, useCursor } from 'ink';
import { strWidth, truncateWidth } from './term.js';
import {
  inputLineCol,
  fmtSession,
  fmtUsage,
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

export function TranscriptRow({ block, text }: { block: Block; text: string }): React.JSX.Element {
  const s = TAG_STYLE[block.tag] ?? {};
  return (
    <Text color={s.color} bold={s.bold} dimColor={s.dim}>
      {text}
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
  meta = true,
}: {
  state: State;
  total?: number;
  visible?: number;
  budget?: number;
  session?: Usage;
  /** Show ctx/usage/session meta inline (false when the sidebar shows it). */
  meta?: boolean;
}): React.JSX.Element {
  const sc = state.scroll > 0 ? `  · ↑${state.scroll} ${visible}/${total}` : '';
  const focus = state.transcriptFocus ? '  · ↑/↓ scroll · Esc to input' : '';
  let metaText = '';
  if (meta) {
    if (state.ctxTokens !== undefined)
      metaText += `  · ctx≈${(state.ctxTokens / 1000).toFixed(1)}k${budget ? `/${Math.round(budget / 1000)}k` : ''}`;
    if (state.usage)
      metaText += `  · last ${fmtUsage(state.usage)} ≈${fmtCost(estimateCost(state.model, state.usage))}`;
    if (session)
      metaText += `  · ${fmtSession(session)} ≈${fmtCost(estimateCost(state.model, session))}`;
  }
  // Yolo badge is a separate colored element; status text truncates tighter to
  // leave room for it.
  const statusText = truncateWidth(state.status + sc + focus + metaText, 92);
  return (
    <Box>
      {state.running ? <Spinner /> : <Text dimColor>●</Text>}
      {meta && state.yolo ? <Text color="red"> YOLO</Text> : null}
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
  key?: string;
  desc?: string;
  color?: 'yellow' | 'red' | 'cyan';
  dim?: boolean;
  bold?: boolean;
}

/**
 * Right-side metadata/hints column (opencode style). Renders inside a box
 * border; taller than the content it shows, the remaining rows are blank.
 */
export function Sidebar({
  state,
  model,
  sessionId,
  budget,
  height,
  width = SIDEBAR_W,
}: {
  state: State;
  model: string;
  sessionId?: string;
  budget?: number;
  height: number;
  width?: number;
}): React.JSX.Element | null {
  if (height < 3) return null;
  const contentW = width - 4; // '│ ' + content + ' │'
  const rows: SidebarRow[] = [
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
  rows.push({ text: '' }, { text: 'keys', dim: true });
  const keys: Array<[string, string]> = [
    ['Ctrl+P', 'model'],
    ['Ctrl+K', 'palette'],
    ['Ctrl+R', 'search'],
    ['Ctrl+O', 'expand tool'],
    ['Ctrl+T', 'todos'],
    ['Ctrl+J', 'newline'],
    ['↑/↓', 'history'],
    ['PgUp/Dn', 'scroll'],
    ['wheel', 'scroll'],
    ['Esc', 'to input'],
    ['/help', 'commands'],
  ];
  for (const [k, d] of keys) rows.push({ key: k, desc: d });

  const avail = Math.max(1, height - 2);
  const visible = rows.slice(0, avail);
  const pad = Math.max(0, avail - visible.length);
  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor>{'┌' + '─'.repeat(width - 2) + '┐'}</Text>
      {visible.map((r, i) => {
        let inner: string;
        if (r.key !== undefined) {
          const gap = Math.max(1, 7 - strWidth(r.key));
          inner = r.key + ' '.repeat(gap) + (r.desc ?? '');
        } else {
          inner = r.text ?? '';
        }
        inner = truncateWidth(inner, contentW);
        const line = '│ ' + padWidth(inner, contentW) + ' │';
        return (
          <Text key={i} color={r.color} dimColor={r.dim} bold={r.bold}>
            {line}
          </Text>
        );
      })}
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
