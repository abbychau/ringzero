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

const TAG_STYLE: Record<Block['tag'], { color?: string; bold?: boolean; dim?: boolean }> = {
  user: { color: 'cyan' },
  assistant: {},
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
}: {
  state: State;
  total?: number;
  visible?: number;
  budget?: number;
  session?: Usage;
}): React.JSX.Element {
  const sc = state.scroll > 0 ? `  · ↑${state.scroll} ${visible}/${total}` : '';
  const ctx =
    state.ctxTokens !== undefined
      ? `  · ctx≈${(state.ctxTokens / 1000).toFixed(1)}k${budget ? `/${Math.round(budget / 1000)}k` : ''}`
      : '';
  const ses = session ? `  · ${fmtSession(session)}` : '';
  return (
    <Box>
      {state.running ? <Spinner /> : <Text dimColor>●</Text>}
      <Text dimColor> {truncateWidth(state.status + sc + ctx + ses, 100)}</Text>
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
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {options.map((o, i) => (
        <Text key={o.value} color={i === index ? 'cyan' : undefined} inverse={i === index}>
          {i === index ? '▸ ' : '  '}
          {truncateWidth(o.label, 60)}
          {o.hint ? <Text dimColor> {o.hint}</Text> : null}
        </Text>
      ))}
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
