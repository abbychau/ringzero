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
