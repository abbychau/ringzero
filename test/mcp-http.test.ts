import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpTools } from '../src/mcp/index.js';
import { McpClient } from '../src/mcp/client.js';
import { httpTransport } from '../src/mcp/transports.js';
import type { ToolContext } from '../src/kernel/types.js';
import { homedir } from 'node:os';

const toolCtx: ToolContext = {
  cwd: process.cwd(),
  home: homedir(),
  signal: new AbortController().signal,
  ask: async () => true,
};

/**
 * P7.1 — offline coverage for the MCP streamable-HTTP transport (the {url}
 * config path). The server speaks the 2025-06-18 streamable protocol over a
 * local port: JSON responses for initialize/tools/call, an SSE response for
 * tools/list (both response shapes the transport must handle), a session id
 * header round-trip, plus a failure route for error handling.
 */
let server: Server;
let seenSessionIds: string[] = [];

async function startServer(): Promise<string> {
  seenSessionIds = [];
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body) as { id?: number; method: string };
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') seenSessionIds.push(sid);
    if (req.url === '/fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } }));
      return;
    }
    if (msg.method === 'initialize') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'sess-http-1',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
        }),
      );
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (msg.method === 'ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } }),
      );
      return;
    }
    if (msg.method === 'tools/list') {
      // SSE response: exercises the text/event-stream branch of the transport.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [{ name: 'http-echo', description: 'echo over http', inputSchema: {} }],
          },
        })}\n\n`,
      );
      res.end();
      return;
    }
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'http-pong' }] },
        }),
      );
      return;
    }
    if (msg.method === 'resources/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { resources: [] } }));
      return;
    }
    res.writeHead(400);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

test('mcp {url} config path: initialize + SSE tools/list + tools/call round-trip', async () => {
  const url = await startServer();
  try {
    const tools = await createMcpTools({ http1: { url } }, process.cwd());
    assert.equal(tools.length, 1, 'expected one prefixed tool');
    assert.equal(tools[0]!.definition.name, 'http1_http-echo');
    assert.equal(await tools[0]!.execute({}, toolCtx), 'http-pong');
    // The session id issued on initialize must be echoed on later requests.
    assert.ok(seenSessionIds.includes('sess-http-1'), `seen: ${JSON.stringify(seenSessionIds)}`);
  } finally {
    server.close();
  }
});

test('http transport rejects non-2xx with a status-line error', async () => {
  const url = await startServer();
  try {
    const t = httpTransport(url.replace('/mcp', '/fail'));
    await t.start(() => {});
    await assert.rejects(
      () => t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })),
      /MCP HTTP 500/,
    );
    await t.close();
  } finally {
    server.close();
  }
});

test('http transport surfaces JSON-RPC errors from a 200 response', async () => {
  const url = await startServer();
  try {
    // A JSON-RPC error in a 200 body must reject the matching pending request.
    const client = new McpClient(httpTransport(url));
    await client.connect();
    await assert.rejects(() => client.ping(), /MCP -32000: boom/);
    await client.close();
  } finally {
    server.close();
  }
});

test('http transport tolerates malformed response bodies without hanging', async () => {
  const server2 = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{definitely not json');
  });
  await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
  try {
    const { port } = server2.address() as AddressInfo;
    const t = httpTransport(`http://127.0.0.1:${port}/mcp`);
    const received: string[] = [];
    await t.start((raw) => received.push(raw));
    await t.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    // The transport must deliver the raw (broken) body without throwing; the
    // client's JSON.parse handles the error. Nothing may hang.
    assert.equal(received.length, 1);
    assert.match(received[0]!, /not json/);
    await t.close();
  } finally {
    server2.close();
  }
});
