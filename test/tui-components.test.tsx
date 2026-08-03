import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import {
  StatusBar,
  ConfirmModal,
  SelectModal,
  InputModal,
  SlashSuggest,
} from '../src/tui/components.js';
import { initial } from '../src/tui/state.js';
import { App } from '../src/tui/app.js';
import { Runner } from '../src/cli/runner.js';
import { loadConfig } from '../src/config/config.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

test('App mounts and renders the header', () => {
  const config = loadConfig();
  const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });
  const { lastFrame } = render(
    <App
      runner={runner}
      askRef={{}}
      favorites={[]}
      initialModel="test-model"
      sysRef={{}}
      mouseCbRef={{}}
      onExit={() => {}}
    />,
  );
  const f = lastFrame()!;
  assert.ok(f.includes('RingZero'), `frame was: ${JSON.stringify(f)}`);
  assert.ok(f.includes('test-model'), `frame was: ${JSON.stringify(f)}`);
});

test('StatusBar renders idle status', () => {
  const { lastFrame } = render(<StatusBar state={initial('m')} />);
  assert.ok(lastFrame()!.includes('ready'));
});

test('StatusBar shows session total usage + cached', () => {
  const { lastFrame } = render(
    <StatusBar state={initial('m')} session={{ input: 4313, output: 360, cacheRead: 3072 }} />,
  );
  const f = stripAnsi(lastFrame()!);
  assert.ok(f.includes('Σ in=4313 out=360 cached=3072'), `frame was: ${JSON.stringify(f)}`);
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
