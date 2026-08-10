# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- TUI input keys: `Ctrl+A`/`Ctrl+E` jump to line start/end, `Ctrl+←`/`Ctrl+→`
  jump by word (CJK-safe) — shell muscle memory in the prompt input.
- `/retry` command: re-runs the last submitted prompt as a new turn in the
  same session (TUI + REPL).
- `/effort [low|medium|high|max]` command: set the reasoning effort, persisted
  to `config.json`; the sidebar shows the current level.
- Cost/token caps: `RINGZERO_COST_CAP` (USD) and `RINGZERO_TOKEN_CAP`
  (cumulative tokens) abort a run with a clear status when hit and warn once
  at 80% (`cap_warn` event; surfaced in the TUI status line and the REPL).
- Context budget bar: the StatusBar shows a color-coded gauge (green <70%,
  yellow <90%, red beyond) next to `ctx≈…`, matching the sidebar bar.
- Streamable-HTTP transport fix + offline test coverage: `httpTransport.start`
  now wires the response callback (previously responses were dropped and HTTP
  requests hung), and `test/mcp-http.test.ts` covers the `{url}` config path
  end-to-end (JSON + SSE responses, session-id round-trip, error paths) with
  a local server.
- Windows shell guidance: the bash tool description and a system-prompt hint
  tell the agent `cmd.exe` has no POSIX utilities and name the working
  alternatives (`dir`, `type`, `findstr`, the fs tools).

### Changed

- `/help` renders one command per line with a hint column and `keys:`/`args:`
  sections; `/help <cmd>` shows just that command's hint.
- Tool-call heads in the transcript compact pretty-printed JSON args to a
  single line, truncating with an ellipsis so rows never wrap; partial
  streamed args are tolerated.
- `/tools` menu rows show the tool name with its description and an
  `ON`/`OFF` hint; the selection stays on the toggled row between iterations.
- The `/` dropdown windows around the highlighted command (long menus scroll)
  and shows each command's hint; Enter fills the highlighted command.
- Prompt input rows are pre-wrapped with the same word-wrap Ink applies
  (ambiguous-width chars count 2), so the cursor lands exactly on the
  character the user typed.
- `SelectModal` hints render in gray and options support a secondary
  description (`desc`).

### Fixed

- MCP streamable-HTTP transport dropped every response: `start()` ignored its
  callback and `send()` used a module-level placeholder.
- bash tool description on Windows now states `cmd.exe` lacks `grep`/`tail`/
  `ls`/`cat` instead of vaguely recommending fs tools.

## [0.4.2] - 2026-08-08

### Added

- `ringzero --update`: self-update to the latest GitHub release — detects
  how the running copy was installed (Windows SFX exe / macOS-Linux
  portable dir), compares versions against the GitHub Releases `latest`
  endpoint, downloads the matching asset and swaps it in place (rename-swap
  on Windows, dir swap on POSIX; detached cleanup of the old binary). No
  Node/npm needed at runtime. Ships a zero-dependency zip reader
  (`src/util/unzip.ts`, store + deflate, CRC-32 verify, zip-slip guard).
  `src/cli/update.ts`.
- First-run setup wizard: when no API key is configured, `ringzero` walks
  the user through provider setup (DeepSeek? → API URL / key / model) and
  applies the recommended tuning automatically (`EFFORT=max`,
  `CONTEXT_BUDGET=1000000`, `MAX_STEPS=100`, `YOLO=1`) for DeepSeek.
  `src/cli/setup.ts`.
- User-level settings: `.env` is now read from `~/.ringzero/.env`
  (override with `RINGZERO_HOME`), written by the wizard, with priority
  `~/.env` → `~/.ringzero/.env` → `<cwd>/.env` → real env vars.
  `src/config/env.ts`.
- Homepage: "Already installed? Update with `ringzero --update`" note and
  README "Update" section (`site/index.html`, `README.md`).

## [0.4.1] - 2026-08-08

### Added

- macOS / Linux one-line installer (`install.sh`): detects platform + arch,
  downloads the matching `ringzero-<platform>-<arch>.zip` from GitHub
  Releases, installs under `~/.local/share/ringzero`, symlinks
  `~/.local/bin/ringzero`, and adds it to PATH (no sudo needed). Mirrors
  `install.ps1` for Windows.
- Homepage install box: Windows / macOS / Linux tabs, per-OS copy button
  (copies the clean command without the shell prompt), and a
  non-selectable `PS>` / `$` prompt prefix (`site/index.html`).
- `EFFORT=max`: `reasoning_effort="max"` for OpenAI-compat providers and a
  32768-token thinking budget for Anthropic/Gemini — previously `max` was
  silently ignored (`src/providers/effort.ts`).
