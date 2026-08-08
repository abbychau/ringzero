/**
 * `ringzero --update`: self-update to the latest GitHub release.
 *
 * Detects how the running copy was installed and swaps in the newest build:
 *   - Windows SFX exe (installer → %LOCALAPPDATA%\Programs\RingZero\ringzero.exe):
 *     a running exe can be renamed but not overwritten, so the current exe is
 *     renamed to `.old` and the new one moved into place; a detached process
 *     deletes the `.old` once this process exits.
 *   - macOS/Linux portable dir (~/.local/share/ringzero): the whole install dir
 *     is renamed aside and the freshly extracted zip moved in; a detached
 *     process removes the old dir shortly after.
 *   - Anything else (dev checkout, ad-hoc copy, npm install): prints guidance
 *     (npm installs upgrade via `npm i -g ringzero@latest`, not self-update).
 *
 * Zero runtime deps: uses global fetch for the GitHub API + the minimal
 * `../util/unzip.js` reader for the portable zip.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { extractZip } from '../util/unzip.js';

export const REPO = 'abbychau/ringzero';
export const INSTALL_URL = 'https://ringzero.abby.md';

/** Numeric semver compare (handles a leading `v` and ragged lengths). */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = b
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The release asset to download for the current platform (null = none built). */
export function assetFor(
  platform: NodeJS.Platform,
  arch: string,
): { name: string; kind: 'exe' | 'zip' } | null {
  if (platform === 'win32')
    return arch === 'x64' ? { name: 'ringzero-win-x64.exe', kind: 'exe' } : null;
  if (platform === 'darwin')
    return arch === 'arm64' ? { name: 'ringzero-darwin-arm64.zip', kind: 'zip' } : null;
  if (platform === 'linux')
    return arch === 'x64' ? { name: 'ringzero-linux-x64.zip', kind: 'zip' } : null;
  return null;
}

export interface InstallInfo {
  kind: 'exe' | 'dir' | 'npm' | 'unknown';
  target?: string;
}

function isAppDir(d: string): boolean {
  return existsSync(join(d, 'dist', 'src', 'cli', 'index.js'));
}

