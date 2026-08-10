import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { render } from 'ink-testing-library';
import {
  StatusBar,
  Sidebar,
  sidebarTextLines,
  ConfirmModal,
  SelectModal,
  InputModal,
  SlashSuggest,
  TranscriptRow,
} from '../src/tui/components.js';
import { initial, slashCommands } from '../src/tui/state.js';
import { App } from '../src/tui/app.js';
import { Runner } from '../src/cli/runner.js';
import { loadConfig } from '../src/config/config.js';
import type { ImageInput } from '../src/kernel/types.js';
import chalk from 'chalk';

// Force ANSI output regardless of the runner's TTY/FORCE_COLOR state: under
// `node --test` the child process pipes stdout, so chalk self-detects level 0
// and strips all styles. The inverse-video assertion below needs styles on.
chalk.level = 3;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

test('App mounts and renders the header', () => {
  const config = loadConfig();
  const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });
  const { lastFrame } = render(
    <App
      runner={runner}
      askRef={{}}
      promptUserRef={{}}
      favorites={[]}
      initialModel="test-model"
      sysRef={{}}
      mouseCbRef={{}}
      onExit={() => {}}
    />,
  );
  const f = lastFrame()!;
  assert.ok(f.includes('RingZero'), `frame was: ${JSON.stringify(f)}`);
  // Header shows the working dir name; model lives in the sidebar (hidden at
  // the 80-col test viewport, which is under the 90-col sidebar threshold).
  assert.ok(f.includes(basename(config.cwd)), `frame was: ${JSON.stringify(f)}`);
});

test('StatusBar renders idle status', () => {
  const { lastFrame } = render(<StatusBar state={initial('m')} />);
  assert.ok(lastFrame()!.includes('ready'));
});

test('StatusBar shows the YOLO badge when yolo is on', () => {
  const { lastFrame } = render(<StatusBar state={initial('m', false, true)} />);
  assert.ok(stripAnsi(lastFrame()!).includes('YOLO'));
});

test('StatusBar shows session total usage + cached', () => {
  const { lastFrame } = render(
    <StatusBar state={initial('m')} session={{ input: 4313, output: 360, cacheRead: 3072 }} />,
  );
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('Σ in=4313 out=360 cached=3072'), `frame was: ${JSON.stringify(f)}`);
});

test('StatusBar appends the estimated cost for the session', () => {
  const { lastFrame } = render(
    <StatusBar
      state={initial('deepseek-chat')}
      session={{ input: 1_000_000, output: 100_000, cacheRead: 500_000 }}
    />,
  );
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('≈$0.415'), `frame was: ${JSON.stringify(f)}`);
});

test('StatusBar renders the ctx budget bar (green <70%, red ≥90%)', () => {
  const { lastFrame } = render(
    <StatusBar state={{ ...initial('m'), ctxTokens: 5000 }} budget={10000} />,
  );
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('ctx≈5.0k/10k'), `frame was: ${JSON.stringify(f)}`);
  // 50% of budget → half the 10-cell bar filled.
  assert.ok(f.includes('[#####-----]'), `frame was: ${JSON.stringify(f)}`);
  // 95% → full bar, red threshold.
  const { lastFrame: f2 } = render(
    <StatusBar state={{ ...initial('m'), ctxTokens: 9500 }} budget={10000} />,
  );
  const g = stripAnsi(f2()!);
  assert.ok(g.includes('[##########]'), `frame was: ${JSON.stringify(g)}`);
  // No bar without a budget.
  const { lastFrame: f3 } = render(<StatusBar state={{ ...initial('m'), ctxTokens: 5000 }} />);
  assert.ok(!stripAnsi(f3()!).includes('['), `frame was: ${JSON.stringify(f3()!)}`);
});

