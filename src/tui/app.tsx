import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { render, Box, Text, useInput, usePaste, useApp, useWindowSize } from 'ink';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import type { AppConfig } from '../config/config.js';
import { Runner } from '../cli/runner.js';
import type { Agent } from '../kernel/agent.js';
import type { ImageInput } from '../kernel/types.js';
import {
  reducer,
  initial,
  layoutBlocks,
  windowRows,
  fmtUsage,
  inputLines,
  slashMatches,
  type Modal,
  type Row,
  type Usage,
  type AskResponse,
  type Option,
  type PaletteItem,
} from './state.js';
import { handleSlashCommand, type CommandDeps } from './commands.js';
import { notifyPermission, notifyRunComplete } from '../cli/notify.js';
import { estimateCost, fmtCost } from '../kernel/cost.js';
import {
  TranscriptRow,
  StatusBar,
  PromptInput,
  ConfirmModal,
  InputModal,
  SelectModal,
  PaletteModal,
  SearchModal,
  SlashSuggest,
} from './components.js';
import {
  MouseParser,
  FilteredStdin,
  filterMouseSequences,
  SGR_MOUSE_ENABLE,
  SGR_MOUSE_DISABLE,
  type MouseEventData,
} from './mouse.js';

interface AppProps {
  runner: Runner;
  askRef: { current?: (p: string) => Promise<AskResponse> };
  favorites: string[];
  initialModel: string;
  sysRef: { current?: (text: string) => void };
  mouseCbRef: { current?: (e: MouseEventData) => void };
  onExit: () => void;
}

function wordStart(s: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && s[i - 1] === ' ') i--;
  while (i > 0 && s[i - 1] !== ' ') i--;
  return i;
}

