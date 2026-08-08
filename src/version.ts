import { readFileSync } from 'node:fs';

/**
 * Build-time version, injected by the standalone build (bun build --define).
 * Normal builds fall back to reading package.json at runtime.
 */
declare const __RINGZERO_VERSION__: string | undefined;

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

export const VERSION =
  typeof __RINGZERO_VERSION__ === 'string' ? __RINGZERO_VERSION__ : readVersion();
