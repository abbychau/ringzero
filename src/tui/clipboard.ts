import { spawn } from 'node:child_process';

export interface ClipboardCmd {
  cmd: string;
  args: string[];
}

/**
 * Clipboard commands per platform, in fallback order. Zero-dep: we shell out
 * to the OS clipboard utility and pipe the text over stdin.
 */
export function pickClipboardCmd(platform: NodeJS.Platform = process.platform): ClipboardCmd[] {
  if (platform === 'win32') return [{ cmd: 'clip', args: [] }];
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  return [
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

/**
 * Write `text` to the OS clipboard, trying each platform command in order.
 * Resolves true on the first success (10s timeout per attempt); false when
 * no clipboard utility is available.
 */
export function copyToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const cmds = pickClipboardCmd(platform);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const tryNext = (index: number): void => {
      const c = cmds[index];
      if (!c) {
        finish(false);
        return;
      }
      const child = spawn(c.cmd, c.args, { stdio: ['pipe', 'ignore', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        tryNext(index + 1);
      }, 10_000);
      child.once('error', () => {
        clearTimeout(timer);
        tryNext(index + 1);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) finish(true);
        else tryNext(index + 1);
      });
      child.stdin.on('error', () => {
        /* EPIPE etc. — the close handler decides the outcome */
      });
      child.stdin.write(text);
      child.stdin.end();
    };
    tryNext(0);
  });
}
