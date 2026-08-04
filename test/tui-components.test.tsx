import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { render } from 'ink-testing-library';
import {
  StatusBar,
  Sidebar,
  ConfirmModal,
  SelectModal,
  InputModal,
  SlashSuggest,
} from '../src/tui/components.js';
import { initial } from '../src/tui/state.js';
import { App } from '../src/tui/app.js';
import { Runner } from '../src/cli/runner.js';
import { loadConfig } from '../src/config/config.js';
import type { ImageInput } from '../src/kernel/types.js';

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

test('Sidebar shows header, model, badges, ctx bar, usage, and status', () => {
  const state = {
    ...initial('deepseek-v4-flash', true, true),
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
  assert.ok(f.includes('[plan]'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('[yolo]'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('[img]'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('ctx'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('ready'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(!f.includes('Ctrl+P'), 'key hints should not be shown');
});

test('Sidebar pins the status row when too short', () => {
  const { lastFrame } = render(<Sidebar state={initial('m')} model="m" height={4} cwdName="x" />);
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

test('InputModal shows typed value', () => {
  const { lastFrame } = render(<InputModal prompt="model:" value="deepseek-v4-flash" />);
  const f = lastFrame()!;
  assert.ok(f.includes('model:'));
  assert.ok(f.includes('deepseek-v4-flash'));
});

test('SlashSuggest renders items and highlights selection', () => {
  const { lastFrame } = render(<SlashSuggest items={['help', 'exit']} index={1} />);
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('/help'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('▸ /exit'), `frame was: ${JSON.stringify(f)}`);
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
