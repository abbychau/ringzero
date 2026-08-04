import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copySelection } from '../src/tui/commands.js';
import { pickClipboardCmd } from '../src/tui/clipboard.js';
import type { SessionMessage } from '../src/kernel/types.js';

function msg(role: SessionMessage['role'], content: string, i: number): SessionMessage {
  return { id: `m${i}`, role, content, ts: i };
}

test('copySelection defaults to the last assistant message', () => {
  const msgs = [
    msg('user', 'hi', 1),
    msg('assistant', 'first answer', 2),
    msg('user', 'again', 3),
    msg('assistant', 'second answer', 4),
  ];
  const pick = copySelection(msgs);
  assert.equal(pick.ok, true);
  if (pick.ok) {
    assert.equal(pick.text, 'second answer');
    assert.equal(pick.count, 1);
  }
});

test('copySelection n takes the last n assistant messages, skipping tool-only turns', () => {
  const msgs = [
    msg('assistant', 'a', 1),
    msg('tool', 'out', 2),
    msg('assistant', '', 3), // tool-only assistant turn
    msg('assistant', 'b', 4),
    msg('assistant', 'c', 5),
  ];
  const pick = copySelection(msgs, '2');
  assert.equal(pick.ok, true);
  if (pick.ok) {
    assert.equal(pick.text, 'b\n\nc');
    assert.equal(pick.count, 2);
  }
});

test('copySelection n clamps to the number of assistant messages', () => {
  const msgs = [msg('assistant', 'a', 1), msg('assistant', 'b', 2)];
  const pick = copySelection(msgs, '99');
  assert.equal(pick.ok, true);
  if (pick.ok) assert.equal(pick.count, 2);
});

test('copySelection rejects invalid n', () => {
  for (const bad of ['abc', '0', '-2', '1.5']) {
    const pick = copySelection([msg('assistant', 'a', 1)], bad);
    assert.deepEqual(pick, { ok: false, reason: 'bad-arg' }, `arg=${bad}`);
  }
});

test('copySelection reports none when there is no assistant text', () => {
  assert.deepEqual(copySelection([]), { ok: false, reason: 'none' });
  assert.deepEqual(copySelection([msg('tool', 'out', 1)]), { ok: false, reason: 'none' });
});

test('pickClipboardCmd maps platforms', () => {
  assert.deepEqual(pickClipboardCmd('win32'), [{ cmd: 'clip', args: [] }]);
  assert.deepEqual(pickClipboardCmd('darwin'), [{ cmd: 'pbcopy', args: [] }]);
  const linux = pickClipboardCmd('linux');
  assert.equal(linux[0]?.cmd, 'xclip');
  assert.deepEqual(linux[0]?.args, ['-selection', 'clipboard']);
  assert.ok(linux.some((c) => c.cmd === 'wl-copy'));
  assert.ok(linux.some((c) => c.cmd === 'xsel'));
});
