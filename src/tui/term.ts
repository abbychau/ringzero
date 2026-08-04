/** Zero-dependency terminal primitives: raw mode, ANSI, key parsing, CJK width. */
import process from 'node:process';

export type Key =
  | { type: 'char'; char: string }
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'pageup' }
  | { type: 'pagedown' }
  | { type: 'ctrl_left' }
  | { type: 'ctrl_right' }
  | { type: 'ctrl_up' }
  | { type: 'ctrl_down' }
  | { type: 'tab' }
  | { type: 'escape' }
  | { type: 'ctrl_c' }
  | { type: 'ctrl_l' }
  | { type: 'ctrl_p' }
  | { type: 'ctrl_u' }
  | { type: 'ctrl_w' }
  | { type: 'ctrl_a' }
  | { type: 'ctrl_e' }
  | { type: 'unknown'; seq: string };

export function enterRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
}

export function exitRawMode(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

export function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
}

export function exitAltScreen(): void {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
}

export function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function clearEol(): string {
  return '\x1b[K';
}

export function style(
  s: string,
  opts: { color?: number; bold?: boolean; dim?: boolean; reverse?: boolean } = {},
): string {
  const codes: number[] = [];
  if (opts.reverse) codes.push(7);
  if (opts.bold) codes.push(1);
  if (opts.dim) codes.push(2);
  if (opts.color) codes.push(opts.color);
  if (!codes.length) return s;
  return `\x1b[${codes.join(';')}m${s}\x1b[0m`;
}

/** Terminal display width of a string (CJK/fullwidth = 2). */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Wrap text to a display width, respecting CJK double-width chars. */
export function wrapText(s: string, width: number): string[] {
  if (width <= 0) return s.split('\n');
  const out: string[] = [];
  for (const raw of s.split('\n')) {
    if (raw === '') {
      out.push('');
      continue;
    }
    let cur = '';
    let w = 0;
    for (const ch of raw) {
      const cw = charWidth(ch);
      if (w + cw > width && cur !== '') {
        out.push(cur);
        cur = '';
        w = 0;
      }
      cur += ch;
      w += cw;
    }
    out.push(cur);
  }
  return out;
}

export function truncateWidth(s: string, width: number): string {
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * Character index in `text` whose display width matches terminal column `col`
 * (0-based). Rounds down so a double-width (CJK) char never splits.
 */
export function colToCharIndex(text: string, col: number): number {
  if (col <= 0) return 0;
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const cw = charWidth(text[i]!);
    if (w + cw > col) return i;
    w += cw;
  }
  return text.length;
}

function utf8SeqLen(b: number): number {
  if (b < 0x80) return 1;
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 1;
}

function mapControl(b: number): Key {
  switch (b) {
    case 0x0d:
    case 0x0a:
      return { type: 'enter' };
    case 0x09:
      return { type: 'tab' };
    case 0x7f:
      return { type: 'backspace' };
    case 0x03:
      return { type: 'ctrl_c' };
    case 0x0c:
      return { type: 'ctrl_l' };
    case 0x10:
      return { type: 'ctrl_p' };
    case 0x15:
      return { type: 'ctrl_u' };
    case 0x17:
      return { type: 'ctrl_w' };
    case 0x01:
      return { type: 'ctrl_a' };
    case 0x05:
      return { type: 'ctrl_e' };
    default:
      return { type: 'unknown', seq: `ctrl-${b}` };
  }
}

function mapCsi(seq: string): Key {
  switch (seq) {
    case '\x1b[A':
      return { type: 'up' };
    case '\x1b[B':
      return { type: 'down' };
    case '\x1b[C':
      return { type: 'right' };
    case '\x1b[D':
      return { type: 'left' };
    case '\x1b[H':
      return { type: 'home' };
    case '\x1b[F':
      return { type: 'end' };
    case '\x1b[3~':
      return { type: 'delete' };
    case '\x1b[5~':
      return { type: 'pageup' };
    case '\x1b[6~':
      return { type: 'pagedown' };
    case '\x1b[1;5A':
      return { type: 'ctrl_up' };
    case '\x1b[1;5B':
      return { type: 'ctrl_down' };
    case '\x1b[1;5C':
      return { type: 'ctrl_right' };
    case '\x1b[1;5D':
      return { type: 'ctrl_left' };
    default:
      return { type: 'unknown', seq };
  }
}

/**
 * Incremental key parser. Handles ANSI escape sequences and multi-byte UTF-8
 * (CJK) characters, including fragments split across data chunks.
 */
export class KeyReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
  }

  next(): Key | null {
    if (this.buf.length === 0) return null;
    const b0 = this.buf[0]!;
    if (b0 === 0x1b) {
      if (this.buf.length === 1) return null;
      const b1 = this.buf[1]!;
      if (b1 === 0x5b) {
        // CSI: final byte in 0x40..0x7e
        for (let i = 2; i < this.buf.length; i++) {
          const c = this.buf[i]!;
          if (c >= 0x40 && c <= 0x7e) {
            const seq = this.buf.subarray(0, i + 1).toString('latin1');
            this.buf = this.buf.subarray(i + 1);
            return mapCsi(seq);
          }
        }
        return null; // incomplete sequence
      }
      if (b1 === 0x4f) {
        if (this.buf.length < 3) return null;
        this.buf = this.buf.subarray(3);
        return { type: 'unknown', seq: 'ss3' };
      }
      this.buf = this.buf.subarray(1);
      return { type: 'escape' };
    }
    if (b0 < 0x20 || b0 === 0x7f) {
      this.buf = this.buf.subarray(1);
      return mapControl(b0);
    }
    const n = utf8SeqLen(b0);
    if (this.buf.length < n) return null;
    const char = this.buf.subarray(0, n).toString('utf8');
    this.buf = this.buf.subarray(n);
    return { type: 'char', char };
  }
}
