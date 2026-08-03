import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { exportMarkdown } from '../src/session/export.js';
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

test('prune archives excess sessions, keeping the newest and except', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-prune-'));
  const s = new SessionStore(dir);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = s.create(`s${i}`);
    ids.push(id);
    // Stagger `updated` so the list has a stable newest→oldest order.
    const meta = JSON.parse(readFileSync(join(dir, `${id}.jsonl`), 'utf8').split(/\r?\n/)[0]!);
    meta.updated = 1000 + i;
    const lines = readFileSync(join(dir, `${id}.jsonl`), 'utf8').split(/\r?\n/);
    lines[0] = JSON.stringify(meta);
    writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n'));
  }

  // Cap at 2: the 3 oldest (updated 1000..3000) get archived; the newest 2
  // (s4=5000, s3=4000) stay — the `except` session is never archived, but the
  // cap still applies to everyone else.
  const archived = s.prune({ maxSessions: 2, except: ids[3] });
  assert.equal(archived, 3);
  assert.equal(s.list().length, 2); // newest 2 kept
  for (const id of ids) {
    if (id === ids[3] || id === ids[4]) {
      assert.ok(existsSync(join(dir, `${id}.jsonl`)), `${id} should stay`);
    } else {
      assert.ok(existsSync(join(dir, 'archive', `${id}.jsonl`)), `${id} should be archived`);
    }
  }
  // list() ignores the archive subdir.
  assert.deepEqual(
    s
      .list()
      .map((m) => m.id)
      .sort(),
    [ids[3], ids[4]].sort(),
  );
  rmSync(dir, { recursive: true, force: true });
});

test('exportMarkdown renders title, messages, tools, and usage totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-exp-'));
  const s = new SessionStore(dir);
  const id = s.create('Demo session');
  s.append(id, { id: 'm1', role: 'user', content: 'hello', ts: 1 });
  s.append(id, {
    id: 'm2',
    role: 'assistant',
    content: 'I will look',
    toolCalls: [{ id: 'c1', name: 'grep', args: '{"q":"x"}' }],
    usage: { input: 100, output: 20, cacheRead: 30 },
    ts: 2,
  });
  s.append(id, {
    id: 'm3',
    role: 'tool',
    toolCallId: 'c1',
    toolName: 'grep',
    content: 'hit',
    ts: 3,
  });
  s.append(id, {
    id: 'm4',
    role: 'assistant',
    content: 'found it',
    usage: { input: 50, output: 5 },
    ts: 4,
  });

  const md = exportMarkdown(s, id);
  assert.ok(md);
  assert.ok(md.includes('# Demo session'));
  assert.ok(md.includes('## User\n\nhello'));
  assert.ok(md.includes('## Assistant\n\nI will look'));
  assert.ok(md.includes('**tools:** grep({"q":"x"})'));
  assert.ok(md.includes('### tool: grep'));
  assert.ok(md.includes('**token usage:** in=150 out=25 cached=30'));
  assert.equal(exportMarkdown(s, 'nope'), null);
  rmSync(dir, { recursive: true, force: true });
});