- Terminal-Bench 2.0 benchmark results on the homepage: 71/89 (80%)
  pass@1 best-of-N with deepseek-v4-flash — 164.6M input / 3.4M output
  tokens, 2,661-token measured per-call overhead, official-leaderboard
  comparison (`site/index.html`).
- TUI right sidebar (opencode-style): header (`RingZero · <dir>`), model,

- TUI right sidebar (opencode-style): header (`RingZero · <dir>`), model,
  session id, mode badges (`[plan]`/`[yolo]`/`[img]`), live context-budget
  bar, per-turn + session token/cost totals, and the status line; shown at
  ≥ 90 columns, otherwise header/status stay full-width. Empty transcript
  no longer shows a placeholder (`src/tui/components.tsx`, `src/tui/app.tsx`).
- Yolo mode: `/yolo` (TUI/REPL), `YOLO=1` env (alias `RINGZERO_YOLO`), or
  `--yolo` flag — every permission check auto-allows, no prompts, overrides
  `deny` rules and plan mode; step-cap continuation auto-runs (capped at 3
  per turn). Persists to `config.json`; status bar shows a `YOLO` badge
  (`src/permission/gate.ts`, `src/cli/runner.ts`, `src/tui/*`, `src/cli/*`).
- `EFFORT` env (alias `RINGZERO_EFFORT`): reasoning effort
  `low`/`medium`/`high` — OpenAI-compat sends `reasoning_effort`, Anthropic
  and Gemini enable thinking with a mapped token budget
  (`src/providers/effort.ts`, `src/providers/*`, `src/config/env.ts`).
- Compaction 2.0: structured summary brief (goals / decisions / files /
  errors / unfinished), tool-call args excluded from the summarize request,
  incremental folding passes until the budget fits
  (`src/kernel/context.ts`).
- Mid-run message injection: typing + Enter while the agent runs aborts the
  current stream, queues the message, and continues (TUI, REPL, and RPC
  `prompt {text, interrupt: true}`); new `injected` agent event
  (`src/kernel/agent.ts`, `src/tui/app.tsx`, `src/cli/repl.ts`, `src/cli/rpc.ts`).
- Gemini provider (`src/providers/gemini.ts`) with function calling and
  vision (`inline_data`); picked when `GEMINI_API_KEY` is set and `API_URL`
  is empty (after Anthropic).
- Vision everywhere: `--image <path>` (CLI, repeatable), `/image <path>`
  (TUI + REPL), `prompt {images: [...]}` (RPC). Images are one-shot and
  never persisted to the session store; OpenAI-compat / Anthropic message
  conversion now embeds images as multimodal content.
- `verify` tool: the agent can re-run the project verify command after each
  fix (capped at 3 calls per run), with exit codes in the output
  (`src/tools/verify.ts`, wired in `src/cli/runner.ts`).
- Desktop notifications: terminal bell + native bubble (PowerShell toast /
  osascript / notify-send) on long runs and permission prompts
  (`src/cli/notify.ts`; `RINGZERO_NOTIFY`, `RINGZERO_NOTIFY_MIN`).
- Session export & pruning: `/export [path]` (TUI + REPL) and RPC
  `sessions/export` write a Markdown transcript (`src/session/export.ts`);
  `SessionStore.prune()` auto-archives excess/old sessions
  (`RINGZERO_SESSION_LIMIT`, `RINGZERO_SESSION_KEEP_DAYS`).
- Recorded-provider E2E tests: scripted provider harness
  (`test/util/scripted.ts`) + fixtures (`test/fixtures/explore.json`,
  `compact.json`, `fanout.json`) covering tool round-trips, repeated
  compaction, and parallel sub-agent fan-out (`test/e2e.test.ts`).
- Token-efficiency benchmark: `npm run bench` runs every fixture with
  compaction on/off and reports tokens per task, final context size, and
  compaction savings (`scripts/bench.ts`).
- CI matrix across Ubuntu / macOS / Windows (`.github/workflows/ci.yml`).
- `--watch "prompt"` mode: re-runs the prompt whenever the project changes
  (`src/cli/watch.ts`).
- RPC streaming: `prompt {notify: true}` emits `prompt/event` notifications;
  `prompt {interrupt: true}` bypasses the serial queue for mid-run injection.
- `consumeSSE` flushes a final partial line (streams that end without a
  trailing newline).
- `CONTRIBUTING.md` and `docs/EXTENDING.md` (provider/tool/plugin/RPC guides).
- `--doctor`: zero-dep environment self-check (Node version, TTY, provider
  key, git repo, workspace sandbox, sessions dir, config summary); exits 1 on
  any failure so scripts/CI can gate on it (`src/cli/doctor.ts`).
