import type { Dispatch } from 'react';
import type { Runner } from '../cli/runner.js';
import { fmtSession, type Action, type AskResponse, type Option, type State } from './state.js';

/** Everything handleSlashCommand needs from the App component. */
export interface CommandDeps {
  runner: Runner;
  pushSys: (text: string) => void;
  dispatch: Dispatch<Action>;
  openInputModal: (prompt: string) => Promise<string | null>;
  openSelect: (title: string, options: Option[]) => Promise<string | null>;
  askRef: { current?: (p: string) => Promise<AskResponse> };
  getState: () => State;
  quit: () => void;
}

/** Handle a "/command …" line: built-in commands, then plugin commands. */
export async function handleSlashCommand(line: string, deps: CommandDeps): Promise<void> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const r = deps.runner;
  const pushSys = deps.pushSys;
  switch (cmd) {
    case 'help':
      pushSys(
        'commands: /help /usage /context /model [id] /compact /permission <tool> <allow|ask|deny> /skills [name] /sessions /resume <id> /new /exit  · keys: Ctrl+P model · Ctrl+K palette · Ctrl+R search · Ctrl+O expand · Ctrl+J/Shift+Enter newline',
      );
      break;
    case 'usage': {
      const s = deps.getState();
      if (s.totalUsage) pushSys(`session total: ${fmtSession(s.totalUsage)}`);
      else pushSys('(no usage yet)');
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
          hint: new Date(s.updated).toISOString().slice(0, 19).replace('T', ' '),
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
    default:
      if (cmd && (await r.runPluginCommand(cmd, rest))) break;
      pushSys(`unknown command: /${cmd}`);
  }
}
