import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins, type PluginApi } from '../src/plugin/index.js';

test('loadPlugins loads a plugin and registers tools/commands/hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-plug-'));
  writeFileSync(
    join(dir, 'hello.mjs'),
    `export default async function init(api) {
      api.registerTool({ definition: { name: "plugin_hello", description: "hello", inputSchema: {} }, execute: async () => "world" });
      api.registerCommand("hello", (args, a) => { a.say("hello " + args.join(" ")); });
      api.onToolBefore(async ({ name }) => name === "bash" ? { allowed: false } : undefined);
    }`,
  );
  const loaded = await loadPlugins([dir]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.name, 'hello');

  const tools: any[] = [];
  const commands = new Map<string, any>();
  let hook: any;
  const says: string[] = [];
  const api: PluginApi = {
    name: 'hello',
    registerTool: (t) => tools.push(t),
    registerCommand: (n, f) => commands.set(n, f),
    onToolBefore: (f) => (hook = f),
    say: (t) => says.push(t),
  };
  await loaded[0]!.init(api);

  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.definition.name, 'plugin_hello');
  assert.ok(commands.has('hello'));
  await commands.get('hello')(['world'], api);
  assert.deepEqual(says, ['hello world']);
  const r = await hook({ name: 'bash', args: {} });
  assert.deepEqual(r, { allowed: false });

  rmSync(dir, { recursive: true, force: true });
});
