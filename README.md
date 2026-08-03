# RingZero

Minimal, token-efficient agent harness. The **kernel is zero-dependency** (agent
loop, providers, tools, sessions all run on Node builtins); the **TUI is built on
[Ink](https://github.com/vadimdemedes/ink)** (React — the same engine as Claude
Code / Gemini CLI / Copilot CLI). Aggressive token-saving: minimal system prompt,
cache-aware ordering, compaction, output truncation, streaming, progressive
disclosure (skills), and ephemeral sub-agents.

## Features

- **Agent loop** — stream → tool calls → permission gate → execute → repeat (maxSteps)
- **Reasoning** — `thinking` events from DeepSeek/OpenAI-compat `reasoning_content`
  and Anthropic extended thinking, shown collapsed in the TUI, never persisted.
- **Providers** — OpenAI-compatible (packyapi / Ollama / LM Studio / OpenRouter /
  MiniMax…), Anthropic Messages (with `cache_control`), and Gemini
  (`streamGenerateContent`, incl. vision via `inline_data`). Chosen from env.
- **CJK-aware tokenizer** — ASCII ≈ 4 chars/token, CJK ≈ 1 char/token, used for
  compaction thresholds & budgeting; provider `usage` is the source of truth.
- **Compaction 2.0** — auto-summarizes old messages into a structured brief
  (goals / decisions / files / errors / unfinished), keeps the tail verbatim
  (`RINGZERO_PRESERVE_RECENT`), folds prior summaries forward, and re-compacts
  incrementally until the budget fits.
- **Mid-run injection** — while the agent is running, just type and press Enter:
  the current stream aborts, your message is queued, and the run continues with
  it (TUI, REPL, and RPC `prompt {interrupt:true}`).
- **Tools** — read (full / range / auto-outline for large files) / write / edit,
  grep, glob, `related_files` (importers + same-symbol files), bash, web
  fetch, `git_status` / `git_diff`, `plan`, `todo`, `task` (sub-agent), MCP.
- **Plan mode** — `/plan` gates the agent: only read-only tools run until it
  presents a plan via the `plan` tool and you approve it; approved plans run
  without further permission prompts.
- **Todos** — agent-maintained checklist (`todo` tool), persisted per session,
  shown as a collapsible strip in the TUI (`Ctrl+T`, `/todos`).
- **Security** — secret values redacted from tool output/logs, `web_fetch`
  blocks private/loopback addresses (SSRF guard), bash children get a
  sanitized env and a capped timeout.
- **Tool efficiency** — per-run result cache for pure tools (deduped identical
  reads), capped parallel tool execution, tool definitions ordered by usage to
  stabilize the provider prompt cache.
- **Checkpoints** — auto-snapshot of the worktree before each run; `/checkpoint`
  - `/rollback` restore it (index + worktree, HEAD untouched).
- **Verify loop** — after the automatic post-edit check (`RINGZERO_VERIFY`), the
  agent also gets a `verify` tool to re-run build/tests after each fix
  (capped at 3 calls per run), with failing exit codes fed back.
- **Sub-agent** — `task` tool spawns ephemeral Agents (same model as the main
  loop — no multi-model routing); only their summaries enter context. Batch
  mode: pass `tasks: [...]` to fan out N independent subtasks in parallel
  (capped at 4), merged into one numbered report; a failing task is isolated.
- **MCP** — stdio and streamable-HTTP transports; config via `RINGZERO_MCP` env or
  `.ringzero/mcp.json`.
