# Extending RingZero

RingZero is designed to be extended at three levels: **providers** (talk to a
new model API), **tools** (give the agent new capabilities), and **plugins /
skills** (drop-in, per-project extensions). All extension points are plain
TypeScript interfaces in `src/kernel/types.ts` — no framework.

## Adding a provider

A provider implements the `Provider` interface:

```ts
export interface Provider {
  readonly id: string;
  chat(req: ChatRequest): AsyncGenerator<ChatEvent>;
  countTokens(text: string): number;
}
```

- `chat()` receives the provider-agnostic `ChatRequest` (system, messages,
  tools, maxTokens, temperature, signal) and yields `ChatEvent`s:
  `text`, `thinking`, `tool_calls`, `finish` (with usage).
- **Stream.** Yield text/thinking as it arrives. `tool_calls` should be
  emitted as a single event at the end of the stream (accumulate the deltas),
  so an aborted stream never yields partial calls.
- **Abort.** Honor `req.signal` (pass it to `fetch`, or listen and throw
  `new DOMException('Aborted', 'AbortError')`). The agent aborts streams on
  mid-run injection.
- **Messages.** Convert `ProviderMessage[]` to your API's shape. Supported
  shapes today: OpenAI-compatible (`toOpenAIMessages`), Anthropic
  (`toAnthropicMessages`), Gemini (`toGeminiMessages`). User messages may
  carry `images: [{ mime, data }]` (base64) — map them to your vision
  content blocks.
- **SSE.** `consumeSSE(body, signal)` from `src/providers/streaming.ts`
  parses `data:` lines incrementally; `fetchWithRetry` from
  `src/providers/retry.ts` handles 429/5xx/network retries with abort
  awareness.
- **Usage.** Report `TokenUsage` in `finish`: `{ input, output, cacheRead?,
cacheWrite? }`.

### Registering the provider

1. Create `src/providers/<name>.ts` exporting `create<Name>Provider(cfg)`.
2. Add its env knobs to `src/config/env.ts` (e.g. `GEMINI_API_KEY`).
3. Add a branch in `src/providers/registry.ts` `createDefaultProvider()`.
   Order matters: `API_URL` (OpenAI-compatible) always wins over vendor keys;
   among vendor keys, Anthropic wins over Gemini.
4. Advertise the env vars in `README.md` (env table) and `--help`.
5. Test the message conversion and the SSE parsing in
   `test/providers.test.ts` with a stubbed `globalThis.fetch`
   (see the existing Gemini/Anthropic tests).

## Adding a tool

A tool is an object with a JSON-Schema definition and an executor:

```ts
export interface Tool {
  definition: ToolDefinition; // { name, description, inputSchema }
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
```

```ts
// src/tools/mytool.ts
import type { Tool } from '../kernel/types.js';

export function createMyTool(): Tool {
  return {
    definition: {
      name: 'my_tool',
      description: 'One line on what it does and when to call it.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    async execute(input, ctx) {
      // ctx: { cwd, home, workspace?, signal, ask(prompt) }
      return 'the result — keep it short, it becomes context';
    },
  };
}
```

- The result string is fed back to the model verbatim: truncate long output
  (see `src/kernel/truncate.ts`), prefer summaries.
- Use `ctx.signal` to abort long work when the user interrupts.
- Use `ctx.ask()` for anything the user should confirm.
- Register the tool in `src/cli/runner.ts` `agent()` (the `tools` array), or
  expose it via a plugin for per-project use.
- Add a test in `test/tools.test.ts` (or your own suite) — all offline.

## Plugins (drop-in)

Drop a single-file ESM plugin into `<cwd>/.ringzero/plugins/` or
`~/.ringzero/plugins/` (file name = plugin name):

```js
export default async (api) => {
  api.registerTool({
    definition: { name: 'shout', description: '…', inputSchema: { type: 'object' } },
    execute: async ({ text }) => String(text).toUpperCase(),
  });
  api.registerCommand('hello', async ({ args }) => {
    api.say(`hi ${args.join(' ')}`);
  });
  api.onToolBefore(async ({ name, args }) => {
    if (name === 'bash') return { allowed: false }; // or { args: rewritten }
  });
  api.onToolAfter(async ({ name, args, output }) => {
    if (name === 'read_file') return { output: output.slice(0, 1000) };
  });
};
```

See `examples/plugins/hello.mjs`.

## Skills

`<cwd>/.ringzero/skills/<name>/SKILL.md` (or `~/.ringzero/skills/`), enabled
with `/skills <name>`. The file content is appended to the system prompt
**after** the stable prefix so prompt caching is not busted. A skill may also
ship `tools.mjs` (default export = array of `Tool` objects), registered when
the skill is enabled. See `examples/skills/`.

## RPC / SDK mode

`ringzero --rpc` speaks JSON-RPC 2.0 over stdin/stdout, one object per line.
Methods: `initialize`, `ping`, `model/get`, `model/set`, `sessions/list`,
`sessions/resume`, `sessions/export {id?, path?}`, `prompt {text, images?,
notify?}`, `prompt {text, interrupt: true}`.

- `prompt` with `notify: true` emits `prompt/event` notifications for every
  agent event (`{jsonrpc:'2.0', method:'prompt/event', params:{type, ...}}`).
- `prompt` with `interrupt: true` injects a message into the running prompt —
  it bypasses the serial queue so it works mid-flight.
- Responses always carry `id`; errors use JSON-RPC error codes.

Example:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"text":"fix the test","notify":true}}' | ringzero --rpc
```

## Adding a slash command (TUI + REPL)

Built-ins live in two switches that must stay in sync:

- TUI: `handleSlashCommand` in `src/tui/commands.ts` (add to
  `slashCommands()` in `src/tui/state.ts` for auto-complete).
- REPL: `handleSlash` in `src/cli/repl.ts`.

Keep the command synchronous-ish and push one-line feedback via
`pushSys` / `console.log`.