export function App({
  runner,
  askRef,
  favorites,
  initialModel,
  sysRef,
  mouseCbRef,
  onExit,
}: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initial(initialModel, runner.isPlanMode()));
  const { rows: termRows, columns } = useWindowSize();
  const { exit } = useApp();
  const quit = (): void => {
    onExit();
    exit();
  };
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runningRef = useRef(false);
  const agentRef = useRef<Agent | undefined>(undefined);
  const runnerRef = useRef(runner);
  const stateRef = useRef(state);
  stateRef.current = state;
  const layoutRef = useRef<{ start: number; visible: Row[]; height: number }>({
    start: 0,
    visible: [],
    height: 0,
  });

  const slashItems = useMemo(
    () => slashMatches(state.input, runnerRef.current.listPluginCommands()),
    [state.input],
  );
  const slashH = !state.modal && slashItems.length > 0 ? Math.min(slashItems.length, 8) : 0;
  const headerH = 1;
  const footerH = 2;
  // Collapsed todo strip is 1 line; expanded is one line per item.
  const todosH =
    !state.modal && state.todos.length > 0 ? (state.todosExpanded ? state.todos.length : 1) : 0;
  // Footer = status-or-dropdown(1..slashH) + input(inputLines). Extra rows shrink
  // the transcript so the frame still fits the viewport.
  const transH = Math.max(
    1,
    termRows - headerH - footerH - todosH - (inputLines(state.input) - 1) - Math.max(0, slashH - 1),
  );
  const allRows = useMemo(
    () => layoutBlocks(state.blocks, Math.max(1, columns)),
    [state.blocks, columns],
  );
  const win = useMemo(
    () => windowRows(allRows, transH, state.scroll),
    [allRows, transH, state.scroll],
  );
  layoutRef.current = { start: win.start, visible: win.visible, height: transH };

  const pushSys = useCallback(
    (text: string) => dispatch({ type: 'push', block: { tag: 'sys', text } }),
    [],
  );
  useEffect(() => {
    sysRef.current = pushSys;
  }, [pushSys]);

  useEffect(() => {
    askRef.current = (prompt: string) => {
      notifyPermission(prompt);
      return new Promise<AskResponse>((resolve) => {
        dispatch({ type: 'setModal', modal: { kind: 'confirm', prompt, value: '', resolve } });
      });
    };
  }, [askRef]);

  const runTurn = useCallback(
    async (prompt: string, images?: ImageInput[]) => {
      const t0 = performance.now();
      runningRef.current = true;
      dispatch({ type: 'runStart' });
      const abort = new AbortController();
      abortRef.current = abort;
      const agent = runnerRef.current.agent(abort.signal);
      agentRef.current = agent;
      let usage: Usage | undefined;
      let status = 'idle';
      try {
        for await (const ev of agent.run(prompt, { images })) {
          if (ev.type === 'text') dispatch({ type: 'appendAssistant', delta: ev.text });
          else if (ev.type === 'thinking') dispatch({ type: 'appendThinking', delta: ev.text });
          else if (ev.type === 'tool_start')
            dispatch({
              type: 'push',
              block: { tag: 'tool', name: ev.name, args: ev.args, done: false, expanded: false },
            });
          else if (ev.type === 'tool_result') {
            dispatch({ type: 'setToolOutput', output: ev.output, done: true, name: ev.name });
            if (ev.name === 'todo')
              dispatch({ type: 'setTodos', todos: runnerRef.current.listTodos() });
          } else if (ev.type === 'permission' && !ev.allowed)
            pushSys(`permission denied: ${ev.name}`);
          else if (ev.type === 'compacting') pushSys('compacting context…');
          else if (ev.type === 'finish') usage = ev.usage;
        }
        if (abort.signal.aborted) status = 'aborted';
      } catch (e) {
        if (abort.signal.aborted) status = 'aborted';
        else {
          status = `error: ${e instanceof Error ? e.message : String(e)}`;
          pushSys(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      runningRef.current = false;
      agentRef.current = undefined;
      abortRef.current = undefined;
      let ctx: number | undefined;
      try {
        ctx = runnerRef.current.estimateContext();
      } catch {
        /* ignore */
      }
      const finalStatus =
        status === 'idle' && usage
          ? `idle · ${fmtUsage(usage)} ≈${fmtCost(estimateCost(runnerRef.current.model, usage))}`
          : status;
      dispatch({ type: 'runEnd', usage, status: finalStatus, ctx });
      notifyRunComplete(Math.round((performance.now() - t0) / 1000));
    },
    [pushSys],
  );

  const closeModal = useCallback(() => dispatch({ type: 'setModal', modal: undefined }), []);

  const openInputModal = useCallback(
    (prompt: string): Promise<string | null> =>
      new Promise((resolve) =>
        dispatch({ type: 'setModal', modal: { kind: 'input', prompt, value: '', resolve } }),
      ),
    [],
  );

  const openSelect = useCallback(
    (title: string, options: Option[]): Promise<string | null> =>
      new Promise((resolve) =>
        dispatch({
          type: 'setModal',
          modal: { kind: 'select', title, options, index: 0, resolve },
        }),
      ),
    [],
  );

  const cmdDeps = useMemo<CommandDeps>(
    () => ({
      runner: runnerRef.current,
      pushSys,
      dispatch,
      openInputModal,
      openSelect,
      askRef,
      getState: () => stateRef.current,
      quit,
    }),
    [pushSys, openInputModal, openSelect, quit],
  );

  const runCommand = useCallback((line: string) => handleSlashCommand(line, cmdDeps), [cmdDeps]);

  const submit = useCallback(
    (text: string) => {
      if (runningRef.current) {
        // Mid-run injection: queue the message into the active agent instead of
        // dropping it. The agent aborts its current stream and continues.
        const line = text.trim();
        if (!line) return;
        if (agentRef.current?.inject(line)) {
          dispatch({ type: 'submit', text: line });
          dispatch({ type: 'push', block: { tag: 'user', text: line } });
          pushSys(`✂ injected mid-run: ${line.slice(0, 60)}${line.length > 60 ? '…' : ''}`);
        }
        return;
      }
      const line = text.trim();
      dispatch({ type: 'submit', text: line });
      if (!line) return;
      if (line.startsWith('/')) {
        void runCommand(line);
        return;
      }
      dispatch({ type: 'push', block: { tag: 'user', text: line } });
      const pending = stateRef.current.pendingImage;
      if (pending) dispatch({ type: 'setImage' });
      void runTurn(line, pending ? [pending] : undefined);
    },
    [runCommand, runTurn, pushSys],
  );

  const paletteItems = useCallback(
    (): PaletteItem[] => [
      { label: '/model', hint: 'switch model', run: () => void runCommand('/model') },
      { label: '/usage', run: () => void runCommand('/usage') },
      { label: '/context', hint: 'context token estimate', run: () => void runCommand('/context') },
      { label: '/sessions', hint: 'pick a session', run: () => void runCommand('/sessions') },
      { label: '/compact', hint: 'compact context', run: () => void runCommand('/compact') },
      { label: '/permission', run: () => void runCommand('/permission') },
      { label: '/skills', run: () => void runCommand('/skills') },
      { label: '/plan', hint: 'toggle plan mode', run: () => void runCommand('/plan') },
      { label: '/todos', hint: 'toggle todo list', run: () => void runCommand('/todos') },
      { label: '/new', hint: 'start new session', run: () => void runCommand('/new') },
      { label: '/exit', run: () => quit() },
    ],
    [exit, runCommand],
  );

  const openPalette = useCallback(() => {
    dispatch({
      type: 'setModal',
      modal: { kind: 'palette', query: '', items: paletteItems(), index: 0 },
    });
  }, [paletteItems]);

  const openSearch = useCallback(() => {
    dispatch({
      type: 'setModal',
      modal: {
        kind: 'search',
        query: '',
        index: 0,
        resolve: (v) => {
          if (v !== null) {
            dispatch({ type: 'input', text: v, cursor: v.length });
          }
        },
      },
    });
  }, []);

  const cycleModel = useCallback(() => {
    if (!favorites.length) return;
    const idx = favorites.indexOf(stateRef.current.model);
    const next = favorites[(idx + 1) % favorites.length];
    if (!next) return;
    runnerRef.current.setModel(next);
    dispatch({ type: 'setModel', model: next });
    pushSys(`model → ${next}`);
  }, [favorites, pushSys]);

  // ---- modal key handling ----
  const handleModalKey = useCallback(
    (
      m: Modal,
      input: string,
      key: {
        escape?: boolean;
        return?: boolean;
        upArrow?: boolean;
        downArrow?: boolean;
        backspace?: boolean;
        tab?: boolean;
      },
    ) => {
      const upd = (value: string): void => {
        const cur = stateRef.current.modal;
        if (cur?.kind === 'confirm') dispatch({ type: 'setModal', modal: { ...cur, value } });
        else if (cur?.kind === 'input') dispatch({ type: 'setModal', modal: { ...cur, value } });
      };
      if (key.escape) {
        closeModal();
        if ('resolve' in m) m.resolve(null as never);
        return;
      }
      if (m.kind === 'confirm') {
        if (key.return) {
          const a = m.value.trim().toLowerCase();
          const res: AskResponse = a.startsWith('y')
            ? 'yes'
            : a.startsWith('a')
              ? 'always'
              : a.startsWith('v') || a.startsWith('n')
                ? 'never'
                : 'no';
          closeModal();
          m.resolve(res);
        } else if (key.backspace) upd(m.value.slice(0, -1));
        else if (input) upd(m.value + input);
      } else if (m.kind === 'input') {
        if (key.return) {
          closeModal();
          m.resolve(m.value);
        } else if (key.backspace) upd(m.value.slice(0, -1));
        else if (input) upd(m.value + input);
      } else if (m.kind === 'select') {
        if (key.return) {
          const opt = m.options[m.index];
          closeModal();
          m.resolve(opt ? opt.value : null);
        } else if (key.upArrow)
          dispatch({ type: 'setModal', modal: { ...m, index: Math.max(0, m.index - 1) } });
        else if (key.downArrow)
          dispatch({
            type: 'setModal',
            modal: { ...m, index: Math.min(m.options.length - 1, m.index + 1) },
          });
      } else if (m.kind === 'search') {
        const matches = stateRef.current.history.filter((h) => h.includes(m.query));
        const maxIdx = Math.max(0, matches.length - 1);
        if (key.return) {
          closeModal();
          m.resolve(matches[m.index] ?? null);
        } else if (key.upArrow)
          dispatch({ type: 'setModal', modal: { ...m, index: Math.max(0, m.index - 1) } });
        else if (key.downArrow)
          dispatch({ type: 'setModal', modal: { ...m, index: Math.min(maxIdx, m.index + 1) } });
        else if (key.backspace)
          dispatch({ type: 'setModal', modal: { ...m, query: m.query.slice(0, -1), index: 0 } });
        else if (input)
          dispatch({ type: 'setModal', modal: { ...m, query: m.query + input, index: 0 } });
      } else if (m.kind === 'palette') {
        const filtered = m.items.filter((it) => it.label.includes(m.query));
        const maxIdx = Math.max(0, filtered.length - 1);
        if (key.return) {
          const it = filtered[m.index];
          closeModal();
          if (it) it.run();
        } else if (key.upArrow)
          dispatch({ type: 'setModal', modal: { ...m, index: Math.max(0, m.index - 1) } });
        else if (key.downArrow)
          dispatch({ type: 'setModal', modal: { ...m, index: Math.min(maxIdx, m.index + 1) } });
        else if (key.backspace)
          dispatch({ type: 'setModal', modal: { ...m, query: m.query.slice(0, -1), index: 0 } });
        else if (input)
          dispatch({ type: 'setModal', modal: { ...m, query: m.query + input, index: 0 } });
      }
    },
    [closeModal, dispatch],
  );

  // ---- input key handling ----
  useInput((input, key) => {
    if (input.includes('\x1b')) return; // ignore mouse-relay bytes

    const m = stateRef.current.modal;
    if (m) {
      handleModalKey(m, input, key);
      return;
    }

    const s = stateRef.current;

    // Transcript focus (mouse wheel/click): ↑/↓ scroll the transcript instead
    // of the input history; Esc or scrolling back to the bottom returns focus.
    if (s.transcriptFocus || s.scroll > 0) {
      if (key.upArrow) {
        dispatch({ type: 'scroll', delta: 1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'scroll', delta: -1 });
        if (s.scroll - 1 <= 0) dispatch({ type: 'setTranscriptFocus', focus: false });
        return;
      }
      if (key.pageUp) {
        dispatch({ type: 'scroll', delta: 5 });
        return;
      }
      if (key.pageDown) {
        dispatch({ type: 'scroll', delta: -5 });
        if (s.scroll - 5 <= 0) dispatch({ type: 'setTranscriptFocus', focus: false });
        return;
      }
      if (key.escape) {
        dispatch({ type: 'setTranscriptFocus', focus: false });
        return;
      }
    }

    const setInput = (text: string, cursor: number) => dispatch({ type: 'input', text, cursor });
    const insertAtCursor = (t: string) =>
      setInput(s.input.slice(0, s.cursor) + t + s.input.slice(s.cursor), s.cursor + t.length);
    const slashItems = slashMatches(s.input, runnerRef.current.listPluginCommands());

    // Tab completes the highlighted /-command; ↓/↑ navigate the dropdown (when
    // visible) instead of history.
    if (key.tab && slashItems.length) {
      const cmd = slashItems[Math.min(s.suggestIdx, slashItems.length - 1)]!;
      setInput('/' + cmd, cmd.length + 1);
      return;
    }

    if (key.return) {
      if (key.shift) {
        insertAtCursor('\n'); // Shift+Enter → newline (kitty-capable terminals)
      } else {
        submit(s.input);
      }
      return;
    }
    if (input === '\n') {
      insertAtCursor('\n'); // Ctrl+J → newline
      return;
    }
    if (key.escape) return;
    const c = input.toLowerCase();
    if (key.ctrl && c === 'c') {
      if (runningRef.current) {
        abortRef.current?.abort();
        pushSys('(aborted)');
      } else quit();
      return;
    }
    if (key.ctrl && c === 'k') {
      openPalette();
      return;
    }
    if (key.ctrl && c === 'p') {
      void runCommand('/model');
      return;
    }
    if (key.ctrl && c === 'l') {
      cycleModel();
      return;
    }
    if (key.ctrl && c === 'o') {
      dispatch({ type: 'toggleTool' });
      return;
    }
    if (key.ctrl && c === 't') {
      dispatch({ type: 'toggleTodos' });
      return;
    }
    if (key.ctrl && c === 'r') {
      openSearch();
      return;
    }
    if (key.ctrl && c === 'u') {
      setInput('', 0);
      return;
    }
    if (key.ctrl && c === 'w') {
      const w = wordStart(s.input, s.cursor);
      setInput(s.input.slice(0, w), w);
      return;
    }
    if (key.backspace) {
      if (s.cursor > 0)
        setInput(s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor), s.cursor - 1);
      return;
    }
    if (key.delete) {
      if (s.cursor < s.input.length)
        setInput(s.input.slice(0, s.cursor) + s.input.slice(s.cursor + 1), s.cursor);
      return;
    }
    if (key.leftArrow) setInput(s.input, Math.max(0, s.cursor - 1));
    else if (key.rightArrow) setInput(s.input, Math.min(s.input.length, s.cursor + 1));
    else if (key.home) setInput(s.input, 0);
    else if (key.end) setInput(s.input, s.input.length);
    else if (key.upArrow)
      slashItems.length > 1
        ? dispatch({ type: 'suggestIdx', index: Math.max(0, s.suggestIdx - 1) })
        : dispatch({ type: 'history', index: Math.max(0, s.histIdx - 1) });
    else if (key.downArrow)
      slashItems.length > 1
        ? dispatch({ type: 'suggestIdx', index: Math.min(slashItems.length - 1, s.suggestIdx + 1) })
        : dispatch({ type: 'history', index: Math.min(s.history.length, s.histIdx + 1) });
    else if (key.pageUp) dispatch({ type: 'scroll', delta: 5 });
    else if (key.pageDown) dispatch({ type: 'scroll', delta: -5 });
    else if (input)
      setInput(
        s.input.slice(0, s.cursor) + input + s.input.slice(s.cursor),
        s.cursor + input.length,
      );
  });

  // paste (bracketed paste → single string, CJK-safe)
  usePaste((text) => {
    if (stateRef.current.modal) {
      const m = stateRef.current.modal;
      if (m.kind === 'input' || m.kind === 'confirm') {
        dispatch({ type: 'setModal', modal: { ...m, value: m.value + text } });
      }
      return;
    }
    const s = stateRef.current;
    if (runningRef.current) return;
    dispatch({
      type: 'input',
      text: s.input.slice(0, s.cursor) + text + s.input.slice(s.cursor),
      cursor: s.cursor + text.length,
    });
  });

  // mouse events are parsed in runTui (filtered out of Ink's stdin); dispatch here.
  useEffect(() => {
    mouseCbRef.current = (e: MouseEventData) => {
      // Mouse y is 1-based terminal row; header is row 1, so the transcript
      // starts at row 2 (1-based) below the optional todo strip.
      const s = stateRef.current;
      const todosH = s.todos.length > 0 ? (s.todosExpanded ? s.todos.length : 1) : 0;
      const lineIdx = e.y - 2 - todosH;
      const inTranscript = lineIdx >= 0 && lineIdx < layoutRef.current.height;
      if (e.type === 'wheel') {
        if (!inTranscript) return;
        const d = e.button === 64 ? 2 : e.button === 65 ? -2 : 0;
        if (d) {
          dispatch({ type: 'scroll', delta: d });
          dispatch({ type: 'setTranscriptFocus', focus: true });
        }
      } else if (e.type === 'down') {
        if (!inTranscript) return;
        dispatch({ type: 'setTranscriptFocus', focus: true });
        const row = layoutRef.current.visible[lineIdx];
        if (row) {
          const b = s.blocks[row.blockIdx];
          if (b && b.tag === 'tool' && b.output)
            dispatch({ type: 'toggleTool', index: row.blockIdx });
        }
      }
    };
    return () => {
      mouseCbRef.current = undefined;
    };
  }, []);

  // ---- render ----
  const paletteModal = state.modal?.kind === 'palette' ? state.modal : undefined;
  const paletteItemsFiltered = paletteModal
    ? paletteModal.items.filter((it) => it.label.includes(paletteModal.query))
    : [];
  const searchModal = state.modal?.kind === 'search' ? state.modal : undefined;
  const searchMatches = searchModal
    ? state.history.filter((h) => h.includes(searchModal.query))
    : [];
  const modalEl =
    state.modal?.kind === 'confirm' ? (
      <ConfirmModal prompt={state.modal.prompt} />
    ) : state.modal?.kind === 'input' ? (
      <InputModal prompt={state.modal.prompt} value={state.modal.value} />
    ) : state.modal?.kind === 'select' ? (
      <SelectModal
        title={state.modal.title}
        options={state.modal.options}
        index={state.modal.index}
      />
    ) : searchModal ? (
      <SearchModal query={searchModal.query} matches={searchMatches} index={searchModal.index} />
    ) : paletteModal ? (
      <PaletteModal items={paletteItemsFiltered} index={paletteModal.index} />
    ) : null;

  return (
    <Box flexDirection="column" height={termRows}>
      <Text inverse>
        {' '}
        RingZero · {state.model}
        {state.planMode ? ' · [plan]' : ''}
        {state.pendingImage ? ' · [img]' : ''}
        {runnerRef.current.sessionId ? ` · ${runnerRef.current.sessionId}` : ''}
      </Text>
      {todosH > 0 && (
        <Box flexDirection="column" height={todosH}>
          {state.todosExpanded ? (
            state.todos.map((t, i) => (
              <Text key={i} dimColor={t.done}>
                {' '}
                {i + 1}. {t.done ? '[x]' : '[ ]'} {t.text}
              </Text>
            ))
          ) : (
            <Text dimColor>
              {' '}
              📋 {state.todos.filter((t) => t.done).length}/{state.todos.length} done — Ctrl+T to
              expand
            </Text>
          )}
        </Box>
      )}
      <Box flexDirection="column" height={transH}>
        {win.visible.length === 0 ? (
          <Text dimColor>RingZero — type a message · /help for commands</Text>
        ) : (
          win.visible.map((r, i) => (
            <TranscriptRow key={win.start + i} block={state.blocks[r.blockIdx]!} text={r.text} />
          ))
        )}
      </Box>
      {modalEl ? (
        <Box flexDirection="column">
          {modalEl}
          <Text dimColor> Esc cancels · Enter confirms</Text>
        </Box>
      ) : slashItems.length > 0 ? (
        <SlashSuggest
          items={slashItems}
          index={Math.min(state.suggestIdx, slashItems.length - 1)}
        />
      ) : (
        <StatusBar
          state={state}
          total={allRows.length}
          visible={win.visible.length}
          budget={runner.config.contextBudget}
          session={state.totalUsage}
        />
      )}
      <PromptInput
        value={state.input}
        cursor={state.cursor}
        height={termRows}
        disabled={state.running}
      />
    </Box>
  );
}

/** Entry point: build the Runner, filter mouse bytes from Ink's stdin, and render. */
export async function runTui(config: AppConfig, model?: string, resume?: string): Promise<void> {
  const DBG = process.env.RINGZERO_TUI_DEBUG;
  const mark = (m: string): void => {
    if (DBG) {
      try {
        appendFileSync(DBG, `${Date.now()} ${m}\n`);
      } catch {
        /* ignore */
      }
    }
  };
  mark('start');
  const askRef: { current?: (p: string) => Promise<AskResponse> } = {};
  const sysRef: { current?: (text: string) => void } = {};
  const mouseCbRef: { current?: (e: MouseEventData) => void } = {};
  const runner = new Runner(config, {
    model,
    sessionId: resume,
    ask: (p) => askRef.current!(p),
  });
  await runner.init();
  runner.pluginSay = (t) => sysRef.current?.(t);
  mark('init-done');

  // Intercept stdin: parse mouse events and strip mouse bytes so Ink never
  // renders them as text (this was the source of the garbled click/right-click).
  const filtered = new FilteredStdin(process.stdin);
  const mouse = new MouseParser();
  process.stdout.write(SGR_MOUSE_ENABLE);
  process.stdin.resume();
  const handler = (chunk: Buffer): void => {
    const s = chunk.toString('latin1');
    for (const ev of mouse.push(s)) mouseCbRef.current?.(ev);
    const clean = filterMouseSequences(s);
    if (clean) filtered.write(Buffer.from(clean, 'latin1'));
  };
  process.stdin.on('data', handler);
  const onExit = (): void => {
    process.stdin.removeListener('data', handler);
    process.stdout.write(SGR_MOUSE_DISABLE);
  };
  mark('render-call');
  render(
    <App
      runner={runner}
      askRef={askRef}
      favorites={config.favoriteModels}
      initialModel={runner.model}
      sysRef={sysRef}
      mouseCbRef={mouseCbRef}
      onExit={onExit}
    />,
    {
      stdin: filtered as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      alternateScreen: DBG ? false : true,
      incrementalRendering: DBG ? false : true,
    },
  );
  mark('render-done');
  const uncaught = (e: unknown): void => {
    mark(`uncaught: ${e instanceof Error ? e.stack : String(e)}`);
  };
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', uncaught);
  process.on('exit', () => mark('exit'));
}
