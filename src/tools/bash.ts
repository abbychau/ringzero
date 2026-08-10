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
 *
 * The buffer is first trimmed to a UTF-8 boundary: output cut mid-sequence
 * (byte-cap truncation in runCommand) would otherwise look like invalid UTF-8
 * and wrongly trigger the legacy fallback, mojibake-ing valid UTF-8 content
 * (and its CJK/PUA garbage then breaks TUI row widths).
 */
export function decodeOutput(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  // Byte-cap truncation can cut a multi-byte char in half, making valid UTF-8
  // look invalid. Retry without the trailing partial sequence BEFORE falling
  // back to a legacy codepage (which would mojibake the whole buffer, and its
  // PUA garbage then breaks TUI row widths). Only applies when the trim
  // actually yields clean UTF-8 — a genuinely legacy-encoded buffer is left
  // intact for the codepage decode below.
  const trimmed = trimToUtf8Boundary(buf);
  if (trimmed.length !== buf.length) {
    const t = trimmed.toString('utf8');
    if (!t.includes('\uFFFD')) return t;
  }
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

/** Cut the buffer at the last complete UTF-8 sequence (no trailing partial). */
function trimToUtf8Boundary(buf: Buffer): Buffer {
  let i = buf.length;
  // Back over continuation bytes (10xxxxxx).
  while (i > 0 && (buf[i - 1]! & 0xc0) === 0x80) i--;
  if (i === 0) return Buffer.alloc(0);
  const b = buf[i - 1]!;
  let need = 1;
  if ((b & 0xe0) === 0xc0) need = 2;
  else if ((b & 0xf0) === 0xe0) need = 3;
  else if ((b & 0xf8) === 0xf0) need = 4;
  return buf.length - (i - 1) >= need ? buf : buf.subarray(0, i - 1);
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
  const shellNote = hasBunShell()
    ? ' Shell: POSIX (bun shell) — ls, pwd, grep, tail and pipes work on every platform.'
    : isWin
      ? ' Shell: cmd.exe (Windows) — no grep/tail/ls/cat. Use the fs tools (list_dir, read_file, grep, glob), or cmd/PowerShell natives: dir, type, findstr, where.'
      : ' Shell: /bin/sh (POSIX).';
  return {
    definition: {
      name: 'bash',
      description:
        'Run a shell command in the project directory. Combine stdout+stderr. Times out (default 60s). This tool requires permission.' +
        shellNote,
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

/** True when running under Bun (bun shell `$` available, no import needed). */
function hasBunShell(): boolean {
  return typeof (globalThis as { Bun?: { $?: unknown } }).Bun?.$ === 'function';
}

/**
 * Run a command through Bun's cross-platform shell (`$`): POSIX syntax works
 * on every platform (Windows included — no cmd.exe/PowerShell quirks). Only
 * used when running under Bun; plain Node keeps the native spawn path below.
 *
 * Bun shell in 1.3.x has no kill/timeout API, so the timeout and abort are
 * implemented by racing — the shell child may linger in the background until
 * the command itself finishes. The node path keeps the full process-tree
 * kill.
 */
async function runCommandBun(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  // Bun's shell `$` is only reachable at runtime under Bun; type it loosely so
  // plain-Node builds still typecheck (the global is absent there).
  type BunShell = {
    cwd(dir: string): BunShell;
    env(env: Record<string, string | undefined>): BunShell;
    quiet(): BunShell;
    nothrow(): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }>;
  };
  const bun = (globalThis as unknown as { Bun?: { $: <T>(...v: unknown[]) => T } }).Bun;

  const task = async (): Promise<string> => {
    // `$` only accepts tagged-template calls; construct the strings object
    // with `raw` so the full command is interpolated as one argument.
    const strings = { raw: [command] } as unknown as TemplateStringsArray;
    const shell = bun!.$<BunShell>(strings);
    const r = await shell
      .cwd(cwd)
      .env({ ...sanitizeEnv(), FORCE_COLOR: '0', NO_COLOR: '1' })
      .quiet()
      .nothrow();
    const out = Buffer.concat([Buffer.from(r.stdout), Buffer.from(r.stderr)]);
    const decoded = decodeOutput(out);
    // Slice on code points so a surrogate pair can't be split in half.
    const tail = Array.from(decoded).slice(-MAX_OUTPUT_CHARS).join('');
    return tail + (r.exitCode === 0 ? '' : `\n[exit code ${r.exitCode}]`);
  };

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(
      () => reject(new Error(`command timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    onAbort = (): void => reject(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([task(), timeout, abort]).finally(() => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  // Under Bun, use the cross-platform shell so POSIX commands (ls, pwd, tail)
  // work on Windows too.
  if (hasBunShell()) {
    return runCommandBun(command, cwd, timeoutMs, signal);
  }
  return runCommandNode(command, cwd, timeoutMs, signal);
}

function runCommandNode(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Cross-platform: spawn through the platform's default shell (cmd.exe on
    // Windows — present on every machine, unlike git-bash). FS operations are
    // done by the native tools (list_dir/read_file/grep/…) instead of the
    // shell, so the shell only runs what the dedicated tools can't.
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
      // Slice on code points so a surrogate pair can't be split in half.
      const tail = Array.from(decoded).slice(-MAX_OUTPUT_CHARS).join('');
      finish(() => resolvePromise(tail + (code === 0 ? '' : `\n[exit code ${code}]`)));
    });
  });
}
