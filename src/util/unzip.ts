/**
 * Minimal zero-dependency zip reader (store + deflate), used by the
 * self-updater (`ringzero --update`) to unpack the portable zip without
 * requiring `unzip` to be installed. Only reads entries with the standard
 * local-header layout our build scripts produce; method 0 (stored) and
 * method 8 (deflate) are supported.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) over a byte buffer. */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, always `/`-separated. */
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Byte offset of the local file header. */
  offset: number;
  /** Any unix execute bit set in the external attributes. */
  executable: boolean;
}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Parse the central directory of a zip buffer. */
export function parseZip(buf: Uint8Array): ZipEntry[] {
  const dv = view(buf);
  // End-of-central-directory: scan backwards from the end for its signature.
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');
  const count = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`bad central directory entry ${i}`);
    }
    const nameLen = dv.getUint16(offset + 28, true);
    const extraLen = dv.getUint16(offset + 30, true);
    const commentLen = dv.getUint16(offset + 32, true);
    entries.push({
      name: new TextDecoder().decode(buf.subarray(offset + 46, offset + 46 + nameLen)),
      method: dv.getUint16(offset + 10, true),
      crc: dv.getUint32(offset + 16, true),
      compressedSize: dv.getUint32(offset + 20, true),
      uncompressedSize: dv.getUint32(offset + 24, true),
      offset: dv.getUint32(offset + 42, true),
      executable: ((dv.getUint32(offset + 38, true) >>> 16) & 0o111) !== 0,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress and verify a single entry, returning its raw bytes. */
export function extractEntry(buf: Uint8Array, entry: ZipEntry): Buffer {
  const dv = view(buf);
  if (dv.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new Error(`bad local header for ${entry.name}`);
  }
  const nameLen = dv.getUint16(entry.offset + 26, true);
  const extraLen = dv.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  let out: Buffer;
  if (entry.method === 0) out = Buffer.from(data);
  else if (entry.method === 8) out = inflateRawSync(data);
  else throw new Error(`unsupported zip method ${entry.method} for ${entry.name}`);
  if (out.length !== entry.uncompressedSize) {
    throw new Error(`size mismatch for ${entry.name}`);
  }
  if (crc32(out) !== entry.crc) {
    throw new Error(`crc mismatch for ${entry.name}`);
  }
  return out;
}

/**
 * Extract a zip buffer into `dest`, creating directories as needed. Returns
 * the extracted file paths. Directory entries are skipped; entries that would
 * escape `dest` (zip-slip) are rejected.
 */
export function extractZip(buf: Uint8Array, dest: string): string[] {
  const out: string[] = [];
  for (const entry of parseZip(buf)) {
    if (entry.name.endsWith('/')) continue; // directory entry
    if (entry.name.includes('..') || entry.name.startsWith('/')) {
      throw new Error(`unsafe path in zip: ${entry.name}`);
    }
    const data = extractEntry(buf, entry);
    const target = join(dest, ...entry.name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    if (entry.executable) chmodSync(target, 0o755);
    out.push(entry.name);
  }
  return out;
}
