import type { Tool } from '../kernel/types.js';

const MAX_BYTES = 500_000;

export function webFetchTool(): Tool {
  return {
    definition: {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its text content (HTML, JSON, or plain text). Capped at ~500KB.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    async execute(input, ctx) {
      const url = String(input.url ?? '');
      if (!/^https?:\/\//i.test(url)) return 'error: only http(s) URLs supported';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: ctx.signal.aborted ? ctx.signal : controller.signal,
          headers: { 'user-agent': 'ringzero-agent/0.1' },
        });
        if (!res.ok) return `error: HTTP ${res.status} ${res.statusText}`;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) return `error: response too large (${buf.length} bytes)`;
        const type = res.headers.get('content-type') ?? '';
        if (type.includes('json')) {
          return buf.toString('utf8');
        }
        if (type.includes('html')) {
          return stripHtml(buf.toString('utf8')).slice(0, 20_000);
        }
        return buf.toString('utf8').slice(0, 20_000);
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
