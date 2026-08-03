import { spawn } from 'node:child_process';

/**
 * Desktop notifications (opt-out via RINGZERO_NOTIFY=0) for long-running
 * turns and permission prompts. The bell is written to stderr ONLY — stdout
 * is reserved for protocol output (JSON/RPC), so it must never be corrupted.
 */

const enabled = process.env.RINGZERO_NOTIFY !== '0' && !!process.stdout.isTTY;
const minSeconds = Number(process.env.RINGZERO_NOTIFY_MIN ?? 30) || 30;

/** PowerShell single-quote escaping: ' → ''. */
function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

function desktopNotify(title: string, message: string): void {
  try {
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        "$n.BalloonTipIcon = 'Info'",
        `$n.BalloonTipTitle = '${psQuote(title)}'`,
        `$n.BalloonTipText = '${psQuote(message)}'`,
        '$n.Visible = $true',
        '$n.ShowBalloonTip(5000)',
        'Start-Sleep -Seconds 6',
        '$n.Dispose()',
      ].join('; ');
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
    } else if (process.platform === 'darwin') {
      const esc = (s: string): string => s.replace(/"/g, '\\"');
      const child = spawn(
        'osascript',
        ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`],
        { stdio: 'ignore' },
      );
      child.unref();
    } else {
      const child = spawn('notify-send', [title, message], { stdio: 'ignore' });
      child.unref();
    }
  } catch {
    // Desktop notifications are best-effort; never crash the app.
  }
}

/** Fire a notification (bell + desktop bubble). No-op when disabled. */
export function notify(title: string, message: string): void {
  if (!enabled) return;
  process.stderr.write('\x07');
  desktopNotify(title, message);
}

/** Notify when a permission prompt is waiting for the user. */
export function notifyPermission(prompt: string): void {
  notify('RingZero permission', prompt.slice(0, 120));
}

/** Notify that a run finished, only when it took long enough to matter. */
export function notifyRunComplete(seconds: number): void {
  if (seconds < minSeconds) return;
  notify('RingZero done', `Run finished in ${seconds}s`);
}
