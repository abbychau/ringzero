import type { Dispatch } from 'react';
import type { Runner } from '../cli/runner.js';
import {
  fmtSession,
  fmtUsage,
  SLASH_HINTS,
  slashCommands,
  type Action,
  type AskResponse,
  type Option,
  type State,
} from './state.js';
import { estimateCost, fmtCost, cacheHitRate } from '../kernel/cost.js';
import { copyToClipboard } from './clipboard.js';
import { exportMarkdown } from '../session/export.js';
import type { SessionMessage } from '../kernel/types.js';

/** Everything handleSlashCommand needs from the App component. */
export interface CommandDeps {
  runner: Runner;
  pushSys: (text: string) => void;
  dispatch: Dispatch<Action>;
  openInputModal: (prompt: string) => Promise<string | null>;
  openSelect: (title: string, options: Option[], initialIndex?: number) => Promise<string | null>;
  askRef: { current?: (p: string) => Promise<AskResponse> };
  getState: () => State;
  /** Submit a prompt as a normal user turn (used by /retry). */
  submit: (text: string) => void;
  quit: () => void;
}

const COPY_UNAVAILABLE = '(clipboard unavailable — need clip / pbcopy / xclip / wl-copy / xsel)';

/** Arg syntax + key bindings shown below the command list in /help. */
const HELP_ARGS = [
  'args:',
  '  /model [id] · /copy [n|all] · /permission <tool> <allow|ask|deny>',
  '  /commit <msg> · /resume <id> · /plan [on|off]',
];
const HELP_KEYS = [
  'keys:',
  '  Ctrl+P model · Ctrl+K palette · Ctrl+R search · Ctrl+O expand · Ctrl+T todos',
  '  Tab/Enter pick / command · Ctrl+J / Shift+Enter newline · ↑/↓ navigate menus',
  '  Ctrl+U clear · Ctrl+W delete word · Ctrl+L cycle model · Ctrl+C copy/abort/exit',
  '  drag to select · Ctrl+Y copy selection',
];

export type CopyPick =
  { ok: true; text: string; count: number } | { ok: false; reason: 'none' | 'bad-arg' };

/**
 * Pick the text /copy copies: the last assistant message by default, or the
 * last `n` assistant messages when the arg is a positive integer. Empty
 * assistant blocks (tool-only turns) are skipped.
 */
export function copySelection(msgs: SessionMessage[], arg?: string): CopyPick {
  const assistants = msgs.filter((m) => m.role === 'assistant' && m.content.trim());
  if (arg !== undefined) {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'bad-arg' };
  }
  if (!assistants.length) return { ok: false, reason: 'none' };
  const n = arg === undefined ? 1 : Math.min(Number(arg), assistants.length);
  const picked = assistants.slice(-n);
  return { ok: true, text: picked.map((m) => m.content).join('\n\n'), count: picked.length };
}