- `git_commit` tool + `/commit <msg>` (TUI + REPL): stages everything
  (`git add -A`) and commits; returns the short id, `(nothing to commit)`, or
  an error (`src/tools/git.ts`).
- `list_dir` / `tree` exploration tools (workspace-sandboxed, entry/line
  caps), `grep files_only`, `git_log` (path/search/stat/count), and a date
  block in the system prompt for correct commit messages (`src/tools/explore.ts`,
  `src/tools/git.ts`, `src/config/config.ts`).
- `ask_user` tool: the agent can pause mid-run and ask the user a question
  (TUI modal / REPL prompt); non-interactive modes get `(unavailable)`
  (`src/tools/ask.ts`).
- `web_search` (opt-in via `RINGZERO_SEARCH_KEY` / `RINGZERO_SEARCH_ENDPOINT`,
  Tavily-compatible) and `http_request` (GET/POST/PUT/PATCH/DELETE,
  SSRF-guarded, ask by default) tools (`src/tools/search_web.ts`, `src/tools/http.ts`).
- `/tools` menu (TUI) + `/tools [name|reset]` (REPL): disable tools for the
  agent; the TUI select list now windows around the cursor so long rosters
  fit any terminal height (`src/tui/commands.ts`, `src/cli/repl.ts`,
  `src/tui/components.tsx`).
- Persistent prefs: `disabledTools` and permission overrides (`/permission`,
  `always`/`never` answers) survive restarts via `~/.ringzero/config.json`
  merged with `.ringzero/config.json` (project wins per key)
  (`src/config/prefs.ts`, `src/permission/gate.ts`).

### Changed

- `MAX_STEPS` env: short name for `RINGZERO_MAX_STEPS` (handy in `.env`),
  with `-1` = unlimited agent-loop steps
  (`src/config/config.ts`, `src/kernel/agent.ts`, `src/cli/doctor.ts`).
- Step-limit handoff: the `finish` event now carries
  `reason: 'done' | 'max_steps'`; when the cap is hit, the TUI asks
  (confirm modal) and the REPL asks (`y/N`) whether to continue, then starts
  a continuation turn with the full history still in context
  (`src/kernel/agent.ts`, `src/tui/app.tsx`, `src/cli/repl.ts`).
- Workspace sandbox auto-detect: with `RINGZERO_WORKSPACE` unset, fs tools are
  locked to the git work-tree root (`detectGitRoot`, `src/config/config.ts`);
  `off`/`none` disables the sandbox.
- Permission overrides are now persisted instead of living only in memory:
  the gate fires `onOverride` so the runner can write `config.json`.
- `SelectModal` (sessions, tools menu) windows long option lists around the
  selection instead of overflowing the terminal.

- Provider registry order: `API_URL` wins, then Anthropic, then Gemini.
- TUI: mid-run Enter injects instead of dropping input; `[img]` indicator in
  the header when an image is attached; `/image` + `/export` in the slash
  palette.
- README: new features, env knobs (`GEMINI_*`, `RINGZERO_NOTIFY*`,
  `RINGZERO_SESSION_*`), commands, and development links.

### Fixed

- TUI mouse wheel scrolling: the wheel handler compared the parser's
  normalized button (0/1) against the raw SGR codes (64/65), so every wheel
  event computed a zero delta and the transcript never scrolled. The mapping
  now lives in `wheelDelta()` (`src/tui/mouse.ts`, `src/tui/app.tsx`).
- TUI transcript focus: mouse wheel/click inside the transcript frame now lets
  ↑/↓ (and PgUp/PgDn) scroll it instead of hijacking input history; Esc or
  scrolling back to the bottom returns to the input. The status bar hints the
  keys while focused (`src/tui/app.tsx`, `src/tui/state.ts`).
- Command output decoding (`bash`, `verify`, and the auto-verify hook): output
  is decoded as UTF-8 first, then falls back to the Windows legacy console
  codepage (GBK/Big5/Shift-JIS… derived from the system locale), so CJK output
  from `cmd`/PowerShell no longer renders as mojibake in the TUI. Bytes are
  buffered and decoded once, fixing multi-byte chars split across chunks.
  `RINGZERO_OS_ENCODING` overrides (`src/tools/bash.ts`).
- Auto-compaction results are now persisted to the session store via a new
  `onCompact` callback instead of silently keeping stale history on disk.
- Session store `load()` tolerates corrupt lines instead of failing the whole
  read.
- `bash` tool kills the full process tree (`taskkill /T` on Windows, negative
  pid kill on POSIX) so runaway commands cannot leak background children.
- fs/search tools now resolve paths against the configured `RINGZERO_WORKSPACE`
  sandbox and reject anything outside it.
