/** Persistent user prefs: disabled tools + permission overrides (config.json). */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PermissionRule } from '../permission/gate.js';
import type { EffortLevel } from '../providers/effort.js';
import { effortLevel } from '../providers/effort.js';

export interface Prefs {
  disabledTools: Set<string>;
  permissionOverrides: Record<string, PermissionRule>;
  /** Yolo mode (auto-allow all tools), toggled via /yolo. */
  yolo: boolean;
  /** Reasoning effort, set via /effort (low/medium/high/max). */
  effort?: EffortLevel;
}

export interface PrefsPaths {
  /** <cwd>/.ringzero/config.json — merges on top of the global file, wins per key. */
  project: string;
  /** <ringzeroHome>/config.json — the file savePrefs writes to. */
  global: string;
}

export const VALID_RULES: PermissionRule[] = ['ask', 'allow', 'deny'];

interface RawPrefs {
  disabledTools?: unknown;
  permissionOverrides?: unknown;
  yolo?: unknown;
  effort?: unknown;
}

/**
 * Merge global then project prefs. Corrupt/missing files are ignored; invalid
 * entries are dropped. Project wins per key for permission overrides; disabled
 * tools are a union (a project can only disable more, never re-enable a
 * globally disabled tool).
 */
export function loadPrefs(paths: PrefsPaths): Prefs {
  const disabledTools = new Set<string>();
  const permissionOverrides: Record<string, PermissionRule> = {};
  // Project file wins for yolo/effort (read global first, then project overwrites).
  let yolo = false;
  let effort: EffortLevel | undefined;
  for (const p of [paths.global, paths.project]) {
    const data = readPrefsFile(p);
    if (!data) continue;
    if (Array.isArray(data.disabledTools)) {
      for (const name of data.disabledTools) {
        if (typeof name === 'string' && name.trim()) disabledTools.add(name.trim());
      }
    }
    if (typeof data.permissionOverrides === 'object' && data.permissionOverrides !== null) {
      for (const [name, rule] of Object.entries(
        data.permissionOverrides as Record<string, unknown>,
      )) {
        if (VALID_RULES.includes(rule as PermissionRule)) {
          permissionOverrides[name] = rule as PermissionRule;
        }
      }
    }
    if (typeof data.yolo === 'boolean') yolo = data.yolo;
    if (typeof data.effort === 'string') {
      const e = effortLevel(data.effort);
      if (e) effort = e;
    }
  }
  return { disabledTools, permissionOverrides, yolo, effort };
}

function readPrefsFile(path: string): RawPrefs | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RawPrefs;
  } catch {
    return null; // corrupt file → ignore
  }
}

/** Persist prefs to the global config.json (best-effort, never throws). */
export function savePrefs(paths: PrefsPaths, prefs: Prefs): void {
  const payload =
    JSON.stringify(
      {
        disabledTools: [...prefs.disabledTools].sort(),
        permissionOverrides: prefs.permissionOverrides,
        yolo: prefs.yolo,
        ...(prefs.effort !== undefined ? { effort: prefs.effort } : {}),
      },
      null,
      2,
    ) + '\n';
  try {
    mkdirSync(dirname(paths.global), { recursive: true });
    writeFileSync(paths.global, payload, 'utf8');
  } catch {
    // Best-effort: never crash the session because prefs can't be persisted.
  }
}