/** Handle a "/command …" line: built-in commands, then plugin commands. */
export async function handleSlashCommand(line: string, deps: CommandDeps): Promise<void> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const r = deps.runner;
  const pushSys = deps.pushSys;
  switch (cmd) {
    case 'help': {
      // /help <cmd> shows just that command's hint.
      const q = rest[0]?.replace(/^\//, '');
      if (q) {
        const hint = SLASH_HINTS[q];
        pushSys(hint ? `/${q} — ${hint}` : `(unknown command: /${q})`);
        break;
      }
      // Full listing: one command per line with its hint, names padded into
      // a column; plugin commands appended with a marker.
      const cmds = slashCommands();
      const w = Math.max(...cmds.map((c) => c.length));
      const plugins = r.listPluginCommands();
      const lines = [
        'commands:',
        ...cmds.map((c) => `  /${c.padEnd(w)}  ${SLASH_HINTS[c] ?? ''}`),
        ...(plugins.length ? plugins.map((c) => `  /${c.padEnd(w)}  (plugin)`) : []),
        '',
        ...HELP_ARGS,
        '',
        ...HELP_KEYS,
      ];
      pushSys(lines.join('\n'));
      break;
    }
    case 'usage': {
      const s = deps.getState();
      if (s.totalUsage) {
        const hit = cacheHitRate(s.totalUsage);
        pushSys(
          `session total: ${fmtSession(s.totalUsage)} · cache hit ${Math.round(hit * 100)}% · ≈${fmtCost(estimateCost(s.model, s.totalUsage))}`,
        );
        if (s.usage)
          pushSys(`last turn: ${fmtUsage(s.usage)} ≈${fmtCost(estimateCost(s.model, s.usage))}`);
      } else {
        pushSys('(no usage yet)');
      }
      break;
    }
    case 'model': {
      if (rest[0]) {
        r.setModel(rest[0]);
        deps.dispatch({ type: 'setModel', model: rest[0] });
        pushSys(`model → ${rest[0]}`);
      } else {
        const v = await deps.openInputModal(`model (current ${deps.getState().model}):`);
        if (v && v.trim()) {
          r.setModel(v.trim());
          deps.dispatch({ type: 'setModel', model: v.trim() });
          pushSys(`model → ${v.trim()}`);
        }
      }
      break;
    }
    case 'retry': {
      // Re-run the last submitted prompt as a new turn (same session). The
      // reducer keeps every submitted prompt in state.history.
      const h = deps.getState().history;
      const last = h[h.length - 1];
      if (!last) {
        pushSys('(nothing to retry)');
        break;
      }
      pushSys(`retrying: ${last.slice(0, 60)}${last.length > 60 ? '…' : ''}`);
      deps.submit(last);
      break;
    }
    case 'effort': {
      const levels = ['low', 'medium', 'high', 'max'] as const;
      const current = r.effort ?? 'off';
      if (rest[0] && (levels as readonly string[]).includes(rest[0])) {
        const level = rest[0] as (typeof levels)[number];
        r.setEffort(level);
        deps.dispatch({ type: 'setEffort', effort: level });
        pushSys(`effort → ${level} (persisted)`);
      } else if (rest[0]) {
        pushSys(`effort: unknown level "${rest[0]}" (low | medium | high | max)`);
      } else {
        const v = await deps.openSelect('effort (low | medium | high | max)', [
          { label: 'low', value: 'low' },
          { label: 'medium', value: 'medium' },
          { label: 'high', value: 'high' },
          { label: 'max', value: 'max' },
        ]);
        if (v) {
          r.setEffort(v as (typeof levels)[number]);
          deps.dispatch({ type: 'setEffort', effort: v as (typeof levels)[number] });
          pushSys(`effort → ${v} (persisted)`);
        }
      }
      if (!rest[0] || (levels as readonly string[]).includes(rest[0])) {
        pushSys(`current effort: ${current}`);
      }
      break;
    }
    case 'compact': {
      pushSys('compacting…');
      const res = await r.compact();
      if (!res) pushSys('(nothing to compact)');
      else
        pushSys(`compact: ${res.replaced} msg(s) → summary · ${res.before} → ${res.after} tokens`);
      break;
    }
    case 'context': {
      try {
        const t = r.estimateContext();
        pushSys(
          `context ≈ ${t.toLocaleString()} / ${r.config.contextBudget.toLocaleString()} tokens`,
        );
      } catch (e) {
        pushSys(`context: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
    case 'permission':
      if (rest.length === 2 && ['allow', 'ask', 'deny'].includes(rest[1]!)) {
        r.gate.setOverride(rest[0]!, rest[1] as 'allow' | 'ask' | 'deny');
        pushSys(`${rest[0]} → ${rest[1]}`);
      } else {
        pushSys('usage: /permission <tool> <allow|ask|deny>');
      }
      break;
    case 'yolo': {
      const on = rest[0] === undefined ? !r.yolo : rest[0] === 'on';
      if (rest[0] !== undefined && rest[0] !== 'on' && rest[0] !== 'off') {
        pushSys('usage: /yolo [on|off]');
        break;
      }
      r.setYolo(on);
      deps.dispatch({ type: 'setYolo', yolo: on });
      pushSys(
        `yolo mode ${on ? 'ON — all tools auto-allowed, no permission prompts' : 'OFF'}` +
          (on ? ' (use /yolo off to restore prompts)' : ''),
      );
      break;
    }
    case 'skills': {
      if (rest[0]) {
        if (rest[0] === 'off' && rest[1]) {
          r.disableSkill(rest[1]);
          pushSys(`skill disabled: ${rest[1]}`);
        } else if (await r.enableSkill(rest[0])) {
          pushSys(`skill enabled: ${rest[0]}`);
        } else {
          pushSys(`skill not found: ${rest[0]}`);
        }
      } else {
        const all = r.listSkills();
        pushSys(
          all.length
            ? all
                .map((s) => `${s.name} — ${s.description}${r.hasSkill(s.name) ? ' [on]' : ''}`)
                .join(' · ')
            : '(no skills)',
        );
      }
      break;
    }
    case 'sessions': {
      const list = r.listSessions();
      if (!list.length) {
        pushSys('(no sessions)');
        break;
      }
      const v = await deps.openSelect(
        'Sessions',
        list.map((s) => ({
          label: s.title || s.id,
          value: s.id,
          hint: `${s.id} · ${new Date(s.updated).toISOString().slice(0, 19).replace('T', ' ')}`,
        })),
      );
      if (v) {
        r.resume(v);
        pushSys(`resumed session ${v}`);
      }
      break;
    }
    case 'resume':
      if (rest[0] && r.resume(rest[0])) pushSys(`resumed session ${rest[0]}`);
      else pushSys('usage: /resume <sessionId>  (see /sessions)');
      break;
    case 'new': {
      const res = await deps.askRef.current?.('Start a new session? (current view clears)');
      if (res === 'yes' || res === 'always') {
        r.reset();
        deps.dispatch({ type: 'clear' });
        pushSys('new session');
      } else {
        pushSys('(cancelled)');
      }
      break;
    }
    case 'exit':
      deps.quit();
      break;
    case 'diff': {
      const out = r.gitDiff();
      pushSys(out.length > 2000 ? `${out.slice(0, 2000)}\n…[truncated]…` : out || '(no changes)');
      break;
    }
    case 'status': {
      pushSys(r.gitStatus());
      break;
    }
    case 'commit': {
      let msg = rest.join(' ').trim();
      if (!msg) msg = (await deps.openInputModal('commit message:'))?.trim() ?? '';
      if (!msg) {
        pushSys('(cancelled)');
        break;
      }
      pushSys(r.gitCommit(msg));
      break;
    }
    case 'checkpoint': {
      const sha = r.checkpoint();
      pushSys(
        sha ? `checkpoint saved (${sha.slice(0, 8)})` : '(no session or no changes to snapshot)',
      );
      break;
    }
    case 'rollback': {
      const sha = r.rollback();
      pushSys(sha ? `rolled back to ${sha.slice(0, 8)}` : '(no checkpoints for this session)');
      break;
    }
    case 'plan': {
      const arg = rest[0];
      const on = arg === undefined ? !r.isPlanMode() : arg === 'on';
      if (arg !== undefined && arg !== 'on' && arg !== 'off') {
        pushSys('usage: /plan [on|off]');
        break;
      }
      r.setPlanMode(on);
      deps.dispatch({ type: 'setPlanMode', planMode: on });
      pushSys(
        `plan mode ${on ? 'ON' : 'OFF'}` +
          (on ? ' — next turn plans before changing anything' : ''),
      );
      break;
    }
    case 'todos': {
      const todos = r.listTodos();
      if (todos.length) {
        deps.dispatch({ type: 'setTodos', todos });
        deps.dispatch({ type: 'toggleTodos' });
        pushSys(todos.map((t, i) => `${i + 1}. ${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n'));
      } else {
        pushSys(
          '(no todos)' + (r.isPlanMode() ? ' — plan mode is on, ask the agent to plan first' : ''),
        );
      }
      break;
    }
    case 'tools': {
      // Toggle loop: re-fetch the roster each iteration so the menu reflects
      // changes immediately; Esc closes. Choices persist to config.json. The
      // selection stays on the toggled row between iterations (the roster
      // order is stable: listTools includes disabled tools).
      let index = 0;
      while (true) {
        const tools = r.listTools();
        const v = await deps.openSelect(
          'Tools — Enter toggles, Esc closes',
          tools.map((t) => ({
            label: t.name,
            desc: t.description,
            value: t.name,
            hint: t.enabled ? 'ON' : 'OFF',
          })),
          index,
        );
        if (!v) break;
        const t = tools.find((x) => x.name === v);
        if (!t) break;
        r.setToolEnabled(v, !t.enabled);
        pushSys(`${v} ${t.enabled ? 'disabled' : 'enabled'}`);
        const i = tools.findIndex((x) => x.name === v);
        index = i >= 0 ? i : 0;
      }
      break;
    }
    case 'image': {
      const path = rest[0];
      if (!path) {
        pushSys('usage: /image <path>  (attaches to your next message; /image clear to remove)');
        break;
      }
      if (path === 'clear') {
        deps.dispatch({ type: 'setImage' });
        pushSys('image cleared');
        break;
      }
      try {
        const { loadImage } = await import('../util/image.js');
        const img = loadImage(path);
        deps.dispatch({ type: 'setImage', image: img });
        pushSys(`image attached: ${path} (sent with your next message)`);
      } catch (e) {
        pushSys(`image error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
    case 'copy': {
      const arg = rest[0];
      if (arg === 'all') {
        if (!r.sessionId) {
          pushSys('(no session)');
          break;
        }
        const md = exportMarkdown(r.store, r.sessionId);
        if (md === null) {
          pushSys('(session not found)');
          break;
        }
        const ok = await copyToClipboard(md);
        pushSys(
          ok
            ? `copied ${md.length.toLocaleString()} chars (full transcript) to clipboard`
            : COPY_UNAVAILABLE,
        );
        break;
      }
      const pick = copySelection(r.sessionId ? r.store.load(r.sessionId) : [], arg);
      if (!pick.ok) {
        pushSys(pick.reason === 'bad-arg' ? 'usage: /copy [n|all]' : '(no assistant message yet)');
        break;
      }
      const copied = await copyToClipboard(pick.text);
      pushSys(
        copied
          ? `copied ${pick.count} message(s) · ${pick.text.length.toLocaleString()} chars to clipboard`
          : COPY_UNAVAILABLE,
      );
      break;
    }
    case 'export': {
      const res = r.exportSession(undefined, rest[0]);
      pushSys(res.path ? `exported to ${res.path}` : `export error: ${res.error}`);
      break;
    }
    default:
      if (cmd && (await r.runPluginCommand(cmd, rest))) break;
      pushSys(`unknown command: /${cmd}`);
  }
}
