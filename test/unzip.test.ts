import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32, extractEntry, extractZip, parseZip } from '../src/util/unzip.js';

/** Minimal zip writer (store + deflate), mirroring our build scripts' layout. */
function buildZip(
  entries: Array<{ name: string; data: Buffer; method?: 0 | 8; executable?: boolean }>,
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 0;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = method === 8 ? deflateRawSync(e.data) : e.data;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by (unix)
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((e.executable ? 0o755 : 0o644) << 16, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, eocd]);
}

test('parseZip + extractEntry handles stored and deflated entries', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello stored') },
    { name: 'dir/b.txt', data: Buffer.from('hello deflated'.repeat(50)), method: 8 },
  ]);
  const entries = parseZip(zip);
  assert.equal(entries.length, 2);
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(extractEntry(zip, byName.get('a.txt')!).toString(), 'hello stored');
  assert.equal(extractEntry(zip, byName.get('dir/b.txt')!).toString(), 'hello deflated'.repeat(50));
});

test('extractZip writes files, preserves exec bit, and skips dir entries', () => {
  const zip = buildZip([
    { name: 'ringzero/ringzero', data: Buffer.from('#!/bin/sh\necho hi\n'), executable: true },
    { name: 'ringzero/node', data: Buffer.from('fake node'), executable: true },
    { name: 'ringzero/dist/index.js', data: Buffer.from('console.log(1)') },
  ]);
  const dest = mkdtempSync(join(tmpdir(), 'rz-unzip-'));
  try {
    const names = extractZip(zip, dest);
    assert.deepEqual(names.sort(), [
      'ringzero/dist/index.js',
      'ringzero/node',
      'ringzero/ringzero',
    ]);
    assert.equal(
      readFileSync(join(dest, 'ringzero', 'dist', 'index.js'), 'utf8'),
      'console.log(1)',
    );
    // exec bit applied on posix
    if (process.platform !== 'win32') {
      assert.ok(statSync(join(dest, 'ringzero', 'ringzero')).mode & 0o111);
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('extractZip rejects zip-slip paths', () => {
  const zip = buildZip([{ name: '../evil.txt', data: Buffer.from('x') }]);
  assert.throws(() => extractZip(zip, mkdtempSync(join(tmpdir(), 'rz-zip-'))), /unsafe path/);
});

test('extractEntry detects a corrupted payload', () => {
  const zip = buildZip([{ name: 'a.txt', data: Buffer.from('data') }]);
  const entries = parseZip(zip);
  const good = extractEntry(zip, entries[0]!);
  assert.equal(good.toString(), 'data');
  // flip a byte inside the payload (local header + name → data)
  const bad = Buffer.from(zip);
  const dataStart = entries[0]!.offset + 30 + Buffer.byteLength('a.txt');
  bad[dataStart] = bad[dataStart]! ^ 0xff;
  assert.throws(() => extractEntry(bad, entries[0]!), /crc mismatch/);
});