test('Sidebar shows header, model, effort, badges, ctx bar, usage, and status', () => {
  const state = {
    ...initial('deepseek-v4-flash', true, true, 'max'),
    ctxTokens: 123456,
    usage: { input: 1000, output: 500, cacheRead: 300 },
    totalUsage: { input: 5000, output: 2000, cacheRead: 3000 },
    pendingImage: { mime: 'image/png', data: 'x' } as ImageInput,
  };
  const { lastFrame } = render(
    <Sidebar
      state={state}
      model="deepseek-v4-flash"
      sessionId="abc123456789"
      budget={32000}
      height={30}
      cwdName="myproj"
    />,
  );
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('RingZero · myproj'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('deepseek-v4-flash'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('effort max'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('[plan]'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('[yolo]'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('[img]'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('ctx'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('ready'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(!f.includes('Ctrl+P'), 'key hints should not be shown');
});

test('Sidebar pins the status row when too short', () => {
  // Status area now occupies 2 rows (live ●/spinner + status text), so a tiny
  // height keeps just those; bump to 5 so the header fits while the status
  // block is still pinned at the bottom.
  const { lastFrame } = render(<Sidebar state={initial('m')} model="m" height={5} cwdName="x" />);
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('RingZero · x'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('ready'), `frame was: ${JSON.stringify(f)}`);
});

test('ConfirmModal shows prompt and keys', () => {
  const { lastFrame } = render(<ConfirmModal prompt="allow bash?" />);
  const f = lastFrame()!;
  assert.ok(f.includes('allow bash?'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('[a]lways'), `frame was: ${JSON.stringify(f)}`);
});

test('SelectModal highlights the selected index', () => {
  const { lastFrame } = render(
    <SelectModal
      title="Sessions"
      options={[
        { label: 'a', value: '1' },
        { label: 'b', value: '2' },
      ]}
      index={1}
    />,
  );
  const f = lastFrame()!;
  assert.ok(f.includes('▸ b'));
});

test('SelectModal shows the option desc and hint (tools menu layout)', () => {
  const { lastFrame } = render(
    <SelectModal
      title="Tools — Enter toggles, Esc closes"
      options={[{ label: 'bash', desc: 'run shell commands', value: 'bash', hint: 'OFF' }]}
      index={0}
    />,
  );
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('bash'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('run shell commands'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('OFF'), `frame was: ${JSON.stringify(f)}`);
});

test('InputModal shows typed value', () => {
  const { lastFrame } = render(<InputModal prompt="model:" value="deepseek-v4-flash" />);
  const f = lastFrame()!;
  assert.ok(f.includes('model:'));
  assert.ok(f.includes('deepseek-v4-flash'));
});

test('SlashSuggest renders items with hints and highlights selection', () => {
  const { lastFrame } = render(<SlashSuggest items={['help', 'exit']} index={1} />);
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('/help'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('list commands and keys'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('▸ /exit'), `frame was: ${JSON.stringify(f)}`);
});

test('SlashSuggest windows the list around the highlight for long menus', () => {
  // ~22 built-in commands: with height 8 and index deep in the list, the
  // window must show the highlighted row and skip the top of the list.
  const items = slashCommands();
  assert.ok(items.length > 8, 'expected more than a windowful of commands');
  const index = items.indexOf('yolo');
  assert.ok(index >= 0, 'expected yolo in the command list');
  const { lastFrame } = render(<SlashSuggest items={items} index={index} height={8} />);
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('▸ /yolo'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(!f.includes('/help'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('auto-allow all tools'), `frame was: ${JSON.stringify(f)}`);
});

test('App shows / command suggestions while typing a slash', async () => {
  const config = loadConfig();
  const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });
  const { lastFrame, stdin } = render(
    <App
      runner={runner}
      askRef={{}}
      promptUserRef={{}}
      favorites={[]}
      initialModel="test-model"
      sysRef={{}}
      mouseCbRef={{}}
      onExit={() => {}}
    />,
  );
  stdin.write('/');
  await new Promise((r) => setTimeout(r, 20));
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('/help'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('/usage'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('❯ /'), `frame was: ${JSON.stringify(f)}`);
});

test('Enter on the / menu fills the highlighted command instead of submitting', async () => {
  const config = loadConfig();
  const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });
  const { lastFrame, stdin } = render(
    <App
      runner={runner}
      askRef={{}}
      promptUserRef={{}}
      favorites={[]}
      initialModel="test-model"
      sysRef={{}}
      mouseCbRef={{}}
      onExit={() => {}}
    />,
  );
  const sleep = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
  // Navigate the menu to /usage, then Enter: the input must hold the
  // highlighted command instead of submitting "/".
  stdin.write('/');
  await sleep();
  stdin.write('\u001b[B'); // ↓ moves the highlight from /help to /usage
  await sleep();
  stdin.write('\r');
  await sleep();
  let f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('❯ /usage'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(!f.includes('(no usage yet)'), 'first Enter must not submit');
  // A second Enter now runs the command shown in the input.
  stdin.write('\r');
  await sleep();
  f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('(no usage yet)'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(!f.includes('❯ /usage'), 'input should be cleared after submit');
});

test('App /help renders a formatted command list', async () => {
  const config = loadConfig();
  const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });
  const { lastFrame, stdin } = render(
    <App
      runner={runner}
      askRef={{}}
      promptUserRef={{}}
      favorites={[]}
      initialModel="test-model"
      sysRef={{}}
      mouseCbRef={{}}
      onExit={() => {}}
    />,
  );
  const sleep = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
  stdin.write('/help');
  await sleep();
  stdin.write('\r'); // the input already is /help, so Enter runs it
  await sleep();
  const f = stripAnsi(lastFrame()!);
  // The transcript shows the tail of the help block (the top scrolled out of
  // the small test viewport), so assert on the visible sections.
  assert.ok(f.includes('toggle tools on/off'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('args:'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('keys:'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('Ctrl+P model'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('Ctrl+Y copy selection'), `frame was: ${JSON.stringify(f)}`);
});

test('App input keys: Ctrl+A/E jump to home/end, Ctrl+←/→ jump by word', async () => {
  const config = loadConfig();
  const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });
  const { lastFrame, stdin } = render(
    <App
      runner={runner}
      askRef={{}}
      promptUserRef={{}}
      favorites={[]}
      initialModel="test-model"
      sysRef={{}}
      mouseCbRef={{}}
      onExit={() => {}}
    />,
  );
  const sleep = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
  stdin.write('hello world');
  await sleep();
  // Ctrl+← (ESC[1;5D): from the end, back to the start of "world".
  stdin.write('\u001b[1;5D');
  await sleep();
  stdin.write('X');
  await sleep();
  let f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('❯ hello Xworld'), `frame was: ${JSON.stringify(f)}`);
  // Ctrl+A (0x01) → home; type at the front.
  stdin.write('\u0001');
  await sleep();
  stdin.write('Y');
  await sleep();
  f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('❯ Yhello Xworld'), `frame was: ${JSON.stringify(f)}`);
  // Ctrl+E (0x05) → end; type at the back.
  stdin.write('\u0005');
  await sleep();
  stdin.write('Z');
  await sleep();
  f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('❯ Yhello XworldZ'), `frame was: ${JSON.stringify(f)}`);
  // Home, then Ctrl+→ (ESC[1;5C): from the front, jump over "Yhello " (to the
  // start of "XworldZ", i.e. before X) and type there.
  stdin.write('\u0001');
  await sleep();
  stdin.write('\u001b[1;5C');
  await sleep();
  stdin.write('Q');
  await sleep();
  f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('❯ Yhello QXworldZ'), `frame was: ${JSON.stringify(f)}`);
});

test('TranscriptRow renders the selected slice in inverse video', () => {
  const { lastFrame } = render(
    <TranscriptRow
      block={{ tag: 'user', text: 'abcdef' }}
      text="abcdef"
      sel={{ start: 1, end: 4 }}
    />,
  );
  const f = lastFrame()!;
  assert.ok(f.includes('\x1b[7m'), `frame was: ${JSON.stringify(f)}`);
  const plain = stripAnsi(f);
  assert.ok(plain.includes('abcdef'), `frame was: ${JSON.stringify(f)}`);
});

test('TranscriptRow renders URLs as OSC 8 hyperlinks', () => {
  const { lastFrame } = render(
    <TranscriptRow
      block={{ tag: 'assistant', text: 'see https://x.dev now' }}
      text="see https://x.dev now"
    />,
  );
  const f = lastFrame()!;
  assert.ok(f.includes('\x1b]8;;https://x.dev\x1b\\'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('\x1b]8;;\x1b\\'), `frame was: ${JSON.stringify(f)}`);
});

test('TranscriptRow renders plainly without a selection', () => {
  const { lastFrame } = render(
    <TranscriptRow block={{ tag: 'assistant', text: 'hello' }} text="hello" />,
  );
  const f = lastFrame()!;
  assert.ok(!f.includes('\x1b[7m'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(stripAnsi(f).includes('hello'), `frame was: ${JSON.stringify(f)}`);
});

test('sidebarTextLines returns selectable text lines with status and padding', () => {
  const lines = sidebarTextLines(initial('m'), 'model-x', 'abc12345', 32000, 'proj', 3, 2, 24, 10);
  assert.equal(lines.length, 10); // borderless: height 10 → 10 rows
  assert.ok(lines[0]!.includes('RingZero · proj'), `lines: ${JSON.stringify(lines)}`);
  assert.ok(
    lines.some((l) => l.includes('model-x')),
    `lines: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((l) => l.includes('abc12345')),
    `lines: ${JSON.stringify(lines)}`,
  );
  const nonEmpty = lines.filter((l) => l !== '');
  assert.ok(nonEmpty[nonEmpty.length - 1]!.includes('ready'), `lines: ${JSON.stringify(lines)}`);
});

test('Sidebar renders inverse highlight for a sidebar selection', () => {
  const { lastFrame } = render(
    <Sidebar
      state={initial('m')}
      model="m"
      sessionId="abc123456789"
      budget={32000}
      height={10}
      cwdName="myproj"
      selection={{ pane: 'sidebar', anchorRow: 0, anchorCol: 5, headRow: 0, headCol: 9 }}
    />,
  );
  const f = lastFrame()!;
  assert.ok(f.includes('\x1b[7m'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(stripAnsi(f).includes('RingZero · myproj'), `frame was: ${JSON.stringify(f)}`);
});
