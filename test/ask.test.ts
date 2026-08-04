import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { askUserTool } from '../src/tools/ask.js';
import type { ToolContext } from '../src/kernel/types.js';

function ctx(promptUser?: (p: string) => Promise<string | null>): ToolContext {
  return {
    cwd: process.cwd(),
    home: homedir(),
    signal: new AbortController().signal,
    ask: async () => true,
    promptUser,
  };
}

test('ask_user returns the free-text answer', async () => {
  const out = await askUserTool().execute(
    { prompt: 'which port?' },
    ctx(async () => '8080'),
  );
  assert.equal(out, 'user answered: 8080');
});

test('ask_user maps a numbered choice', async () => {
  const out = await askUserTool().execute(
    { prompt: 'pick one', choices: ['alpha', 'beta'] },
    ctx(async () => '2'),
  );
  assert.equal(out, 'user chose: beta');
});

test('ask_user reports unavailable when no promptUser channel exists', async () => {
  const out = await askUserTool().execute({ prompt: 'hi' }, ctx());
  assert.ok(out.includes('unavailable'), out);
});

test('ask_user handles cancel and empty answers', async () => {
  const cancelled = await askUserTool().execute({ prompt: 'q' }, ctx(async () => null));
  assert.ok(cancelled.includes('cancelled'), cancelled);
  const empty = await askUserTool().execute({ prompt: 'q' }, ctx(async () => '   '));
  assert.ok(empty.includes('empty'), empty);
  const noPrompt = await askUserTool().execute({}, ctx(async () => 'x'));
  assert.ok(noPrompt.startsWith('error'), noPrompt);
});
