#!/usr/bin/env node
/**
 * Builds a self-contained, portable zip of the RingZero CLI.
 *
 * End users need nothing — no Node, no npm — just download, unzip and run:
 *
 *   npm run build && npm run build:portable
 *   # → build/portable/ringzero-<platform>-<arch>.zip
 *
 * The zip contains the compiled app, its production dependencies, a Node.js
 * runtime binary, and `ringzero` / `ringzero.cmd` launcher scripts. Everything
 * runs exactly like a dev checkout — no bundling, so the Ink TUI, dynamic
 * imports, and WASM all work. Only the build machine needs Node >= 20 and npm.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, collectEntries, platName, stageApp } from './portable-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build', 'portable');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const zipName = `ringzero-${platName()}.zip`;
const zipRoot = 'ringzero'; // top-level folder inside the zip

const stage = join(outDir, 'stage');
const target = join(stage, zipRoot);
mkdirSync(target, { recursive: true });

const launcher = stageApp(root, target);

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, zipName);
writeFileSync(zipPath, buildZip(collectEntries(target, zipRoot, [launcher])));

rmSync(stage, { recursive: true, force: true });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `\nportable build: ${zipPath}\n` +
    `  version      ${pkg.version}\n` +
    `  runtime      node ${process.version} (${process.platform} ${process.arch})\n` +
    `  size         ${mb(statSync(zipPath).size)}`,
);
