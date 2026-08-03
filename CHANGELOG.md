# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

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
- `CHANGELOG.md`.

## [0.4.0]

Initial release of the token-efficient agent harness: zero-dep kernel with
tool calling, auto-compaction, permission gate, MCP client, session store, and
an Ink-based TUI.
