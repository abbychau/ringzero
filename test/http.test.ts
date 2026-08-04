import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { httpRequestTool } from '../src/tools/http.js';
import type { ToolContext } from '../src/kernel/types.js';

// Localhost is a private address — the SSRF guard blocks it unless opted out.
process.env.RINGZERO_ALLOW_PRIVATE_NET = '1';

const ctx: ToolContext = {
  cwd: process.cwd(),
  home: homedir(),
  signal: new AbortController().signal,
  ask: async () => true,
};

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/echo' && req.method === 'POST') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ method: req.method, got: JSON.parse(body) }));
        } else if (req.url === '/status') {
          res.statusCode = 404;
          res.end('nope');
        } else {
          res.end('hello world');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
      });
    });
  });
}

test('http_request GET returns the body with a status line', async () => {
  const { server, url } = await startServer();
  try {
    const out = await httpRequestTool().execute({ url: `${url}/` }, ctx);
    assert.ok(out.startsWith('HTTP 200'), out);
    assert.ok(out.includes('hello world'), out);
  } finally {
    server.close();
  }
});

test('http_request POST sends a JSON body', async () => {
  const { server, url } = await startServer();
  try {
    const out = await httpRequestTool().execute(
      { method: 'POST', url: `${url}/echo`, body: { a: 1 } },
      ctx,
    );
    assert.ok(out.includes('"got":{"a":1}'), out);
    assert.ok(out.includes('"method":"POST"'), out);
  } finally {
    server.close();
  }
});

test('http_request surfaces non-2xx status', async () => {
  const { server, url } = await startServer();
  try {
    const out = await httpRequestTool().execute({ url: `${url}/status` }, ctx);
    assert.ok(out.startsWith('HTTP 404'), out);
  } finally {
    server.close();
  }
});

test('http_request rejects unsupported methods and private networks by default', async () => {
  const { server, url } = await startServer();
  try {
    const badMethod = await httpRequestTool().execute({ method: 'TRACE', url: `${url}/` }, ctx);
    assert.ok(badMethod.includes('unsupported method'), badMethod);
    // SSRF guard without the override
    const prev = process.env.RINGZERO_ALLOW_PRIVATE_NET;
    delete process.env.RINGZERO_ALLOW_PRIVATE_NET;
    try {
      const blocked = await httpRequestTool().execute({ url: `${url}/` }, ctx);
      assert.ok(blocked.includes('private network'), blocked);
    } finally {
      if (prev !== undefined) process.env.RINGZERO_ALLOW_PRIVATE_NET = prev;
    }
  } finally {
    server.close();
  }
});
