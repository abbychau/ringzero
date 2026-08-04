# RingZero Roadmap

Development direction grounded in RingZero's philosophy (minimal, token-efficient,
zero-dep kernel, CJK-first) and current practices in modern agent harnesses
(Claude Code, Codex CLI, Gemini CLI, Aider, OpenHands).

Status legend: `[ ]` planned · `[x]` done

## P0 — Quick wins (each 1–2 days, straight on-philosophy)

- [x] **P0.1 `read_file` outline mode** — for large files, return a symbol outline
      (functions/classes/interfaces via zero-dep regex extraction) instead of raw
      text, so the model reads the shape first and then a targeted range. Biggest
      token saver in the repo. Auto for files >300 lines; explicit `mode` param.
- [x] **P0.2 Reasoning support** — capture `reasoning_content` (OpenAI-compat /
      DeepSeek) and `thinking` blocks (Anthropic extended thinking) as a
      `thinking` event; show collapsed/dimmed in the TUI; never persist it.
- [x] **P0.3 Git checkpoints + diff/rollback** — auto-snapshot the worktree
      (temp-index snapshot → shadow ref) before the first tool call of each run;
      `git_status` / `git_diff` tools; `/diff`, `/rollback`, `/checkpoint`,
      `/status` commands. Safety net that unlocks "let the agent change things".
- [x] **P0.4 Post-tool verify loop** — `onToolAfter` plugin hook + optional
      `RINGZERO_VERIFY` command run after file edits with the result fed back
      into context (Aider/Codex `--fix` seed).
- [x] **P0.5 Security quick wins** — secret redaction in tool output/logs;
      SSRF guard for `web_fetch` (block private/loopback/link-local IPs);
      cap `bash` timeout; optional env filtering for the shell.
- [x] **P0.6 Tool-call token optimization** — per-run tool result cache
      (dedupe repeated `read_file`), `maxConcurrency` for parallel tools,
      tool definitions ordered by usage frequency to stabilize prompt cache.

## P1 — Core experience (2.0-level)

- [x] **P1.1 Plan mode** — agent thinks and proposes a plan; user approves
      before execution.
- [x] **P1.2 Todo list (`/todos`)** — agent-maintained TODOs shown in the TUI.
- ~~**P1.3 Multi-model routing**~~ — rejected by design: compaction,
  sub-agents, and the main loop all use the same model (simpler,
  predictable, one API key).
- [x] **P1.4 Compaction 2.0** — structured summary template (goals/decisions/
      files/errors/unfinished), keep tool-call args out of the summarize prompt,
      incremental compaction, carry the previous summary forward.
- [x] **P1.5 Token/cost dashboard** — per-turn input/output/cache breakdown,
      cache hit rate, estimated cost (built-in model price table, zero-dep).
- [x] **P1.6 Mid-run interruption** — pause → user injects a message → resume.
- [x] **P1.7 Gemini provider + vision** — Gemini API (free tier, CJK users);
      content blocks for image input.

## P2 — Scale

- [x] **P2.1 Symbol index + related-files** — ctags-style zero-dep index;
      `related_files` tool ("changing A means checking B").
- [x] **P2.2 Parallel research fan-out** — `task` batch mode: N sub-agents in
      parallel, merged results.
- [x] **P2.3 Automatic verify loop** — edit → verify → fix → rerun (built on
      P0.4).
- [x] **P2.4 Notifications** — desktop/bell on long-run completion or
      permission requests (zero-dep: PowerShell toast / terminal bell).
- [x] **P2.5 Session export & pruning** — `/export` Markdown transcript,
      automatic session archiving.

## P3 — Platform & engineering

- [x] **P3.1 Token-efficiency benchmark suite** — recorded fixtures measuring
      tokens per task, compaction savings, sub-agent savings, cache hit rate.
      The philosophy needs numbers (marketing + regression guard).