- **Skills** — on-demand SKILL.md injection appended after the stable system prefix
  (doesn't bust prompt cache).
- **Sessions** — append-only JSONL under `~/.ringzero/sessions/`, resumable via `--resume` / `--continue`; auto titles. `/export` writes a Markdown transcript; excess/old sessions auto-archive (`RINGZERO_SESSION_LIMIT`, `RINGZERO_SESSION_KEEP_DAYS`).
- **Plugins** — single-file ESM plugins add tools, slash commands, and tool hooks.
- **RPC/SDK** — `--rpc` JSON-RPC over stdin/stdout for embedding, with streamed `prompt/event` notifications and mid-run `interrupt`.
- **Notifications** — terminal bell + desktop bubble when a long run finishes or a permission prompt waits (`RINGZERO_NOTIFY`, `RINGZERO_NOTIFY_MIN`).
- **Watch mode** — `--watch "prompt"` re-runs the prompt whenever the project changes (auto-fix loops).
- **Permission gate** — allow / ask / deny per tool, per-session overrides.
- **Token/cost dashboard** — per-turn + session input/output/cache breakdown
  with cache hit rate and an estimated cost from a built-in zero-dep price
  table (StatusBar, `/usage`, per-turn status); tune `src/kernel/cost.ts`.
- **Symbol index + `related_files`** — zero-dep ctags-style index
  (`src/tools/indexer.ts`, cached with mtime invalidation); `related_files`
  finds importers and files defining the same symbols before you edit.
- **Vision** — attach images to any turn: `--image <path>` (CLI), `/image`
  (TUI/REPL), or `prompt {images: [...]}` (RPC). Images are one-shot — sent
  once, never persisted to the session store.
- **Benchmark** — `npm run bench` measures tokens per task, compaction
  savings, and sub-agent savings against recorded offline fixtures.

## Install / build

```bash
npm install
npm run build          # tsc → dist/
npm test               # build + node --test
```

## How to run & test

```bash
# 1. Build (required before running)
npm run build

# 2. Run tests (offline — no API calls; includes CJK tokenizer, SSE, compaction,
#    permission, glob/fsutil, MCP client + real spawned stdio server)
npm test

# 3. Smoke test — real round-trip vs the endpoint in .env (needs network + API key)
npm run smoke

# 4. Run the CLI. Either use node directly:
node dist/src/cli/index.js "列出 package.json 的 name"
# …or link it once so `ringzero` works anywhere:
npm link          # then: ringzero "prompt"

# Useful invocations
ringzero                          # interactive TUI (fallback: --repl line mode)
ringzero "prompt"                 # one-shot
ringzero --json "prompt"          # NDJSON event stream (scriptable)
ringzero --watch "prompt"         # re-run the prompt on file changes (--yes for writes)
ringzero --image shot.png "…"     # attach an image to the prompt (repeatable)
ringzero --sessions               # list saved sessions (then --resume <id>)
ringzero --resume <id> "prompt"   # continue a session
ringzero --version
```

Sessions are stored as JSONL under `~/.ringzero/sessions/` (or `RINGZERO_HOME`).

## Usage

```bash
# .env (or real env vars)
# API_URL=https://www.packyapi.ai/v1
# API_KEY=sk-...
# MODEL=deepseek-v4-flash

ringzero                        # interactive TUI (line REPL if no TTY, or --repl)
ringzero "prompt"               # one-shot
ringzero --json "prompt"        # NDJSON event stream (scriptable)
ringzero --resume <id> "..."    # continue a session
ringzero --continue "..."       # resume the most recent session
ringzero --rpc                  # JSON-RPC mode over stdin/stdout
ringzero --yes "prompt"         # auto-allow all tools (scripted)
ringzero --model <id> "..."     # override model
ringzero --verbose "..."        # verbose logging
ringzero --image shot.png "..." # attach an image (vision models)
ringzero --watch "..."          # re-run on file changes (use --yes for writes)
```

### TUI keys

`Enter` submit · `↑/↓` input history · `PgUp/PgDn` or **mouse wheel** scroll ·
`Ctrl+P/L` model dialog / cycle favorites (`RINGZERO_MODELS`) · `Ctrl+K` command palette ·
`Ctrl+O` or **mouse click** expand/collapse tool output · `Ctrl+T` toggle the todo list ·
`Ctrl+A/E` line start/end ·
`Ctrl+U` clear line · `Ctrl+W` delete word · `Ctrl+C` abort run / exit.
While the agent is running, **typing + Enter injects your message mid-run**
(the current stream aborts and the run continues with your input).
Permission prompts appear as an inline modal: `y` yes · `n` no · `a` always · `v` never.
Paste (incl. CJK) is bracketed-paste safe; IME composition works.

### Slash commands (REPL & TUI)

`/help  /usage  /model [id]  /compact  /permission <tool> <allow|ask|deny>  /skills [name]  /sessions  /resume <id>  /diff  /status  /checkpoint  /rollback  /plan [on|off]  /todos  /image <path>  /export [path]  /new  /exit`

`/image <path>` attaches an image to your next message (shown as `[img]` in the
header); `/image clear` removes it. `/export [path]` writes the current session
as a Markdown transcript (default: `transcript-<id>.md` in the cwd).

`/usage` shows the session token totals with cache hit rate and estimated cost
(per-turn breakdown too); the StatusBar keeps a live cost estimate for the
session, and each finished turn reports its own usage.

### Plan mode

`/plan` (or `RINGZERO_PLAN_MODE=1`) puts the agent in plan mode: only read-only
tools (`read_file`, `grep`, `glob`, `git_status`, `git_diff`, `web_fetch`) are
allowed until the agent presents a plan with the `plan` tool and you approve it.
Once approved, the rest of the turn runs without further permission prompts.
Rejected plans keep the gate closed — the agent must revise and re-present.

### Checkpoints & rollback

At the start of each run, RingZero snapshots the worktree (tracked + untracked
files) into a shadow git ref — nothing is committed to your branch. While the
agent works you can inspect the damage with `/diff` or `/status`, or undo it:

- `/checkpoint` — take an explicit snapshot (returns the sha)
- `/rollback` — restore the most recent snapshot (index + worktree; HEAD untouched)

The `git_status` / `git_diff` tools let the agent see the same view and adapt
(e.g. noticing it left stray files).

### MCP config

`.ringzero/mcp.json` (repo or home) or `RINGZERO_MCP` env (JSON):

```json
{
  "my-server": { "command": "npx", "args": ["-y", "some-mcp-server"] },
  "http-server": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer x" } }
}
```

### Skills

Create `<cwd>/.ringzero/skills/<name>/SKILL.md` (or `~/.ringzero/skills/`), then
`/skills <name>` to enable. A skill may also ship `tools.mjs` (default export =
array of Tool objects) that gets registered when the skill is enabled.
See `examples/skills/`.

### Plugins

Drop a single-file ESM/CJS plugin into `<cwd>/.ringzero/plugins/` or
`~/.ringzero/plugins/` (file name = plugin name). The default export is
`async (api) => {}` where `api` provides:

- `registerTool(tool)` — add a custom tool
- `registerCommand(name, fn)` — add a `/name` slash command
- `onToolBefore(fn)` — deny or rewrite tool calls before execution
- `onToolAfter(fn)` — inspect or rewrite tool results before they reach the model
- `say(text)` — push a line into the active UI

See `examples/plugins/hello.mjs`.

### RPC mode

`ringzero --rpc` speaks JSON-RPC 2.0 over stdin/stdout (one object per line):
`initialize`, `ping`, `model/get`, `model/set`, `sessions/list`, `sessions/resume`,
`sessions/export`, `prompt`. `prompt` accepts `notify: true` (streams
`prompt/event` notifications for every agent event) and
`interrupt: true` (injects a message into the running prompt, bypassing the
serial queue). `prompt` also accepts `images: [{ mime, data }]` for vision.

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | ringzero --rpc
echo '{"jsonrpc":"2.0","id":2,"method":"prompt","params":{"text":"列出 cwd"}}' | ringzero --rpc
```

## Development

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, conventions, testing, commit style.
- [docs/EXTENDING.md](docs/EXTENDING.md) — how to add providers, tools,
  plugins, skills, slash commands, and use the RPC/SDK.

## Env knobs

| Var                                     | Default           | Meaning                                                                                               |
| --------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `API_URL` / `API_KEY` / `MODEL`         | —                 | OpenAI-compatible endpoint                                                                            |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | —                 | used when `API_URL` is empty                                                                          |
| `GEMINI_API_KEY` / `GEMINI_MODEL`       | —                 | used when `API_URL` is empty (after Anthropic); `MODEL` wins over `GEMINI_MODEL`                      |
| `CONTEXT_BUDGET`                        | —                 | short alias for `RINGZERO_CONTEXT_BUDGET` (handy in `.env`)                                           |
| `RINGZERO_CONTEXT_BUDGET`               | 32000             | compaction trigger (estimated tokens)                                                                 |
| `RINGZERO_PRESERVE_RECENT`              | 8000              | tail tokens kept verbatim on compaction                                                               |
| `RINGZERO_MAX_STEPS`                    | 24                | agent loop step cap                                                                                   |
| `RINGZERO_MODELS`                       | —                 | comma-separated favorite models for Ctrl+L cycling                                                    |
| `RINGZERO_RETRIES`                      | 2                 | transient-failure retries (429/5xx/network)                                                           |
| `RINGZERO_HOME`                         | `~/.ringzero`     | data dir (skills, plugins)                                                                            |
| `RINGZERO_SESSIONS`                     | `<home>/sessions` | session store dir                                                                                     |
| `RINGZERO_WORKSPACE`                    | —                 | lock fs tools (read/write/edit/grep/glob) to this root; paths outside are rejected                    |
| `RINGZERO_VERIFY`                       | —                 | shell command run after the first write/edit of a run; output fed back to the model (e.g. `npm test`) |
| `RINGZERO_PLAN_MODE`                    | `0`               | start with plan mode on (`1`/`true`)                                                                  |
| `RINGZERO_ALLOW_PRIVATE_NET`            | `0`               | `1` disables the `web_fetch` SSRF guard (not recommended)                                             |
| `RINGZERO_BASH_FULL_ENV`                | `0`               | `1` passes the full environment to bash children (secrets are stripped by default)                    |
| `RINGZERO_NOTIFY`                       | `1` (TTY only)    | `0` disables bell/desktop notifications                                                               |
| `RINGZERO_NOTIFY_MIN`                   | `30`              | minimum run length (seconds) before a completion notification fires                                   |
| `RINGZERO_SESSION_LIMIT`                | `50`              | max sessions kept; older ones archive to `<sessions>/archive`                                         |
| `RINGZERO_SESSION_KEEP_DAYS`            | `0`               | archive sessions older than N days (`0` = off)                                                        |

### Workspace sandbox

Set `RINGZERO_WORKSPACE=/path/to/project` to restrict the file tools
(`read_file`, `write_file`, `edit_file`, `grep`, `glob`) to that directory —
attempts to touch anything outside it are rejected instead of executed.

## Layout

```
src/
  kernel/      types, tokenizer, agent loop, context/compaction, truncate, redact
  providers/   provider interface, openai-compat, anthropic, gemini, SSE, retry, registry
  tools/       fs, search (grep/glob), indexer + related_files, bash, web, plan, todo, task (sub-agent), verify
  mcp/         client, stdio+http transports, config, tool bridge
  session/     JSONL store, markdown export
  permission/  gate
  skills/      loader
  cli/         index (args), repl, one-shot/json, rpc, watch, notify, runner
  config/      env + app config
```
