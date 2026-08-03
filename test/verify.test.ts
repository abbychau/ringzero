import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVerifyHook } from '../src/cli/verify.js';

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
