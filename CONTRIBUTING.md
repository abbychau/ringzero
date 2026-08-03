# Contributing to RingZero

Thanks for helping! This project is small on purpose — the kernel is
**zero-dependency** (Node builtins only) and everything else follows from that.

## Setup

```bash
npm install
npm run build        # tsc → dist/
npm test             # build + node --test (all offline, no API calls)
npm run format       # prettier --write .
npm run format:check # CI runs this
```

The CLI runs from `dist/`:

```bash
node dist/src/cli/index.js "prompt"
```

## Project layout

```
src/
  kernel/      types, tokenizer, agent loop, context/compaction, truncate, redact, cost
  providers/   provider interface, openai-compat, anthropic, gemini, SSE, retry, registry
  tools/       fs, search (grep/glob), indexer + related_files, bash, web, plan, todo,
               task (sub-agent), verify
  mcp/         client, stdio+http transports, config, tool bridge
  session/     JSONL store, markdown export
  permission/  gate
  skills/      loader
  cli/         index (args), repl, one-shot/json, rpc, watch, notify, runner, verify
  tui/         Ink app, state/reducer, components, commands
  config/      env + app config
  util/        logging, image loading
test/          node:test suites (offline only)
scripts/       smoke, e2e app, token benchmark (bench)
```

## Conventions

- **Kernel stays zero-dep.** `src/kernel/`, `src/providers/`, `src/tools/`,
  `src/session/` must only use Node builtins. Ink/React are allowed **only** in
  `src/tui/`. If you need a dependency, argue for it in the PR.
- **Types first.** Shared shapes live in `src/kernel/types.ts` (provider, tool,
  message, event). New providers/tools implement those interfaces.
- **Offline tests.** Tests must never hit the network or need an API key. For
  agent-loop behavior use the scripted provider (`test/util/scripted.ts`) and
  recorded fixtures (`test/fixtures/*.json`, see `test/e2e.test.ts`).
- **Strict TS.** `noUnusedLocals`, `noUnusedParameters`, and
  `noUncheckedIndexedAccess` are on. Array indexing returns `T | undefined` —
  handle it.
- **Formatting.** Prettier, single quotes, trailing commas, printWidth 100.
  `npm run format:check` must pass.
- **Token efficiency.** Every prompt/tool string is payload — be concise.
  Prefer streaming, truncation, and progressive disclosure over stuffing
  context.

## Testing

```bash
npm test          # typecheck via tsc build + all suites
npm run bench     # token-efficiency benchmark (offline, recorded fixtures)
npm run smoke     # real provider round-trip — requires API key in .env
```

When adding a feature, add a test in the matching `test/*.test.ts`:

- pure logic → unit test (e.g. tokenizer, reducer, SSE parser)
- provider conversion → `test/providers.test.ts` (stub `globalThis.fetch`)
- multi-step agent behavior → scripted provider in `test/agent-loop.test.ts`
- full loop with tools → a new fixture in `test/fixtures/` +
  `test/e2e.test.ts` case

## Commit style

- Imperative subject, ≤ 50 chars, capitalized, no trailing period.
- Body only when it adds useful context; wrap at 72 chars.
- One logical change per commit; the repo keeps a clean main history.

## Docs

- User-facing behavior changes → `README.md` (features, usage, env table).
- Changelog-worthy changes → `CHANGELOG.md` under `[Unreleased]`.
- Extension APIs → `docs/EXTENDING.md`.