- [x] **P3.2 E2E tests with recorded provider responses** — full agent loop
      offline (101 unit tests today, all offline; no recorded-feedback E2E yet).
- [x] **P3.3 CI on three platforms** (currently one workflow).
- [x] **P3.4 `--watch` mode / SDK polish** — file-watch rerun, RPC streaming
      event subscription.
- [x] **P3.5 Docs** — CONTRIBUTING.md, kernel/providers/tools extension guide.

## Suggested execution order

P0.1 → P0.2 → P0.3 → P0.4 first: outline mode (biggest token win, on-brand),
reasoning (directly useful for DeepSeek-class models), git checkpoints
(unlocks everything "let the agent change things"), verify loop (agent checks
its own work). These four turn RingZero from a toy into a harness you can
actually let loose on a repo.

---

# Phase 2 — 2026 roadmap

Re-audited after the Phase 1 batches shipped (mouse scroll, transcript focus,
CJK output decoding, `npm start`). Grounded in the same philosophy: minimal,
token-efficient, zero-dep, CJK-first, UX/operability first.

## P4 — Operability & safety defaults (quick wins)

- [x] **P4.1 `--doctor` diagnostics** — `ringzero --doctor` checks the
      environment and prints actionable findings: Node ≥ 20.3
      (`AbortSignal.any`), TTY + terminal capabilities (SGR mouse 1006,
      alternate screen), provider key presence per provider, git availability,
      workspace/sandbox state, sessions dir writable, config summary.
      Zero-dep; exits non-zero on blocking issues.
- [x] **P4.2 Workspace auto-detect from git root** — when `RINGZERO_WORKSPACE`
      is unset and the cwd is inside a git work tree, sandbox fs tools to the
      repo root instead of letting them roam the whole machine.
- [x] **P4.3 `git_commit` tool + `/commit [msg]`** — let the agent commit at
      natural milestones; the model drafts the message and the user approves
      via the permission gate (default ask). Checkpoint/rollback stays the
      safety net.

## P5 — TUI experience (UX focus)

- [ ] **P5.1 Context budget bar** — the StatusBar shows a color-coded token bar
      (green <70%, yellow <90%, red beyond) next to the ctx≈ text, so
      compaction pressure is visible at a glance.
- [ ] **P5.2 `/retry`** — TUI + REPL re-run the last submitted prompt (new
      agent turn, same session).
- [ ] **P5.3 Input editing keys** — Ctrl+A / Ctrl+E (home/end) and
      Ctrl+← / Ctrl+→ (word jumps) in the TUI input, matching shell muscle
      memory.
- [ ] **P5.4 Session management** — `/sessions` select gains rename (r) and
      delete (d) actions; REPL `/sessions` shows ids and supports
      `/sessions delete <id>`; RPC `sessions/rename` + `sessions/delete`;
      store gains `renameSession` / `deleteSession`.
- [ ] **P5.5 Auto session titles** — the first user message becomes the
      session title (fallback to the current default), so `/sessions`,
      `/export`, and `--sessions` show useful names.
- [x] **P5.6 `/copy` clipboard command** — `/copy [n|all]` copies the last
      assistant message / last `n` / full transcript to the OS clipboard
      (zero-dep `clip`/`pbcopy`/`xclip`/`wl-copy`/`xsel`), since mouse drag
      selection is unavailable under mouse-reporting + alternate screen.
- [x] **P5.7 In-app selection + copy** — mouse mode 1002 (drag) enables
      drag-selection in the transcript (inverse video); Shift+↑/↓/PgUp/PgDn
      extends the selection from the keyboard; Ctrl+Y copies the selection
      via the `/copy` clipboard backend; Esc clears. `/copy [n|all]` stays as
      the selection-free path (transcript rows are flat text, so per-column
      highlight is straightforward). CJK-safe: clicks round down to whole
      double-width characters.

## P6 — Cost & research

