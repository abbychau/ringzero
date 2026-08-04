import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { webSearchTool } from '../src/tools/search_web.js';
import type { ToolContext } from '../src/kernel/types.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  home: homedir(),
  signal: new AbortController().signal,
  ask: async () => true,
};

function startTavilyLikeServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        if (parsed.query === 'nothing') {
          res.end(JSON.stringify({ results: [] }));
        } else {
          res.end(
            JSON.stringify({
              results: [
                { title: 'first hit', url: 'https://example.com/1', content: 'alpha content' },
                { title: 'second hit', url: 'https://example.com/2', content: 'beta content' },
              ],
            }),
          );
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

test('web_search returns formatted results', async () => {
  const { server, url } = await startTavilyLikeServer();
  try {
    const tool = webSearchTool({ apiKey: 'test-key', endpoint: url });
    const out = await tool.execute({ query: 'ringzero' }, ctx);
    assert.ok(out.includes('1. first hit'), out);
    assert.ok(out.includes('https://example.com/1'), out);
    assert.ok(out.includes('alpha content'), out);
    assert.ok(out.includes('2. second hit'), out);
  } finally {
    server.close();
  }
});

test('web_search handles empty results and empty query', async () => {
  const { server, url } = await startTavilyLikeServer();
  try {
    const tool = webSearchTool({ apiKey: 'test-key', endpoint: url });
    const none = await tool.execute({ query: 'nothing' }, ctx);
    assert.ok(none.includes('no results'), none);
    const bad = await tool.execute({ query: '   ' }, ctx);
    assert.ok(bad.includes('empty query'), bad);
  } finally {
    server.close();
  }
});
