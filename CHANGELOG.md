# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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

### Changed

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
