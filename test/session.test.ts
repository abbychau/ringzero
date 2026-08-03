import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import type { SessionMessage } from '../src/kernel/types.js';

test('store append/load/replace/setTitle round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-'));
  const s = new SessionStore(dir);
  const id = s.create('t');
  const mk = (i: number, role: SessionMessage['role'], content: string): SessionMessage => ({
    id: `m${i}`,
    role,
    content,
    ts: i,
  });
  s.append(id, mk(1, 'user', 'hi'));
  s.append(id, mk(2, 'assistant', 'yo'));
  assert.equal(s.load(id).length, 2);

  s.replace(id, [mk(3, 'user', '[summary]')]);
  assert.equal(s.load(id).length, 1);
  assert.equal(s.load(id)[0]!.content, '[summary]');

  s.setTitle(id, 'new title');
  assert.equal(s.list()[0]!.title, 'new title');
  assert.equal(s.list()[0]!.id, id);

  rmSync(dir, { recursive: true, force: true });
});