- [ ] **P6.1 Cost/token caps** — `RINGZERO_COST_CAP` (USD) and
      `RINGZERO_TOKEN_CAP`: the agent exposes cumulative usage mid-run; the
      TUI/REPL/RPC abort the run with a clear status when a cap is hit and
      warn at 80%.
- [ ] **P6.2 `web_search` tool** — opt-in search tool
      (`RINGZERO_SEARCH_KEY` + `RINGZERO_SEARCH_ENDPOINT`, Tavily-compatible
      JSON contract documented) registered only when configured; pairs with
      the `task` fan-out for parallel research.

## P7 — Platform & docs

- [ ] **P7.1 MCP streamable-HTTP test coverage** — the transport already
      exists (`src/mcp/transports.ts`); add an offline test with a local HTTP
      server (JSON + SSE responses) so the `{url}` config path is verified on
      CI.
- [ ] **P7.2 Docs & polish** — README env table + command list for everything
      above; CHANGELOG entries; roadmap markers flipped.

## Suggested execution order (Phase 2)

P4.1 → P4.2 → P4.3 (operability first) → P5.1 → P5.2 → P5.3 → P5.5 → P5.4 →
P6.1 → P6.2 → P7.1 → P7.2

---

# Phase 3 — Tool call expansion

P5–P7 (TUI/cost/docs polish) are deferred until the functionality set is
complete, to avoid rework. This phase widens what the agent can do, keeping
the zero-dep kernel and token-efficiency constraints: short descriptions,
hard output caps, opt-in config-gated tools.

## T1 — Exploration & navigation

- [x] **T1.1 `list_dir`** — one directory per call: name, dir marker, size,
      mtime; skips `IGNORE_DIRS`; capped at 200 entries (`src/tools/explore.ts`).
- [x] **T1.2 `tree`** — project-structure overview with `max_depth` (1–8),
      capped at 300 lines; ASCII connectors for token efficiency.
- [x] **T1.3 `grep files_only`** — return matching file paths only (like
      `grep -l`), pairing with `tree` for cheap orientation.
- [x] **T1.4 `git_log`** — recent commit history with `path` filter, `-S`
      pickaxe `search`, `--stat`, and `count` cap (default 20, max 50)
      (`src/tools/git.ts`).
- [x] **T1.5 Date injection** — today's date as a separate system block so the
      model writes correct commit messages/timestamps; Anthropic keeps the
      static rules cached when the date rolls.

## T2 — Interaction

- [x] **T2.1 `ask_user`** — agent pauses and asks the user a question mid-run
      (free text or numbered choices); interactive sessions only (TUI modal /
      REPL question); one-shot/RPC/sub-agents return `(unavailable)`.

## T3 — Opt-in network tools (config-gated, like `web_search`)

- [x] **T3.1 `web_search`** — Tavily-compatible search registered only when
      `RINGZERO_SEARCH_KEY` + `RINGZERO_SEARCH_ENDPOINT` are set.
- [x] **T3.2 `http_request`** — generic JSON API calls (GET/POST/PUT/PATCH/
      DELETE) reusing the SSRF guard; permission `ask` by default.

## T4 — User preferences & persistence

- [x] **T4.1 `/tools` menu (TUI) + `/tools [name]` (REPL)** — toggle which
      tools the agent sees; state persisted to `config.json`.
- [x] **T4.2 Persistent config** — `~/.ringzero/config.json` (global) merged
      with `.ringzero/config.json` (project); stores `disabledTools` and
      `permissionOverrides`.
- [x] **T4.3 Permission override persistence** — `/permission` (and the
      `always`/`never` answers) survive restarts instead of living only in
      memory.

## Suggested execution order (Phase 3)

T1.1 → T1.2 → T1.3 → T1.4 → T1.5 → T2.1 → T3.1 → T3.2 → T4.1 → T4.2 → T4.3
→ P5 (after the functional set is complete).
