/**
 * `ringzero --doctor`: a zero-dep environment self-check. Prints one line per
 * check (✔ ok / ⚠ warn / ✘ fail) and exits 1 when anything is broken, so
 * scripts and CI can gate on it.
 */
import { mkdirSync } from 'node:fs';
import { isGitRepo } from '../tools/git.js';
import type { AppConfig } from '../config/config.js';

export interface DoctorFinding {
  level: 'ok' | 'warn' | 'fail';
  label: string;
  detail?: string;
}

/** Node >= 20.3 is required (AbortSignal.any powers mid-run injection). */
export function checkNodeVersion(): DoctorFinding {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = (major ?? 0) > 20 || ((major ?? 0) === 20 && (minor ?? 0) >= 3);
  return {
    level: ok ? 'ok' : 'fail',
    label: 'Node.js',
    detail: `v${process.versions.node}${ok ? '' : ' — need >= 20.3 (AbortSignal.any)'}`,
  };
}

export function doctorReport(config: AppConfig): DoctorFinding[] {
  const out: DoctorFinding[] = [checkNodeVersion()];

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const term = process.env.TERM;
  out.push({
    level: tty ? 'ok' : 'warn',
    label: 'Terminal',
    detail: tty
      ? 'interactive TTY detected'
      : `not a TTY — the line-based REPL fallback will be used${term === 'dumb' ? ' (TERM=dumb)' : ''}`,
  });

  const { apiUrl, apiKey, anthropicApiKey, geminiApiKey } = config.env;
  let provider: string | null = null;
  if (apiUrl && apiKey) provider = `OpenAI-compatible (${apiUrl})`;
  else if (anthropicApiKey) provider = 'Anthropic';
  else if (geminiApiKey) provider = 'Gemini';
  out.push({
    level: provider ? 'ok' : 'fail',
    label: 'Provider',
    detail: provider ?? 'no API key found (set API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY)',
  });

  const git = isGitRepo(config.cwd);
  out.push({
    level: git ? 'ok' : 'warn',
    label: 'Git repo',
    detail: git
      ? config.cwd
      : 'not a git repo — checkpoints, /rollback, and git_commit will not work',
  });

  out.push({
    level: config.workspace ? 'ok' : 'warn',
    label: 'Workspace sandbox',
    detail: config.workspace
      ? config.workspace
      : 'no sandbox — fs tools are unrestricted (set RINGZERO_WORKSPACE or run inside a git repo)',
  });

  try {
    mkdirSync(config.sessionsDir, { recursive: true });
    out.push({ level: 'ok', label: 'Sessions dir', detail: config.sessionsDir });
  } catch (e) {
    out.push({
      level: 'fail',
      label: 'Sessions dir',
      detail: `${config.sessionsDir} — ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  out.push({
    level: 'ok',
    label: 'Config',
    detail:
      `context budget ${config.contextBudget.toLocaleString()} · max steps ${
        config.maxSteps < 0 ? 'unlimited' : config.maxSteps
      }` +
      ` · effort ${config.env.effort ?? 'off'}` +
      ` · yolo ${config.env.yolo ? 'ON (auto-allow all tools)' : 'off'}` +
      ` · verify ${config.verifyCommand ? 'on' : 'off'}` +
      ` · favorite models: ${config.favoriteModels.join(', ') || '(none)'}`,
  });

  return out;
}

const ICONS = { ok: '✔', warn: '⚠', fail: '✘' } as const;

/** Print the report; returns 1 when any check failed, else 0. */
export function runDoctor(config: AppConfig): number {
  const findings = doctorReport(config);
  for (const f of findings) {
    const line = `${ICONS[f.level]} ${f.label}${f.detail ? ` — ${f.detail}` : ''}`;
    if (f.level === 'fail') console.error(line);
    else console.log(line);
  }
  return findings.some((f) => f.level === 'fail') ? 1 : 0;
}