function findOnPath(name: string): string | null {
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const p of (process.env.PATH ?? '').split(sep)) {
    if (!p) continue;
    const candidate = join(p, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the installed copy we are running from. `process.execPath` is the
 * embedded Node runtime inside the install dir (SFX payload dir on Windows,
 * the portable dir on macOS/Linux), so the launcher it belongs to is derived
 * from that.
 */
export function detectInstall(): InstallInfo {
  // npm global install: this module lives under <prefix>/node_modules/ringzero.
  const here = fileURLToPath(import.meta.url);
  if (/[\\/]node_modules[\\/]ringzero[\\/]/.test(here)) return { kind: 'npm' };

  const exe = process.execPath;
  const dir = dirname(exe);
  const base = basename(exe);
  if (process.platform === 'win32') {
    // SFX-extracted runtime under %LOCALAPPDATA%\RingZero\<version>.
    if (base === 'node.exe' && isAppDir(dir)) {
      const launcher = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'RingZero', 'ringzero.exe');
      if (existsSync(launcher)) return { kind: 'exe', target: launcher };
      const onPath = findOnPath('ringzero.exe');
      if (onPath) return { kind: 'exe', target: onPath };
    }
    return { kind: 'unknown' };
  }
  if (base === 'node' && isAppDir(dir)) return { kind: 'dir', target: dir };
  return { kind: 'unknown' };
}

export interface LatestRelease {
  tag: string;
  version: string;
  /** asset name → browser_download_url */
  assets: Map<string, string>;
}

/**
 * fetch with a hard timeout. Uses an AbortController + manual timer (NOT
 * `AbortSignal.timeout`) so the timer is cleared when the request settles —
 * leaving a pending timeout timer alive while the process exits crashes
 * Node on Windows (libuv `UV_HANDLE_CLOSING` assert). `Connection: close`
 * keeps undici from parking an idle keep-alive socket that would otherwise
 * crash a fast `process.exit()` on Windows.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { ...init.headers, Connection: 'close' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLatestRelease(): Promise<LatestRelease> {
  const res = await fetchWithTimeout(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    {
      headers: { 'User-Agent': 'ringzero-updater', Accept: 'application/vnd.github+json' },
    },
    15_000,
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    tag_name?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  const assets = new Map<string, string>();
  for (const a of json.assets ?? []) {
    if (a.name && a.browser_download_url) assets.set(a.name, a.browser_download_url);
  }
  return { tag: json.tag_name ?? '', version: (json.tag_name ?? '').replace(/^v/, ''), assets };
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': 'ringzero-updater' } },
    120_000,
  );
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Replace a Windows SFX exe (rename-swap; a running exe can't be overwritten). */
async function updateExe(exePath: string, url: string): Promise<void> {
  const dir = dirname(exePath);
  const tmp = join(dir, 'ringzero.exe.new');
  const old = join(dir, 'ringzero.exe.old');
  await download(url, tmp);
  renameSync(exePath, old);
  renameSync(tmp, exePath);
  // Detached cleanup of the old binary after this process exits.
  const child = spawn('cmd.exe', ['/c', `ping -n 5 127.0.0.1 > nul & del /f /q "${old}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/** Replace a macOS/Linux portable install dir with the freshly extracted zip. */
async function updateDir(installDir: string, url: string, assetName: string): Promise<void> {
  const parent = dirname(installDir);
  const tmp = mkdtempSync(join(tmpdir(), 'ringzero-update-'));
  const zipPath = join(tmp, assetName);
  const out = join(tmp, 'out');
  const extracted = join(out, 'ringzero');
  try {
    await download(url, zipPath);
    extractZip(readFileSync(zipPath), out);
    if (!existsSync(join(extracted, 'ringzero'))) {
      throw new Error(`unexpected zip layout: ${assetName} has no ringzero/ launcher`);
    }
    chmodSync(join(extracted, 'ringzero'), 0o755);
    chmodSync(join(extracted, 'node'), 0o755);
    const old = join(parent, `ringzero.old-${Date.now()}`);
    renameSync(installDir, old);
    renameSync(extracted, installDir);
    // Detached cleanup of the old dir + temp once this process exits.
    const child = spawn('sh', ['-c', `sleep 5; rm -rf -- "${old}" "${tmp}" 2>/dev/null || true`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } finally {
    // If we bailed before the swap, don't leave the download behind.
    if (!existsSync(installDir) || !existsSync(join(installDir, 'node'))) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // detached cleanup will catch it
      }
    }
  }
}

/** Main entry: check for updates and apply if available. Returns exit code. */
export async function runUpdate(): Promise<number> {
  const info = detectInstall();
  const asset = assetFor(process.platform, process.arch);

  console.log(`ringzero ${VERSION}`);
  console.log('Checking for updates…');
  let release: LatestRelease;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    console.error(`could not check for updates: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const cmp = compareVersions(VERSION, release.version);
  if (cmp >= 0) {
    console.log(`You're up to date (${release.version}).`);
    return 0;
  }

  // npm installs update through npm, not self-update. Checked before the
  // asset gate so npm users never see "no prebuilt asset for <platform>".
  if (info.kind === 'npm') {
    console.log('');
    console.log(`A newer version (${release.version}) is available.`);
    console.log('You installed RingZero via npm — upgrade with:');
    console.log('  npm i -g ringzero@latest');
    return 1;
  }

  if (!asset) {
    console.error(
      `A newer version (${release.version}) exists, but there is no prebuilt asset for ` +
        `${process.platform}-${process.arch} yet.`,
    );
    return 1;
  }

  if (info.kind === 'exe' && info.target) {
    const url = release.assets.get(asset.name);
    if (!url) {
      console.error(`release ${release.tag} has no ${asset.name} asset`);
      return 1;
    }
    console.log(`Updating ${VERSION} → ${release.version}…`);
    await updateExe(info.target, url);
    console.log(`Updated to ${release.version}. Restart ringzero to use it.`);
    return 0;
  }

  if (info.kind === 'dir' && info.target) {
    const url = release.assets.get(asset.name);
    if (!url) {
      console.error(`release ${release.tag} has no ${asset.name} asset`);
      return 1;
    }
    console.log(`Updating ${VERSION} → ${release.version}…`);
    await updateDir(info.target, url, asset.name);
    console.log(`Updated to ${release.version}. Restart ringzero to use it.`);
    return 0;
  }

  // Can't self-update: dev checkout or an ad-hoc copy.
  console.log('');
  console.log(`A newer version (${release.version}) is available, but this looks like a `);
  console.log('dev checkout or a manual copy — RingZero can’t self-update here.');
  console.log('Re-run the one-line installer instead:');
  if (process.platform === 'win32') {
    console.log(`  irm ${INSTALL_URL}/install.ps1 | iex`);
  } else {
    console.log(`  curl -fsSL ${INSTALL_URL}/install.sh | sh`);
  }
  return 1;
}
