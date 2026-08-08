import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository root, found by walking up from this file until a package.json
 * marker appears. Tests run from different layouts (tsc → dist/test/…, bun →
 * test/…), so relative paths must not assume a fixed depth.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
}
