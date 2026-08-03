import { PassThrough } from 'node:stream';

export interface MouseEventData {
  type: 'down' | 'up' | 'wheel';
  button: number;
  x: number;
  y: number;
}

export const SGR_MOUSE_ENABLE = '\x1b[?1000;1006h';
export const SGR_MOUSE_DISABLE = '\x1b[?1000;1006l';

/**
 * Scroll delta (rows) for a normalized wheel button: 0 = wheel up, 1 = wheel
 * down. MouseParser normalizes raw SGR codes (64/65) to these values.
 */
export function wheelDelta(button: number): number {
  return button === 0 ? 2 : button === 1 ? -2 : 0;
}

/**
 * Incremental mouse-sequence parser (SGR `ESC[<b;x;yM|m` + X10 `ESC[M`).
 * Pure and testable; feeds on raw latin1 chunks from stdin.
 */
export class MouseParser {
  private buf = '';

  push(chunk: string): MouseEventData[] {
    this.buf += chunk;
    const out: MouseEventData[] = [];
    let guard = 0;
    while (guard++ < 128) {
      const sgr = this.buf.indexOf('\x1b[<');
      const x10 = this.buf.indexOf('\x1b[M');
      if (sgr === -1 && x10 === -1) {
        this.buf = this.buf.length > 32 ? this.buf.slice(-32) : this.buf;
        return out;
      }
      if (x10 !== -1 && (sgr === -1 || x10 < sgr)) {
        if (this.buf.length < x10 + 6) {
          this.buf = this.buf.slice(x10);
          return out;
        }
        const cb = this.buf.charCodeAt(x10 + 3);
        const x = this.buf.charCodeAt(x10 + 4) - 32;
        const y = this.buf.charCodeAt(x10 + 5) - 32;
        this.buf = this.buf.slice(x10 + 6);
        const isWheel = (cb & 0x40) !== 0;
        const btn = cb & 0x03;
        out.push({
          type: btn === 3 ? 'up' : isWheel ? 'wheel' : 'down',
          button: isWheel ? (cb & 0x7f) - 64 : btn,
          x,
          y,
        });
        continue;
      }
      // SGR sequence
      const endM = this.buf.indexOf('M', sgr);
      const endm = this.buf.indexOf('m', sgr);
      let end = -1;
      let release = false;
      if (endM === -1 && endm === -1) {
        this.buf = this.buf.slice(sgr);
        return out;
      }
      if (endM !== -1 && (endm === -1 || endM < endm)) {
        end = endM;
        release = false;
      } else {
        end = endm;
        release = true;
      }
      const seq = this.buf.slice(sgr + 3, end);
      this.buf = this.buf.slice(end + 1);
      const parts = seq.split(';');
      const b = Number(parts[0]);
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      if (![b, x, y].every(Number.isFinite)) continue;
      if (release) out.push({ type: 'up', button: b, x, y });
      else if (b >= 64) out.push({ type: 'wheel', button: b - 64, x, y });
      else out.push({ type: 'down', button: b, x, y });
    }
    return out;
  }
}

/** Strip mouse sequences (SGR `ESC[<...M|m` and X10 `ESC[M`+3) so Ink never sees them. */
export function filterMouseSequences(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === '\x1b' && s[i + 1] === '[' && s[i + 2] === '<') {
      let e = -1;
      for (let j = i + 3; j < n; j++) {
        if (s[j] === 'M' || s[j] === 'm') {
          e = j;
          break;
        }
      }
      if (e === -1) break; // incomplete sequence → drop remainder of chunk
      i = e + 1;
      continue;
    }
    if (s[i] === '\x1b' && s[i + 1] === 'M') {
      i += 6; // ESC [ M + 3 bytes
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * A PassThrough stdin for Ink that hides real stdin, so we can filter mouse
 * bytes before Ink consumes them. Delegates raw-mode/`isTTY` to the real stdin.
 */
export class FilteredStdin extends PassThrough {
  constructor(private readonly real: NodeJS.ReadStream) {
    super();
  }

  get isTTY(): boolean {
    return (this.real as { isTTY?: boolean }).isTTY === true;
  }

  setRawMode(mode: boolean): this {
    (this.real as { setRawMode?: (m: boolean) => unknown }).setRawMode?.(mode);
    return this;
  }

  ref(): this {
    (this.real as { ref?: () => unknown }).ref?.();
    return this;
  }

  unref(): this {
    (this.real as { unref?: () => unknown }).unref?.();
    return this;
  }
}
