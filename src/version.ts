import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // package.json isn't always at the resolved path (e.g. a bare dist copy in
    // a benchmark container) — the version read must never crash the app.
    return '0.0.0';
  }
}

export const VERSION = readVersion();
