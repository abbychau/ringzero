/**
 * http_request: generic HTTP API calls (GET/POST/PUT/PATCH/DELETE) for
 * integrations that need headers or a JSON body. Reuses the web_fetch SSRF
 * guard (private/loopback blocked unless RINGZERO_ALLOW_PRIVATE_NET=1) and
 * goes through the permission gate (ask by default). Zero-dep (global fetch).
 */
import type { Tool, ToolContext } from '../kernel/types.js';
import { checkUrlAllowed } from './web.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY = 8_000;

export function httpRequestTool(): Tool {
  return {
    definition: {
      name: 'http_request',
      description:
        'Make a generic HTTP request (GET/POST/PUT/PATCH/DELETE) to a public API and return the status line plus the response body (capped ~8KB). JSON bodies and custom headers supported. Private/loopback addresses are blocked.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...METHODS], description: 'default GET' },
          url: { type: 'string' },
          body: { type: 'object', description: 'JSON body (for POST/PUT/PATCH)' },
          headers: { type: 'object', description: 'extra headers (string values)' },
          timeout_ms: { type: 'number', description: 'timeout, 1s-120s (default 30s)' },
        },
        required: ['url'],
      },
    },
    async execute(input, ctx: ToolContext) {
      const url = String(input.url ?? '').trim();
      if (!url) return 'error: empty url';
      const method = String(input.method ?? 'GET').toUpperCase();
      if (!METHODS.has(method)) return `error: unsupported method ${method}`;
      const problem = await checkUrlAllowed(url);
      if (problem) return problem;
      const timeout = Math.min(
        120_000,
        Math.max(1_000, Math.floor(Number(input.timeout_ms) || 30_000)),
      );
      const headers: Record<string, string> = { 'user-agent': 'ringzero-agent/0.1' };
      if (input.headers && typeof input.headers === 'object') {
        for (const [k, v] of Object.entries(input.headers)) {
          if (typeof v === 'string' || typeof v === 'number') headers[k] = String(v);
        }
      }
      let body: string | undefined;
      if (input.body !== undefined) {
        if (typeof input.body !== 'object' || input.body === null)
          return 'error: body must be a JSON object';
        body = JSON.stringify(input.body);
        headers['content-type'] = 'application/json';
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body,
          signal: ctx.signal.aborted ? ctx.signal : controller.signal,
        });
        const text = (await res.text()).slice(0, MAX_BODY);
        return `HTTP ${res.status} ${res.statusText}\n${text}`;
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
