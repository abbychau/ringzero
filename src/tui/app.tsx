import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { render, Box, Text, useInput, usePaste, useApp, useWindowSize } from 'ink';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';
import type { AppConfig } from '../config/config.js';
import { Runner } from '../cli/runner.js';
import { CONTINUE_PROMPT, type Agent } from '../kernel/agent.js';
import type { ImageInput } from '../kernel/types.js';
import {
  reducer,
  initial,
  layoutBlocks,
  windowRows,
  inputLines,
  slashMatches,
  selectionRange,
  selectionText,
  shiftSelect,
  type Modal,
  type Row,
  type Selection,
  type Usage,
  type AskResponse,
  type Option,
  type PaletteItem,
} from './state.js';
import { handleSlashCommand, type CommandDeps } from './commands.js';
import { notifyPermission, notifyRunComplete } from '../cli/notify.js';
import {
  TranscriptRow,
  StatusBar,
  Sidebar,
  sidebarTextLines,
  SIDEBAR_W,
  PromptInput,
  ConfirmModal,
  InputModal,
  SelectModal,
  PaletteModal,
  SearchModal,
  SlashSuggest,
} from './components.js';
import { truncateWidth, colToCharIndex } from './term.js';
import { copyToClipboard } from './clipboard.js';
import {
  MouseParser,
  FilteredStdin,
  filterMouseSequences,
  wheelDelta,
  SGR_MOUSE_ENABLE,
  SGR_MOUSE_DISABLE,
  type MouseEventData,
} from './mouse.js';

interface AppProps {
  runner: Runner;
  askRef: { current?: (p: string) => Promise<AskResponse> };
  promptUserRef: { current?: (p: string) => Promise<string | null> };
  favorites: string[];
  initialModel: string;
  sysRef: { current?: (text: string) => void };
  mouseCbRef: { current?: (e: MouseEventData) => void };
  onExit: () => void;
}

/** Smallest main-pane width (cols) that still keeps the sidebar on screen. */
const SIDEBAR_MIN_MAIN = 64;
/** Blank column between the transcript and the sidebar. */
const SIDEBAR_GAP = 1;

/**
 * Rows consumed by the open modal, including the "Esc cancels · Enter confirms"
 * hint line. Used to size the transcript so the frame never overflows the
 * viewport (overflow makes Ink shrink flex children and garble the layout).
 */
