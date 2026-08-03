import { spawn } from 'node:child_process';
import type { Tool } from '../kernel/types.js';

const MAX_OUTPUT_CHARS = 100_000;
const MAX_BASH_TIMEOUT = 600_000;
const SECRET_KEY_RE = /(^|_)(key|token|secret|password|passwd|credential|auth)(_|$)/i;
/** Byte cap before we kill a runaway child (UTF-8 worst case ≈ 4 bytes/char). */
const MAX_OUTPUT_BYTES = MAX_OUTPUT_CHARS * 4;

/**
 * Best-effort decode of command output bytes. UTF-8 is the default; if the
 * bytes are not valid UTF-8 (replacement chars), fall back to the platform's
 * legacy console codepage — on Windows CJK systems `cmd`/PowerShell emit
 * GBK/Big5/Shift-JIS unless `chcp 65001` is active. Override with
 * RINGZERO_OS_ENCODING (e.g. "gbk", "big5", "shift_jis", "utf-8").
 */
export function decodeOutput(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  const enc = legacyEncoding();
  if (enc) {
    try {
      const s = new TextDecoder(enc).decode(buf);
      if (!s.includes('\uFFFD')) return s;
    } catch {
      // encoding not available in this Node build (small-icu) → keep UTF-8
    }
  }
  return utf8;
}

let legacyEnc: string | undefined;

function legacyEncoding(): string | undefined {
  const forced = process.env.RINGZERO_OS_ENCODING?.trim().toLowerCase();
  if (forced === 'utf8' || forced === 'utf-8') return undefined;
  if (forced) return forced;
  if (legacyEnc === undefined) legacyEnc = winConsoleEncoding();
  return legacyEnc;
}

/** Map the Windows UI locale to its legacy console codepage encoding. */
function winConsoleEncoding(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const loc = (Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  if (loc.startsWith('zh-cn') || loc.startsWith('zh-sg')) return 'gbk';
  if (loc.startsWith('zh-tw') || loc.startsWith('zh-hk') || loc.startsWith('zh-mo')) return 'big5';
  if (loc.startsWith('ja')) return 'shift_jis';
  if (loc.startsWith('ko')) return 'euc-kr';
  if (loc.startsWith('th')) return 'windows-874';
  if (loc.startsWith('ru')) return 'windows-1251';
  if (loc.startsWith('el')) return 'windows-1253';
  if (loc.startsWith('tr')) return 'windows-1254';
  if (loc.startsWith('he')) return 'windows-1255';
  if (loc.startsWith('ar')) return 'windows-1256';
  if (loc.startsWith('vi')) return 'windows-1258';
  return undefined;
}

/**
 * Environment for child processes with secrets removed, so the model cannot
 * exfiltrate API keys via bash. Set RINGZERO_BASH_FULL_ENV=1 to opt out.
 */
export function sanitizeEnv(): Record<string, string | undefined> {
  if (process.env.RINGZERO_BASH_FULL_ENV === '1') return { ...process.env };
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_KEY_RE.test(k)) out[k] = v;
  }
  return out;
}

export function bashTool(): Tool {
  return {
    definition: {
      name: 'bash',
      description:
        'Run a shell command in the project directory. Combine stdout+stderr. Times out (default 60s). This tool requires permission.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: 'default 60000' },
        },
        required: ['command'],
      },
    },
    async execute(input, ctx) {
      const command = String(input.command ?? '');
      const timeout = Math.min(
        Math.max(1000, Number(input.timeout_ms ?? 60_000)),
        MAX_BASH_TIMEOUT,
      );
      if (!command) return 'error: empty command';
      const out = await runCommand(command, ctx.cwd, timeout, ctx.signal);
      return out.length > MAX_OUTPUT_CHARS
        ? out.slice(0, MAX_OUTPUT_CHARS) + '\n…[output truncated]…'
        : out;
    },
  };
}

const isWin = process.platform === 'win32';

/**
 * Kill the whole process tree: on POSIX the child is spawned detached (own
 * process group) so -pid kills descendants too; on Windows use taskkill /T.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (isWin) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: !isWin,
      env: { ...sanitizeEnv(), FORCE_COLOR: '0', NO_COLOR: '1' },
      signal,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const onData = (d: Buffer): void => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        killTree(child);
        return; // stop accumulating; decode what we captured at close
      }
      chunks.push(d);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const onAbort = (): void => killTree(child);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new Error(`command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      finish(() => reject(err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Buffer chunks then decode once, so multi-byte sequences split across
      // 'data' events (or legacy codepage output) are not corrupted.
      const decoded = decodeOutput(Buffer.concat(chunks));
      const tail = decoded.slice(-MAX_OUTPUT_CHARS);
      finish(() => resolvePromise(tail + (code === 0 ? '' : `\n[exit code ${code}]`)));
    });
  });
}
