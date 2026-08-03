import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SessionMessage } from '../kernel/types.js';

export interface SessionMeta {
  id: string;
  title: string;
  created: number;
  updated: number;
}

/**
 * Append-only JSONL session store. Each session is one file:
 *   line 1: {"type":"meta", ...}
 *   rest:   {"type":"msg", ...SessionMessage}
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  create(title = 'New session'): string {
    mkdirSync(this.dir, { recursive: true });
    const id = `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const meta = { type: 'meta', id, title, created: Date.now(), updated: Date.now() };
    writeFileSync(this.file(id), JSON.stringify(meta) + '\n');
    return id;
  }

  append(id: string, msg: SessionMessage): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(id), JSON.stringify({ type: 'msg', ...msg }) + '\n', { flag: 'a' });
  }

  load(id: string): SessionMessage[] {
    if (!existsSync(this.file(id))) return [];
    const out: SessionMessage[] = [];
    for (const line of readFileSync(this.file(id), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'msg') out.push(obj);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  /** Rewrite the session with a new message list (used by compaction). */
  replace(id: string, messages: SessionMessage[]): void {
    const p = this.file(id);
    if (!existsSync(p)) return;
    const first = readFileSync(p, 'utf8').split(/\r?\n/)[0] ?? '';
    const lines = [first, ...messages.map((m) => JSON.stringify({ type: 'msg', ...m }))].filter(
      Boolean,
    );
    writeFileSync(p, lines.join('\n') + '\n');
  }

  setTitle(id: string, title: string): void {
    const p = this.file(id);
    if (!existsSync(p)) return;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    if (lines.length && lines[0]) {
      try {
        const meta = JSON.parse(lines[0]);
        meta.title = title;
        meta.updated = Date.now();
        lines[0] = JSON.stringify(meta);
        writeFileSync(p, lines.join('\n'));
      } catch {
        /* ignore */
      }
    }
  }

  list(): SessionMeta[] {
    mkdirSync(this.dir, { recursive: true });
    const out: SessionMeta[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, f), 'utf8').split(/\r?\n/)[0]!);
        if (meta.type === 'meta') {
          out.push({
            id: meta.id,
            title: meta.title,
            created: meta.created,
            updated: meta.updated,
          });
        }
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  /**
   * Archive sessions beyond the cap into `<dir>/archive` (moved, never
   * deleted). `maxSessions` keeps the newest N; `keepDays` archives anything
   * older than that many days (0 = off). `except` is never archived. Returns
   * the number of archived sessions.
   */
  prune(opts: { maxSessions: number; keepDays?: number; except?: string }): number {
    const list = this.list();
    if (list.length === 0) return 0;
    const keepDays = opts.keepDays && opts.keepDays > 0 ? opts.keepDays : 0;
    const cutoff = keepDays > 0 ? Date.now() - keepDays * 86_400_000 : 0;
    const archiveDir = join(this.dir, 'archive');
    let archived = 0;
    for (const s of list) {
      if (s.id === opts.except) continue;
      const tooMany = list.indexOf(s) >= opts.maxSessions;
      const tooOld = cutoff > 0 && s.updated < cutoff;
      if (!tooMany && !tooOld) continue;
      mkdirSync(archiveDir, { recursive: true });
      try {
        renameSync(this.file(s.id), join(archiveDir, `${s.id}.jsonl`));
        archived++;
      } catch {
        /* best-effort */
      }
    }
    return archived;
  }
}
