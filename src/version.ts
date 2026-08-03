import { readFileSync } from 'node:fs';

/**
 * Package version read once at module load from package.json (the published
 * `files` list ships dist/src + package.json, so the relative path is stable).
 */
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version?: string;
};

export const VERSION = pkg.version ?? '0.0.0';
