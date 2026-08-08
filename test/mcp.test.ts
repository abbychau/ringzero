import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient } from '../src/mcp/client.js';
import { stdioTransport, type Transport } from '../src/mcp/transports.js';
import { join } from 'node:path';
import { repoRoot } from './root.js';
class FakeTransport implements Transport {
  onMsg: (raw: string) => void = () => {};
  sent: string[] = [];
  async start(onMessage: (raw: string) => void): Promise<void> {
    this.onMsg = onMessage;
  }
  async send(raw: string): Promise<void> {
    this.sent.push(raw);
    const req = JSON.parse(raw);
    if (req.id === undefined) return; // notification
    if (req.method === 'initialize') {
      this.onMsg(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
        }),
      );
    } else if (req.method === 'tools/list') {
      this.onMsg(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { tools: [{ name: 'echo', description: 'echo tool', inputSchema: {} }] },
        }),
      );
    } else if (req.method === 'tools/call') {
      this.onMsg(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: 'pong' }] },
        }),
      );
    }
  }
  async close(): Promise<void> {}
}

test('mcp client routes responses by id (offline)', async () => {
  const t = new FakeTransport();
  const c = new McpClient(t);
  await c.connect();
  const tools = await c.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'echo');
  assert.equal(await c.callTool('echo', {}), 'pong');
  await c.close();
});

// scripts/fake-mcp-server.mjs lives at repo root; resolve it layout-independently
// (tsc → dist/test/…, bun → test/…).
const repoRootDir = repoRoot();
const serverPath = join(repoRootDir, 'scripts', 'fake-mcp-server.mjs');

test('mcp stdio transport talks to a real spawned server', async () => {
  const t = stdioTransport(process.execPath, [serverPath], repoRootDir);
  const c = new McpClient(t);
  await c.connect();
  const tools = await c.listTools();
  assert.ok(tools.some((x) => x.name === 'add'));
  assert.equal(await c.callTool('add', { a: 2, b: 3 }), '5');
  await c.close();
});
