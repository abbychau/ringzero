/** Zero-dependency terminal primitives: raw mode, ANSI, key parsing, CJK width. */
import process from 'node:process';
import stringWidth from 'string-width';
import { eastAsianWidthType } from 'get-east-asian-width';

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

/**
 * Terminal display width of a single character (CJK/fullwidth/emoji = 2,
 * combining/ZWJ = 0). Uses `string-width` — the same library Ink renders with
 * — plus East Asian Ambiguous characters (← … · ± etc.) count as 2, matching
 * how CJK terminals (e.g. zh-TW Windows consoles) actually render them.
 * string-width alone counts those as 1, which made rows wider than computed
 * and pushed the right column out of alignment.
 */
export function charWidth(ch: string): number {
  const w = stringWidth(ch);
  // Combining marks (width 0) can be classified 'ambiguous' — only widen
  // characters that already occupy a column.
  return w + (w > 0 && eastAsianWidthType(ch.codePointAt(0)!) === 'ambiguous' ? 1 : 0);
}

export function strWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += charWidth(ch);
  return n;
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
    let i = 0;
    // for..of iterates by code point (raw[i] would split surrogate pairs,
    // making stringWidth return 0 for the halves and never wrapping).
    for (const ch of raw) {
      // Don't split a URL across lines: when a URL starts here and doesn't
      // fit on the current line, move the whole URL to the next line (unless
      // it's wider than a full line, then it degrades to char wrapping).
      if (ch === 'h' && w > 0) {
        const rest = raw.slice(i);
        if (/^https?:\/\//.test(rest)) {
          const urlEnd = rest.search(/[\s<>"']/);
          const urlLen = urlEnd === -1 ? rest.length : urlEnd;
          if (w + strWidth(rest.slice(0, urlLen)) > width) {
            out.push(cur);
            cur = '';
            w = 0;
          }
        }
      }
      const cw = charWidth(ch);
      if (w + cw > width && cur !== '') {
        out.push(cur);
        cur = '';
        w = 0;
      }
      cur += ch;
      w += cw;
      i += ch.length;
    }
    out.push(cur);
  }
  return out;
}

/**
 * Split text into plain parts and URLs. Used to render terminal hyperlinks
 * (OSC 8) without touching the plain text (selection/copy keep the raw URL).
 * Trailing sentence punctuation (.,;:!?…) is kept out of the link.
 */
export function splitUrls(text: string): { url?: string; text: string }[] {
  const out: { url?: string; text: string }[] = [];
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index!;
    const url = m[0]!.replace(/[.,;:!?\]}\)>"']+$/, '');
    if (!url) continue;
    if (idx > last) out.push({ text: text.slice(last, idx) });
    out.push({ url, text: url });
    // Skip only the trimmed URL; trimmed punctuation stays in the plain text.
    last = idx + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The prompt prefix rendered before line 0 of the input. */
export const INPUT_PREFIX = '❯ ';

/**
 * Word-wrap `text` to `width` columns, breaking at word boundaries (hard
 * break for words wider than a row). Whitespace stays attached to the word
 * it follows (like wrap-ansi's trim:false), so concatenating the rows yields
 * the original text. Rows never exceed `width` — measured with charWidth,
 * which treats East Asian Ambiguous chars as 2 columns like CJK terminals.
 */
export function wrapWords(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const words = text.match(/\s*\S+\s*/g);
  if (!words || words.length === 0) return [text];
  const rows: string[] = [];
  let cur = '';
  let curW = 0;
  for (const word of words) {
    const ww = strWidth(word);
    if (curW + ww <= w) {
      cur += word;
      curW += ww;
      continue;
    }
    if (ww > w) {
      // Word wider than a row: fill the current row first, then hard-break.
      let piece = cur;
      let pieceW = curW;
      cur = '';
      curW = 0;
      for (const ch of word) {
        const cw = charWidth(ch);
        if (pieceW + cw > w && piece !== '') {
          rows.push(piece);
          piece = '';
          pieceW = 0;
        }
        piece += ch;
        pieceW += cw;
      }
      if (piece !== '') rows.push(piece);
      continue;
    }
    if (cur !== '') {
      rows.push(cur);
      cur = '';
      curW = 0;
    }
    cur = word;
    curW = ww;
  }
  if (cur !== '') rows.push(cur);
  return rows;
}

/**
 * Terminal rows `text` occupies when word-wrapped the way the input renders
 * it (see `wrapWords`). The input cursor and the layout reservation must both
 * agree with the rendered rows, so they use this instead of assuming uniform
 * full-width rows.
 */
export function wrappedRows(text: string, width: number): number {
  return wrapWords(text, width).length;
}

/**
 * Cursor position of char index `pos` within `text` after word-wrapping (see
 * `wrapWords`): 0-based row in the wrapped output and display column
 * (CJK/ambiguous-aware). Rows are NOT uniform width (word breaks happen
 * early), so the column cannot be derived with `% width` — it must be read
 * from the actual wrapped layout.
 */
export function wrappedCursor(
  text: string,
  pos: number,
  width: number,
): { row: number; col: number } {
  const lines = wrapWords(text, width);
  let remaining = Math.max(0, Math.min(pos, text.length));
  for (let r = 0; r < lines.length; r++) {
    const ln = lines[r]!;
    if (remaining <= ln.length) return { row: r, col: strWidth(ln.slice(0, remaining)) };
    remaining -= ln.length + 1; // +1 for the wrap-inserted newline
  }
  const last = lines[lines.length - 1]!;
  return { row: Math.max(0, lines.length - 1), col: strWidth(last) };
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
