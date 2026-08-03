/** Shared file-walking + glob helpers (zero deps). */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
]);

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // `**/` — optional dir prefix, so **/* also matches root files
          re += '(?:.*[/\\\\])?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else re += '[^/\\\\]*';
    } else if (c === '?') {
      re += '[^/\\\\]';
    } else if (c === '/') {
      // match either separator so patterns work on Windows (backslash) paths
      re += '[/\\\\]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Recursively list relative file paths under root, skipping ignored dirs. */
export function walkFiles(root: string, maxFiles = 10_000): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(name)) visit(full);
      } else {
        out.push(relative(root, full));
      }
    }
  };
  visit(root);
  return out;
}

/** Cheap binary sniff: null byte in the first 8KB. */
export function isBinaryBuf(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
