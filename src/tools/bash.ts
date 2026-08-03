import { spawn } from 'node:child_process';
import type { Tool } from '../kernel/types.js';

const MAX_OUTPUT_CHARS = 100_000;
const MAX_BASH_TIMEOUT = 600_000;
const SECRET_KEY_RE = /(^|_)(key|token|secret|password|passwd|credential|auth)(_|$)/i;

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
    let out = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const onData = (d: Buffer): void => {
      out += d.toString();
      if (out.length > MAX_OUTPUT_CHARS) killTree(child);
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
      const tail = out.slice(-MAX_OUTPUT_CHARS);
      finish(() => resolvePromise(tail + (code === 0 ? '' : `\n[exit code ${code}]`)));
    });
  });
}
