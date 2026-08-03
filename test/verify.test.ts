import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVerifyHook } from '../src/cli/verify.js';
import { createVerifyTool } from '../src/tools/verify.js';
import type { ToolContext } from '../src/kernel/types.js';

test('makeVerifyHook runs the command once per run, only after write/edit tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-verify-'));
  writeFileSync(
    join(dir, 'verify.cjs'),
    [
      "const fs = require('node:fs');",
      "const { join } = require('node:path');",
      "fs.appendFileSync(join(__dirname, 'count.txt'), 'x');",
      "const n = fs.readFileSync(join(__dirname, 'count.txt'), 'utf8').trim().length;",
      "console.log('VERIFY-RAN-' + n);",
      '',
    ].join('\n'),
  );
  const hook = makeVerifyHook('node verify.cjs', dir);

  // First write → verify runs, output appended.
  const r1 = await hook('write_file', { path: 'a.txt' }, 'created a.txt');
  assert.ok(r1);
  assert.ok(r1.output!.includes('created a.txt'));
  assert.ok(r1.output!.includes('VERIFY-RAN-1'));

  // Second edit → already verified this run.
  const r2 = await hook('edit_file', { path: 'a.txt' }, 'edited a.txt');
  assert.equal(r2, undefined);

  // Non write/edit tools never trigger verification.
  const r3 = await hook('bash', { command: 'echo hi' }, 'hi');
  assert.equal(r3, undefined);

  // Sticky flag: even a later write does not re-run.
  const r4 = await hook('write_file', { path: 'b.txt' }, 'created b.txt');
  assert.equal(r4, undefined);

  assert.equal(readFileSync(join(dir, 'count.txt'), 'utf8').trim(), 'x');
  rmSync(dir, { recursive: true, force: true });
});

test('verify tool runs the command and caps at 3 invocations per run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-vtool-'));
  writeFileSync(join(dir, 'count.txt'), '');
  writeFileSync(
    join(dir, 'verify.cjs'),
    [
      "const fs = require('node:fs');",
      "const { join } = require('node:path');",
      "fs.appendFileSync(join(__dirname, 'count.txt'), 'x');",
      "const n = fs.readFileSync(join(__dirname, 'count.txt'), 'utf8').trim().length;",
      "console.log('VERIFY-RAN-' + n);",
      'if (n < 2) { process.exitCode = 1; }',
      '',
    ].join('\n'),
  );
  const tool = createVerifyTool('node verify.cjs', dir);
  const ctx: ToolContext = {
    cwd: dir,
    home: dir,
    signal: new AbortController().signal,
    ask: async () => true,
  };

  // First run fails (exit 1): output carries the exit code.
  const r1 = await tool.execute({}, ctx);
  assert.ok(r1.includes('VERIFY-RAN-1'), r1);
  assert.ok(r1.includes('[exit code 1]'), r1);

  // Second run passes.
  const r2 = await tool.execute({}, ctx);
  assert.ok(r2.includes('VERIFY-RAN-2'), r2);
  assert.ok(!r2.includes('exit code'), r2);

  // Third run executes.
  const r3 = await tool.execute({}, ctx);
  assert.ok(r3.includes('VERIFY-RAN-3'), r3);

  // Fourth call is skipped without running the command.
  const r4 = await tool.execute({}, ctx);
  assert.ok(r4.includes('skipped'), r4);
  assert.ok(!r4.includes('VERIFY-RAN-4'), r4);

  rmSync(dir, { recursive: true, force: true });
});
