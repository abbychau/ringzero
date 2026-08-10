/** Runner + TUI resume tests: /resume must replay the session transcript. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { Runner } from '../src/cli/runner.js';
import { handleSlashCommand, type CommandDeps } from '../src/tui/commands.js';
import type { Action, Block } from '../src/tui/state.js';

test('listTools keeps disabled tools in the roster after toggling off', () => {
  // Point home + cwd at temp dirs so setToolEnabled's savePrefs never touches
  // the real ~/.ringzero or a repo-local .ringzero config.
  const tmp = mkdtempSync(join(tmpdir(), 'rz-tools-'));
  const oldCwd = process.cwd();
  const oldHome = process.env.RINGZERO_HOME;
  try {
    process.env.RINGZERO_HOME = join(tmp, 'home');
    mkdirSync(join(tmp, 'proj'), { recursive: true });
    process.chdir(join(tmp, 'proj'));
    const config = loadConfig();
    const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });

    const before = runner.listTools();
    assert.ok(before.length > 0, 'expected a non-empty tool roster');
    const target = before[0]!;
    assert.equal(target.enabled, true);

    // Toggle OFF: the tool must stay listed, now marked disabled.
    assert.equal(runner.setToolEnabled(target.name, false), true);
    const disabled = runner.listTools().find((t) => t.name === target.name);
    assert.ok(disabled, `tool "${target.name}" disappeared after toggling off`);
    assert.equal(disabled!.enabled, false);

    // Toggle back ON: listed again as enabled.
    assert.equal(runner.setToolEnabled(target.name, true), true);
    const restored = runner.listTools().find((t) => t.name === target.name);
    assert.ok(restored, `tool "${target.name}" missing after re-enabling`);
    assert.equal(restored!.enabled, true);
  } finally {
    if (oldHome === undefined) delete process.env.RINGZERO_HOME;
    else process.env.RINGZERO_HOME = oldHome;
    process.chdir(oldCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('/resume replays the session transcript into the TUI', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rz-resume-'));
  const oldCwd = process.cwd();
  const oldHome = process.env.RINGZERO_HOME;
  try {
    process.env.RINGZERO_HOME = join(tmp, 'home');
    mkdirSync(join(tmp, 'proj'), { recursive: true });
    process.chdir(join(tmp, 'proj'));
    const config = loadConfig();
    const runner = new Runner(config, { model: 'test-model', ask: async () => 'no' as const });

    // Build a session with a user turn + an assistant tool call + result.
    const id = runner.store.create('resume me');
    runner.store.append(id, {
      id: 'm1',
      role: 'user',
      content: 'list the repo',
      ts: 1,
    });
    runner.store.append(id, {
      id: 'm2',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'list_dir', args: '{"path":"."}' }],
      ts: 2,
    });
    runner.store.append(id, {
      id: 'm3',
      role: 'tool',
      toolCallId: 'c1',
      toolName: 'list_dir',
      content: 'a.txt',
      ts: 3,
    });

    const dispatched: Action[] = [];
    const deps: CommandDeps = {
      runner,
      pushSys: () => {},
      dispatch: (a: Action) => dispatched.push(a),
      openInputModal: async () => null,
      openSelect: async () => null,
      askRef: {},
      getState: () => ({ history: [] }) as never,
      submit: () => {},
      quit: () => {},
    };

    await handleSlashCommand(`/resume ${id}`, deps);
    const setBlocks = dispatched.find(
      (a): a is Extract<Action, { type: 'setBlocks' }> => a.type === 'setBlocks',
    );
    assert.ok(setBlocks, 'expected a setBlocks dispatch after /resume');
    const blocks = setBlocks.blocks as Block[];
    // The assistant message had no text (tool-call only), so it yields just
    // the user turn + the matched tool block.
    assert.equal(blocks.length, 2, `blocks: ${JSON.stringify(blocks)}`);
    assert.deepEqual(
      blocks.map((b) => b.tag),
      ['user', 'tool'],
    );
    assert.equal((blocks[0] as Extract<Block, { tag: 'user' }>).text, 'list the repo');
    // The tool call must be replayed collapsed and matched with its result.
    const tool = blocks.find((b) => b.tag === 'tool') as Extract<Block, { tag: 'tool' }>;
    assert.equal(tool.name, 'list_dir');
    assert.equal(tool.output, 'a.txt');
    assert.equal(tool.done, true);
  } finally {
    if (oldHome === undefined) delete process.env.RINGZERO_HOME;
    else process.env.RINGZERO_HOME = oldHome;
    process.chdir(oldCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});
