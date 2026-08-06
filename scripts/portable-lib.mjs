// Shared helpers for the portable distribution builds
// (scripts/build-portable.mjs and scripts/build-sfx.mjs).
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

export const isWin = process.platform === 'win32';

export function platName() {
  if (process.platform === 'win32') return `win-${process.arch}`;
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  return `linux-${process.arch}`;
}

/**
 * Stages a runnable copy of the app into `target`:
 * dist/src, package.json, production node_modules (installed fresh from the
 * lockfile), the Node runtime binary, and a `ringzero`/`ringzero.cmd`
 * launcher. Requires `npm run build` to have been run first.
 * Returns the launcher file name.
 */
export function stageApp(root, target) {
  if (!existsSync(join(root, 'dist', 'src', 'cli', 'index.js'))) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }

  cpSync(join(root, 'dist', 'src'), join(target, 'dist', 'src'), { recursive: true });
  copyFileSync(join(root, 'package.json'), join(target, 'package.json'));
  copyFileSync(join(root, 'package-lock.json'), join(target, 'package-lock.json'));
  for (const f of ['README.md', 'LICENSE']) {
    if (existsSync(join(root, f))) copyFileSync(join(root, f), join(target, f));
  }

  // Production-only dependencies, installed fresh from the lockfile. Run npm
  // via its cli.js so this works on Windows without a shell. `npm_execpath`
  // is set by npm when a lifecycle script runs; fall back to the known
  // install layouts (Windows MSI vs. Linux/macOS tarball) otherwise.
  const npmCli =
    process.env.npm_execpath ||
    [
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find((p) => existsSync(p));
  if (!npmCli) {
    console.error('npm-cli.js not found — run this script via `npm run build:portable`.');
    process.exit(1);
  }
  execFileSync(
    process.execPath,
    [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--prefix', target],
    {
      stdio: 'inherit',
    },
  );
  rmSync(join(target, 'package-lock.json'));

  // Node runtime binary (self-contained for end users).
  const nodeBin = isWin ? 'node.exe' : 'node';
  copyFileSync(process.execPath, join(target, nodeBin));

  // Launcher scripts.
  const launcher = isWin ? 'ringzero.cmd' : 'ringzero';
  if (isWin) {
    writeFileSync(
      join(target, launcher),
      '@echo off\r\n' + 'setlocal\r\n' + '"%~dp0node.exe" "%~dp0dist\\src\\cli\\index.js" %*\r\n',
    );
  } else {
    writeFileSync(
      join(target, launcher),
      '#!/bin/sh\n' +
        '# RingZero portable launcher — no Node/npm install needed.\n' +
        'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n' +
        'exec "$DIR/node" "$DIR/dist/src/cli/index.js" "$@"\n',
    );
    chmodSync(join(target, nodeBin), 0o755);
    chmodSync(join(target, launcher), 0o755);
  }
  return launcher;
}

// ---- minimal zip writer (deflate + crc32, node builtins only) --------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Array<{ name: string; data: Buffer; executable?: boolean }>} entries */
export function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = deflateRawSync(e.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 names
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory signature
    ch.writeUInt16LE(20, 4); // version made by (unix)
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); // method: deflate
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((e.executable ? 0o755 : 0o644) << 16, 38); // unix mode
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, eocd]);
}

/**
 * Walks `target` and returns zip entries. `zipRoot` is the top-level folder
 * inside the archive ('' for a flat archive). Files named in
 * `executableNames` get the unix exec bit (only meaningful for posix
 * launchers).
 */
export function collectEntries(target, zipRoot, executableNames = []) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else {
        const rel = relative(target, abs).split(sep).join('/');
        entries.push({
          name: zipRoot ? `${zipRoot}/${rel}` : rel,
          data: readFileSync(abs),
          executable: executableNames.includes(rel),
        });
      }
    }
  };
  walk(target);
  return entries;
}
