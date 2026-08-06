#!/usr/bin/env node
/**
 * Builds a single-file, self-extracting `ringzero-<platform>-<arch>.exe` for
 * Windows, used by the winget package (InstallerType: portable) and by users
 * who want one file instead of a folder.
 *
 *   npm run build && npm run build:sfx
 *   # → build/portable/ringzero-win-x64.exe
 *
 * The launcher is a tiny C# console app (compiled with the .NET Framework
 * csc.exe that ships with Windows) with the app payload — node.exe + dist +
 * production dependencies — embedded as a managed resource. On first run it
 * extracts the payload to %LOCALAPPDATA%\RingZero\<version>\ and then spawns
 * node, so the single .exe works standalone (winget copies only the .exe, not
 * sibling files).
 *
 * Only the build machine needs Node >= 20, npm, and Windows.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, collectEntries, isWin, platName, stageApp } from './portable-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build', 'portable');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!isWin) {
  console.error('SFX build is Windows-only (compiles with .NET Framework csc.exe).');
  process.exit(1);
}

const exeName = `ringzero-${platName()}.exe`;
const stage = join(outDir, 'stage-sfx');
const target = join(stage, 'app');
mkdirSync(target, { recursive: true });

// 1. Stage the app (dist, prod node_modules, node.exe).
const launcher = stageApp(root, target);

// 2. Payload zip (excludes the launcher scripts; flat layout — the
//    extraction dir IS the app root).
const payloadZip = join(stage, 'payload.zip');
writeFileSync(payloadZip, buildZip(collectEntries(target, '', [launcher])));

// 3. Launcher source with the version baked in.
const csPath = join(stage, 'launcher.cs');
writeFileSync(
  csPath,
  readFileSync(join(root, 'scripts', 'ringzero-launcher.cs'), 'utf8').replaceAll(
    '__RINGZERO_VERSION__',
    pkg.version,
  ),
);

// 4. Compile with the .NET Framework compiler that ships with Windows.
const cscCandidates = [
  'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
];
const csc = cscCandidates.find((p) => existsSync(p));
if (!csc) {
  console.error('csc.exe not found — .NET Framework 4.x is required to build the SFX launcher.');
  process.exit(1);
}
const refDir = dirname(csc);
const exePath = join(stage, exeName);
execFileSync(
  csc,
  [
    '/nologo',
    '/optimize+',
    '/target:exe',
    `/out:${exePath}`,
    `/resource:${payloadZip},RingZero.Payload`,
    `/r:${join(refDir, 'System.IO.Compression.dll')}`,
    `/r:${join(refDir, 'System.IO.Compression.FileSystem.dll')}`,
    csPath,
  ],
  { stdio: 'inherit' },
);

// 5. Publish.
mkdirSync(outDir, { recursive: true });
const finalPath = join(outDir, exeName);
copyFileSync(exePath, finalPath);
rmSync(stage, { recursive: true, force: true });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `\nsfx build: ${finalPath}\n` +
    `  version      ${pkg.version}\n` +
    `  runtime      node ${process.version} (${process.platform} ${process.arch})\n` +
    `  size         ${mb(statSync(finalPath).size)}`,
);
