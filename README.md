# RingZero

Minimal, token-efficient agent harness. The **kernel is zero-dependency** (agent
loop, providers, tools, sessions all run on Node builtins); the **TUI is built on
[Ink](https://github.com/vadimdemedes/ink)** (React — the same engine as Claude
Code / Gemini CLI / Copilot CLI). Aggressive token-saving: minimal system prompt,
cache-aware ordering, compaction, output truncation, streaming, progressive
disclosure (skills), and ephemeral sub-agents.

## Features

- **Agent loop** — stream → tool calls → permission gate → execute → repeat (maxSteps)
- **Providers** — OpenAI-compatible (packyapi / Ollama / LM Studio / OpenRouter /
  MiniMax…) and Anthropic Messages (with `cache_control`). Chosen from env.
- **CJK-aware tokenizer** — ASCII ≈ 4 chars/token, CJK ≈ 1 char/token, used for
  compaction thresholds & budgeting; provider `usage` is the source of truth.
- **Compaction** — auto-summarizes old messages near the context limit, keeps the
  tail verbatim (`RINGZERO_PRESERVE_RECENT`).
- **Tools** — read/write/edit file, grep, glob, bash, web fetch, `task` (sub-agent), MCP.
- **Sub-agent** — `task` tool spawns an ephemeral Agent; only its summary enters context.
- **MCP** — stdio and streamable-HTTP transports; config via `RINGZERO_MCP` env or
  `.ringzero/mcp.json`.
- **Skills** — on-demand SKILL.md injection appended after the stable system prefix
  (doesn't bust prompt cache).
- **Sessions** — append-only JSONL under `~/.ringzero/sessions/`, resumable via `--resume` / `--continue`; auto titles.
- **Plugins** — single-file ESM plugins add tools, slash commands, and tool hooks.
- **RPC/SDK** — `--rpc` JSON-RPC over stdin/stdout for embedding.
- **Permission gate** — allow / ask / deny per tool, per-session overrides.

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
```

### TUI keys

`Enter` submit · `↑/↓` input history · `PgUp/PgDn` or **mouse wheel** scroll ·
`Ctrl+P/L` model dialog / cycle favorites (`RINGZERO_MODELS`) · `Ctrl+K` command palette ·
`Ctrl+O` or **mouse click** expand/collapse tool output · `Ctrl+A/E` line start/end ·
`Ctrl+U` clear line · `Ctrl+W` delete word · `Ctrl+C` abort run / exit.
Permission prompts appear as an inline modal: `y` yes · `n` no · `a` always · `v` never.
Paste (incl. CJK) is bracketed-paste safe; IME composition works.

### Slash commands (REPL & TUI)

`/help  /usage  /model [id]  /compact  /permission <tool> <allow|ask|deny>  /skills [name]  /sessions  /resume <id>  /new  /exit`

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
- `onToolBefore(fn)` — hook to deny or rewrite tool calls before execution
- `say(text)` — push a line into the active UI

See `examples/plugins/hello.mjs`.

### RPC mode

`ringzero --rpc` speaks JSON-RPC 2.0 over stdin/stdout (one object per line):
`initialize`, `ping`, `model/get`, `model/set`, `sessions/list`, `sessions/resume`, `prompt`.

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | ringzero --rpc
echo '{"jsonrpc":"2.0","id":2,"method":"prompt","params":{"text":"列出 cwd"}}' | ringzero --rpc
```

## Env knobs

| Var                                     | Default           | Meaning                                                                            |
| --------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `API_URL` / `API_KEY` / `MODEL`         | —                 | OpenAI-compatible endpoint                                                         |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | —                 | used when `API_URL` is empty                                                       |
| `CONTEXT_BUDGET`                        | —                 | short alias for `RINGZERO_CONTEXT_BUDGET` (handy in `.env`)                        |
| `RINGZERO_CONTEXT_BUDGET`               | 32000             | compaction trigger (estimated tokens)                                              |
| `RINGZERO_PRESERVE_RECENT`              | 8000              | tail tokens kept verbatim on compaction                                            |
| `RINGZERO_MAX_STEPS`                    | 24                | agent loop step cap                                                                |
| `RINGZERO_MODELS`                       | —                 | comma-separated favorite models for Ctrl+L cycling                                 |
| `RINGZERO_RETRIES`                      | 2                 | transient-failure retries (429/5xx/network)                                        |
| `RINGZERO_HOME`                         | `~/.ringzero`     | data dir (skills, plugins)                                                         |
| `RINGZERO_SESSIONS`                     | `<home>/sessions` | session store dir                                                                  |
| `RINGZERO_WORKSPACE`                    | —                 | lock fs tools (read/write/edit/grep/glob) to this root; paths outside are rejected |

### Workspace sandbox

Set `RINGZERO_WORKSPACE=/path/to/project` to restrict the file tools
(`read_file`, `write_file`, `edit_file`, `grep`, `glob`) to that directory —
attempts to touch anything outside it are rejected instead of executed.

## Layout

```
src/
  kernel/      types, tokenizer, agent loop, context/compaction, truncate
  providers/   provider interface, openai-compat, anthropic, SSE, registry
  tools/       fs, search, bash, web, task (sub-agent)
  mcp/         client, stdio+http transports, config, tool bridge
  session/     JSONL store
  permission/  gate
  skills/      loader
  cli/         index (args), repl, one-shot/json
  config/      env + app config
```