- Removed a runtime `import()` of `node:os` in the kernel and a broken
  relative path to `package.json` in `src/version.ts`.

### Changed

- Kernel/CLI split: version and session persistence are shared through
  `src/version.ts` and the store, so `cli/` no longer duplicates paths.
- MCP client and provider streams are fully typed (no `any`); JSON-RPC
  requests are parsed through a typed `parseRequest`.
- TypeScript `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`
  are enforced; dead `toolArgs`/`toolResult` fields removed from
  `SessionMessage`.
- Codebase formatted with Prettier (`format` / `format:check` scripts).
- `.vscode/tasks.json` trimmed from ~80 auto-generated tasks to 9 useful ones.
- Dev-only diagnostics scripts moved to `scripts/dev/`.
- CI runs typecheck, format check, build, and the full test suite.

### Added

- `read_file` outline mode: files >300 lines auto-return a symbol outline
  (regex-based, per-language) with `mode: "full"` to bypass; explicit `mode`
  param supported (`src/tools/outline.ts`).
- Reasoning support: `thinking` events streamed from `reasoning_content`
  (OpenAI-compat) and Anthropic `thinking` blocks; shown collapsed in the TUI;
  never persisted to session history. Provider usage no longer emits
  `cacheWrite: undefined` fields.
- Git integration: `git_status` / `git_diff` tools; auto-checkpoint of the
  worktree (tracked + untracked, temp-index snapshot → shadow ref) before the
  first tool call of each run; `/diff`, `/status`, `/checkpoint`, `/rollback`
  slash commands (TUI + REPL). Rollback restores index + worktree without
  moving HEAD (`src/tools/git.ts`).
- Post-tool verify loop: `onToolAfter` plugin hook (rewrite tool results) and
  `RINGZERO_VERIFY` env — a command (e.g. `npm test`) run once after the first
  write/edit of a run, with its output fed back into context
  (`src/cli/verify.ts`).
- `onCompact` option on `Agent` (with a dedicated test).
- Workspace sandbox section in the README and docs for the new environment
  variables.
- Plan mode: `/plan [on|off]` + `RINGZERO_PLAN_MODE` gate the agent to
  read-only tools until the user approves a plan presented via the new `plan`
  tool; approved plans run without further permission prompts
  (`src/tools/plan.ts`, kernel gate in `src/kernel/agent.ts`).
- Todo list: `todo` tool (add/done/open/clear/list), persisted per session
  under `~/.ringzero/todos/`, rendered as a collapsible TUI strip (`Ctrl+T`,
  `/todos`) (`src/tools/todo.ts`, `src/cli/runner.ts`).
- Secret redaction: `makeRedactor()` strips known env secret values and URL
  credentials from tool results before they reach the model, the store, or the
  UI (`src/kernel/redact.ts`).
- SSRF guard for `web_fetch`: private/loopback/link-local/multicast/reserved
  addresses (IPv4 + IPv6, incl. mapped/NAT64 forms) are blocked, including on
  redirects; `RINGZERO_ALLOW_PRIVATE_NET=1` opts out (`src/tools/web.ts`).
- Bash hardening: child processes get a sanitized env (secret-looking vars
  dropped; `RINGZERO_BASH_FULL_ENV=1` to opt out) and `timeout_ms` is clamped
  to 1s–10min (`src/tools/bash.ts`).
- Tool efficiency: per-run result cache for pure tools (identical parallel
  reads dedupe to one execution), `maxConcurrency` cap on parallel tool
  execution, and tool definitions ordered by usage frequency to stabilize the
  provider prompt cache (`src/kernel/agent.ts`).
- Parallel research fan-out: `task` batch mode — pass `tasks: [...]` to run N
  sub-agents in parallel (capped, same model as the main loop) and get one
  numbered merged report; a failing subtask is reported inline without killing
  the batch. Sub-agents now also inherit the parent's abort signal
  (`src/tools/task.ts`).
- `CHANGELOG.md`.
- Token/cost dashboard: zero-dep price table + estimator
  (`src/kernel/cost.ts`) wired into the StatusBar (session cost), `/usage`
  (cache hit rate + estimated cost, session and last turn), and the REPL
  per-turn usage line.
- Symbol index + `related_files` tool: zero-dep ctags-style index
  (`src/tools/indexer.ts`) cached per workspace root with mtime invalidation;
  `related_files` lists importers and same-symbol files for a target before
  editing (`src/tools/related.ts`).

## [0.4.0]

Initial release of the token-efficient agent harness: zero-dep kernel with
tool calling, auto-compaction, permission gate, MCP client, session store, and
an Ink-based TUI.