function modalHeight(m: Modal, history: string[]): number {
  const hint = 1;
  switch (m.kind) {
    case 'confirm':
    case 'input':
      return 2 + hint;
    case 'select': {
      const WINDOW = 10;
      const start = Math.max(
        0,
        Math.min(m.index - Math.floor(WINDOW / 2), m.options.length - WINDOW),
      );
      const shown = Math.min(WINDOW, Math.max(0, m.options.length - start));
      return (
        1 + // title
        (start > 0 ? 1 : 0) + // "… N more above"
        shown +
        (m.options.length - start - shown > 0 ? 1 : 0) + // "… N more below"
        hint
      );
    }
    case 'search': {
      const matches = history.filter((h) => h.includes(m.query));
      const shown = Math.min(8, matches.length);
      return 2 + shown + (matches.length === 0 ? 1 : 0) + hint;
    }
    case 'palette': {
      const shown = Math.min(10, m.items.filter((it) => it.label.includes(m.query)).length);
      return 1 + shown + hint;
    }
  }
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
  promptUserRef,
  favorites,
  initialModel,
  sysRef,
  mouseCbRef,
  onExit,
}: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(
    reducer,
    initial(initialModel, runner.isPlanMode(), runner.yolo),
  );
  const { rows: termRows, columns } = useWindowSize();
  // Narrow terminals (< SIDEBAR_W + gap + SIDEBAR_MIN_MAIN cols) fall back to
  // the full-width layout so 80-col terminals stay usable.
  const showSidebar = columns >= SIDEBAR_W + SIDEBAR_GAP + SIDEBAR_MIN_MAIN;
  const mainW = showSidebar ? columns - SIDEBAR_W - SIDEBAR_GAP : columns;
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
  const layoutRef = useRef<{
    start: number;
    visible: Row[];
    height: number;
    mainW: number;
    headerH: number;
    /** Selectable text lines of the sidebar (empty when hidden). */
    sidebarRows: Row[];
  }>({
    start: 0,
    visible: [],
    height: 0,
    mainW: 0,
    headerH: 1,
    sidebarRows: [],
  });
  /** Mouse-down position while dragging: { pane, row, col, moved }. */
  const dragRef = useRef<{
    pane: 'transcript' | 'sidebar';
    row: number;
    col: number;
    moved: boolean;
  } | null>(null);

  const slashItems = useMemo(
    () => slashMatches(state.input, runnerRef.current.listPluginCommands()),
    [state.input],
  );
  // With the sidebar, header and status bar live inside it (no rows of their
  // own); the fallback full-width layout keeps one row each.
  const headerH = showSidebar ? 0 : 1;
  // Collapsed todo strip is 1 line; expanded is one line per item.
  const todosH =
    !state.modal && state.todos.length > 0 ? (state.todosExpanded ? state.todos.length : 1) : 0;
  const inputLinesN = inputLines(state.input);
  // Rows taken by the bottom section (modal, slash list, or status bar) plus the
  // input. The transcript gets exactly the remaining rows so the frame never
  // overflows the viewport: Ink shrinks overflowing flex children, which garbles
  // the layout (e.g. the first row of every box disappears).
  const bottomCap = Math.max(1, termRows - headerH - todosH - inputLinesN - 1);
  const slashH =
    !state.modal && slashItems.length > 0 ? Math.min(slashItems.length, 8, bottomCap) : 0;
  const bottomH = state.modal
    ? Math.min(modalHeight(state.modal, state.history), bottomCap)
    : slashH > 0
      ? slashH
      : showSidebar
        ? 0
        : 1; // full-width status bar
  const transH = Math.max(1, termRows - headerH - todosH - bottomH - inputLinesN);
  // Items actually shown: on tiny terminals the list is capped to fit.
  const shownSlash = slashItems.slice(0, slashH);
  const allRows = useMemo(
    () => layoutBlocks(state.blocks, Math.max(1, mainW)),
    [state.blocks, mainW],
  );
  const win = useMemo(
    () => windowRows(allRows, transH, state.scroll),
    [allRows, transH, state.scroll],
  );
  const sidebarRows = showSidebar
    ? sidebarTextLines(
        state,
        state.model,
        runnerRef.current.sessionId,
        runner.config.contextBudget,
        basename(runnerRef.current.config.cwd),
        allRows.length,
        win.visible.length,
        SIDEBAR_W,
        todosH + transH,
      ).map((text) => ({ blockIdx: 0, text }))
    : [];
  layoutRef.current = {
    start: win.start,
    visible: win.visible,
    height: transH,
    mainW,
    headerH,
    sidebarRows,
  };

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

  const runTurnRef = useRef<(prompt: string, images?: ImageInput[]) => Promise<void>>(
    async () => {},
  );

  // Yolo auto-continue counter: capped so a runaway loop can't burn tokens
  // forever; reset whenever the user submits a fresh prompt (submit handler).
  const autoContRef = useRef(0);

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
      let finishReason: 'done' | 'max_steps' = 'done';
      let hitSteps = 0;
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
          else if (ev.type === 'finish') {
            usage = ev.usage;
            finishReason = ev.reason;
            hitSteps = ev.steps;
          }
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
      // Usage/ctx are shown by the StatusBar/sidebar, so idle needs no suffix.
      const finalStatus = status === 'idle' ? 'idle' : status;
      dispatch({ type: 'runEnd', usage, status: finalStatus, ctx });
      notifyRunComplete(Math.round((performance.now() - t0) / 1000));
      // Step cap hit and the run wasn't aborted: yolo auto-continues (bounded);
      // otherwise ask whether to keep going. Continuation turns reuse the full
      // history still in context.
      if (finishReason === 'max_steps' && !abort.signal.aborted) {
        if (runnerRef.current.yolo && autoContRef.current < 3) {
          autoContRef.current++;
          pushSys(`yolo mode — auto-continuing (${autoContRef.current}/3)`);
          await runTurnRef.current?.(CONTINUE_PROMPT);
        } else if (runnerRef.current.yolo) {
          pushSys('yolo mode — step cap hit repeatedly, stopping (use /yolo off to review)');
        } else {
          const answer = await askRef.current?.(`已達步數上限 (${hitSteps}),要繼續嗎?`);
          if (answer === 'yes') await runTurnRef.current?.(CONTINUE_PROMPT);
        }
      }
    },
    [pushSys],
  );

  useEffect(() => {
    runTurnRef.current = runTurn;
  }, [runTurn]);

  const closeModal = useCallback(() => dispatch({ type: 'setModal', modal: undefined }), []);

  const openInputModal = useCallback(
    (prompt: string): Promise<string | null> =>
      new Promise((resolve) =>
        dispatch({ type: 'setModal', modal: { kind: 'input', prompt, value: '', resolve } }),
      ),
    [],
  );

  // ask_user tool: reuse the input modal, with a desktop notification while
  // the prompt waits (same as permission prompts).
  useEffect(() => {
    promptUserRef.current = (prompt: string) => {
      notifyPermission(prompt);
      return openInputModal(prompt);
    };
  }, [promptUserRef, openInputModal]);

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
      autoContRef.current = 0;
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
      { label: '/yolo', hint: 'auto-allow all tools', run: () => void runCommand('/yolo') },
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

  // Copy a selection to the OS clipboard (Ctrl+Y, or Ctrl+C while a
  // selection is active — the standard terminal behavior).
  const copySelection = (sel: Selection): void => {
    const rows = sel.pane === 'sidebar' ? layoutRef.current.sidebarRows : allRows;
    const text = selectionText(rows, sel);
    if (text) {
      pushSys('copying selection…');
      void copyToClipboard(text).then((ok) => {
        pushSys(
          ok
            ? `copied selection · ${text.length.toLocaleString()} chars to clipboard`
            : '(clipboard unavailable — need clip / pbcopy / xclip / wl-copy / xsel)',
        );
      });
    } else {
      pushSys('(empty selection)');
    }
  };

  // ---- input key handling ----
  useInput((input, key) => {
    if (input.includes('\x1b')) return; // ignore mouse-relay bytes

    const m = stateRef.current.modal;
    if (m) {
      handleModalKey(m, input, key);
      return;
    }

    const s = stateRef.current;

    // Copy selection to the clipboard (Ctrl+Y) — works whenever a selection
    // exists, whether or not the transcript has focus.
    if (key.ctrl && input === 'y') {
      if (s.selection) copySelection(s.selection);
      return;
    }

    // Transcript focus (mouse wheel/click): ↑/↓ scroll the transcript instead
    // of the input history; Esc or scrolling back to the bottom returns focus.
    if (s.transcriptFocus || s.scroll > 0) {
      const fromRow = Math.max(0, layoutRef.current.start + layoutRef.current.visible.length - 1);
      if (key.upArrow && key.shift) {
        dispatch({
          type: 'setSelection',
          selection: shiftSelect(s.selection, allRows.length, fromRow, -1),
        });
        return;
      }
      if (key.downArrow && key.shift) {
        dispatch({
          type: 'setSelection',
          selection: shiftSelect(s.selection, allRows.length, fromRow, 1),
        });
        return;
      }
      if (key.pageUp && key.shift) {
        dispatch({
          type: 'setSelection',
          selection: shiftSelect(s.selection, allRows.length, fromRow, -5),
        });
        return;
      }
      if (key.pageDown && key.shift) {
        dispatch({
          type: 'setSelection',
          selection: shiftSelect(s.selection, allRows.length, fromRow, 5),
        });
        return;
      }
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
        if (s.selection) dispatch({ type: 'setSelection', selection: undefined });
        else dispatch({ type: 'setTranscriptFocus', focus: false });
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
      // With an active selection Ctrl+C copies it (terminal convention);
      // otherwise it aborts the run or exits.
      if (s.selection) {
        copySelection(s.selection);
      } else if (runningRef.current) {
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
      // Mouse y is 1-based terminal row. The first content row (todos or
      // transcript) sits at terminal row 1+headerH: with the sidebar the header
      // lives inside it (headerH 0), otherwise it takes row 1 (headerH 1).
      const s = stateRef.current;
      const todosH = !s.modal && s.todos.length > 0 ? (s.todosExpanded ? s.todos.length : 1) : 0;
      const lay = layoutRef.current;
      // Column layout: transcript is [1, mainW], a blank gap sits at mainW+1,
      // and the sidebar box starts at mainW+2.
      const inSidebar = e.x > lay.mainW + SIDEBAR_GAP;
      const inMain = e.x <= lay.mainW;
      // Transcript row index (0-based into lay.visible).
      const lineIdxRaw = e.y - 1 - lay.headerH - todosH;
      const lineIdx = Math.max(0, Math.min(lay.height - 1, lineIdxRaw));
      const inTranscript = lineIdxRaw >= 0 && lineIdxRaw < lay.height;
      // Sidebar content row index (0-based into lay.sidebarRows); the box's top
      // border adds one more row above the transcript's first line.
      const sidebarIdxRaw = e.y - 2 - lay.headerH - todosH;
      const sidebarIdx = Math.max(0, Math.min(lay.sidebarRows.length - 1, sidebarIdxRaw));
      const inSidebarContent = sidebarIdxRaw >= 0 && sidebarIdxRaw < lay.sidebarRows.length;
      // Terminal column (1-based x) → character index inside the row text,
      // rounded down so a click on a double-width CJK char selects the char.
      const colAt = (li: number, x: number): number => {
        const r = lay.visible[li];
        return r ? colToCharIndex(r.text, Math.max(0, x - 1)) : 0;
      };
      // Sidebar text starts after the '│ ' border ('│' at mainW+2, text at
      // mainW+4 once the gap column is accounted for).
      const colAtSidebar = (li: number, x: number): number =>
        colToCharIndex(lay.sidebarRows[li]?.text ?? '', Math.max(0, x - lay.mainW - 4));
      if (e.type === 'wheel') {
        dragRef.current = null;
        if (!inMain || !inTranscript) return;
        const d = wheelDelta(e.button);
        if (d) {
          dispatch({ type: 'scroll', delta: d });
          dispatch({ type: 'setTranscriptFocus', focus: true });
        }
      } else if (e.type === 'down') {
        if (inSidebar) {
          if (!inSidebarContent) return;
          dispatch({ type: 'setTranscriptFocus', focus: true });
          dragRef.current = {
            pane: 'sidebar',
            row: sidebarIdx,
            col: colAtSidebar(sidebarIdx, e.x),
            moved: false,
          };
        } else if (inMain) {
          if (!inTranscript) return;
          dispatch({ type: 'setTranscriptFocus', focus: true });
          const r = lay.visible[lineIdx];
          if (r)
            dragRef.current = {
              pane: 'transcript',
              row: lay.start + lineIdx,
              col: colAt(lineIdx, e.x),
              moved: false,
            };
        }
        // Clicks on the gap column do nothing.
      } else if (e.type === 'drag') {
        if (!dragRef.current || e.button !== 0) return;
        dragRef.current.moved = true;
        if (dragRef.current.pane === 'sidebar') {
          if (!inSidebarContent) return;
          dispatch({
            type: 'setSelection',
            selection: {
              pane: 'sidebar',
              anchorRow: dragRef.current.row,
              anchorCol: dragRef.current.col,
              headRow: sidebarIdx,
              headCol: colAtSidebar(sidebarIdx, e.x),
            },
          });
        } else {
          if (!inTranscript) return;
          const r = lay.visible[lineIdx];
          if (r)
            dispatch({
              type: 'setSelection',
              selection: {
                pane: 'transcript',
                anchorRow: dragRef.current.row,
                anchorCol: dragRef.current.col,
                headRow: lay.start + lineIdx,
                headCol: colAt(lineIdx, e.x),
              },
            });
        }
      } else if (e.type === 'up') {
        const anchor = dragRef.current;
        dragRef.current = null;
        if (!anchor) return;
        if (!anchor.moved) {
          // Plain click (no drag): drop any active selection; toggle tool
          // output when the click landed on a transcript tool row.
          dispatch({ type: 'setSelection', selection: undefined });
          if (anchor.pane === 'transcript') {
            const r = lay.visible[anchor.row - lay.start];
            if (r) {
              const b = s.blocks[r.blockIdx];
              if (b && b.tag === 'tool' && b.output)
                dispatch({ type: 'toggleTool', index: r.blockIdx });
            }
          }
        } else if (anchor.pane === 'sidebar') {
          // Release inside the sidebar: finalize the selection, or clear it if
          // the drag collapsed back to a single point.
          if (!inSidebarContent) return;
          const headCol = colAtSidebar(sidebarIdx, e.x);
          if (sidebarIdx === anchor.row && headCol === anchor.col)
            dispatch({ type: 'setSelection', selection: undefined });
          else
            dispatch({
              type: 'setSelection',
              selection: {
                pane: 'sidebar',
                anchorRow: anchor.row,
                anchorCol: anchor.col,
                headRow: sidebarIdx,
                headCol,
              },
            });
        } else if (inTranscript) {
          // Release inside the transcript: finalize the selection, or clear it
          // if the drag collapsed back to a single point.
          const r = lay.visible[lineIdx];
          if (r) {
            const headCol = colAt(lineIdx, e.x);
            if (lay.start + lineIdx === anchor.row && headCol === anchor.col)
              dispatch({ type: 'setSelection', selection: undefined });
            else
              dispatch({
                type: 'setSelection',
                selection: {
                  pane: 'transcript',
                  anchorRow: anchor.row,
                  anchorCol: anchor.col,
                  headRow: lay.start + lineIdx,
                  headCol,
                },
              });
          }
        }
        // Release outside either pane: keep the selection as-is.
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
      {!showSidebar && <Text inverse> RingZero · {basename(runnerRef.current.config.cwd)}</Text>}
      <Box flexDirection="row" height={todosH + transH}>
        <Box flexDirection="column" width={mainW}>
          {todosH > 0 && (
            <Box flexDirection="column" height={todosH}>
              {state.todosExpanded ? (
                state.todos.map((t, i) => (
                  <Text key={i} dimColor={t.done}>
                    {' '}
                    {i + 1}. {t.done ? '[x]' : '[ ]'} {truncateWidth(t.text, mainW)}
                  </Text>
                ))
              ) : (
                <Text dimColor>
                  {' '}
                  📋 {state.todos.filter((t) => t.done).length}/{state.todos.length} done — Ctrl+T
                  to expand
                </Text>
              )}
            </Box>
          )}
          <Box flexDirection="column" height={transH}>
            {win.visible.map((r, i) => {
              const sel =
                state.selection && state.selection.pane === 'transcript'
                  ? selectionRange(state.selection, win.start + i, r.text.length)
                  : undefined;
              return (
                <TranscriptRow
                  key={win.start + i}
                  block={state.blocks[r.blockIdx]!}
                  text={r.text}
                  sel={sel ?? undefined}
                />
              );
            })}
          </Box>
        </Box>
        {showSidebar && <Text> </Text>}
        {showSidebar && (
          <Sidebar
            state={state}
            model={state.model}
            sessionId={runnerRef.current.sessionId}
            budget={runnerRef.current.config.contextBudget}
            height={todosH + transH}
            cwdName={basename(runnerRef.current.config.cwd)}
            total={allRows.length}
            visible={win.visible.length}
            selection={state.selection?.pane === 'sidebar' ? state.selection : undefined}
          />
        )}
      </Box>
      <Box flexDirection="column" width={mainW}>
        {modalEl ? (
          <Box flexDirection="column">
            {modalEl}
            <Text dimColor> Esc cancels · Enter confirms</Text>
          </Box>
        ) : slashH > 0 ? (
          <SlashSuggest
            items={shownSlash}
            index={Math.min(state.suggestIdx, shownSlash.length - 1)}
          />
        ) : !showSidebar ? (
          <StatusBar
            state={state}
            total={allRows.length}
            visible={win.visible.length}
            budget={runner.config.contextBudget}
            session={state.totalUsage}
          />
        ) : null}
        <PromptInput
          value={state.input}
          cursor={state.cursor}
          height={termRows}
          disabled={state.running}
        />
      </Box>
    </Box>
  );
}

/** Entry point: build the Runner, filter mouse bytes from Ink's stdin, and render. */
export async function runTui(
  config: AppConfig,
  model?: string,
  resume?: string,
  yolo = false,
): Promise<void> {
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
  const promptUserRef: { current?: (p: string) => Promise<string | null> } = {};
  const sysRef: { current?: (text: string) => void } = {};
  const mouseCbRef: { current?: (e: MouseEventData) => void } = {};
  const runner = new Runner(config, {
    model,
    sessionId: resume,
    yolo,
    ask: (p) => askRef.current!(p),
    promptUser: (p) => promptUserRef.current!(p),
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
      promptUserRef={promptUserRef}
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
