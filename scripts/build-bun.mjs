#!/usr/bin/env node
/**
 * Builds a single-file standalone executable of the RingZero CLI with Bun.
 *
 *   bun run scripts/build-bun.mjs
 *   # → build/bun/ringzero-<platform>-<arch>[.exe]
 *
 * The binary embeds the Bun runtime + the whole app (ink TUI, yoga WASM,
 * providers), so end users need nothing installed. Run on each target
 * platform (bun build --compile cannot cross-compile).
 *
 * ink's optional react-devtools-core peer is resolved to the stub in
 * node_modules/react-devtools-core (only imported when DEV=true).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
const plat =
  process.platform === 'win32'
    ? `win-${arch}`
    : process.platform === 'darwin'
      ? `darwin-${arch}`
      : `linux-${arch}`;
const exeName = process.platform === 'win32' ? 'ringzero.exe' : 'ringzero';
const outfile = join(
  root,
  'build',
  'bun',
  `ringzero-${plat}${process.platform === 'win32' ? '.exe' : ''}`,
);

// ink's optional react-devtools-core peer must resolve for the bundle. It is
// not a real dependency, so ensure a no-op stub exists (npm ci won't install
// it). The stub is only ever imported when DEV=true (opt-in devtools).
const stubDir = join(root, 'node_modules', 'react-devtools-core');
const stub = join(stubDir, 'index.js');
if (!existsSync(stub)) {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'package.json'),
    JSON.stringify({
      name: 'react-devtools-core',
      version: '0.0.0-stub',
      description: 'No-op stub for ink optional peer (only imported when DEV=true).',
      main: 'index.js',
      type: 'module',
    }),
  );
  writeFileSync(
    stub,
    '// No-op stub for ink optional peer.\nexport default { initialize() {}, connectToDevTools() {} };\n',
  );
}

rmSync(outfile, { force: true });

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'cli', 'index.ts')],
  outdir: join(root, 'build', 'bun'),
  compile: true,
  define: { __RINGZERO_VERSION__: JSON.stringify(pkg.version) },
  target: 'bun',
});
if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}

// bun names the binary after the entry file (cli.exe / cli); rename it to
// the platform name afterwards.
const produced = join(root, 'build', 'bun', process.platform === 'win32' ? 'cli.exe' : 'cli');
if (!existsSync(produced)) {
  console.error(`expected ${produced} but the build produced something else`);
  process.exit(1);
}
rmSync(outfile, { force: true });
renameSync(produced, outfile);

const sizeMb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
console.log(`\nbun binary: ${outfile}`);
console.log(`  version   ${pkg.version}`);
console.log(`  runtime   bun ${process.versions.bun} (${process.platform} ${process.arch})`);
console.log(`  size      ${sizeMb} MB`);
