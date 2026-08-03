/** Verbose logging, gated on RINGZERO_VERBOSE (set by --verbose). */
export function log(...args: unknown[]): void {
  if (process.env.RINGZERO_VERBOSE) console.error('[ringzero]', ...args);
}
