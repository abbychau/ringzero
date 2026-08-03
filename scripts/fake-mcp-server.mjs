// Fake MCP server over stdio (newline-delimited JSON-RPC) for offline tests.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const args = msg.params.arguments ?? {};
    const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: String(sum) }] },
    });
  }
});
