/**
 * web_search: opt-in search tool. Registered only when RINGZERO_SEARCH_KEY is
 * set (with optional RINGZERO_SEARCH_ENDPOINT). Talks the Tavily JSON
 * contract: POST {api_key, query, max_results} → {results:[{title,url,content}]}.
 * Pairs with the `task` fan-out for parallel research. Zero-dep (global fetch).
 */
import type { Tool, ToolContext } from '../kernel/types.js';

const DEFAULT_ENDPOINT = 'https://api.tavily.com/search';
const MAX_RESULTS = 5;
const SNIPPET = 400;

export function webSearchTool(cfg: { apiKey: string; endpoint?: string }): Tool {
  const endpoint = cfg.endpoint?.trim() || DEFAULT_ENDPOINT;
  return {
    definition: {
      name: 'web_search',
      description: `Search the web (Tavily-compatible endpoint). Returns up to ${MAX_RESULTS} results with title, url, and a content excerpt. Only available when RINGZERO_SEARCH_KEY is configured.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'search query' },
          max_results: { type: 'number', description: `1-${MAX_RESULTS} (default ${MAX_RESULTS})` },
        },
        required: ['query'],
      },
    },
    async execute(input, ctx: ToolContext) {
      const query = String(input.query ?? '').trim();
      if (!query) return 'error: empty query';
      const maxResults = Math.min(
        MAX_RESULTS,
        Math.max(1, Math.floor(Number(input.max_results) || MAX_RESULTS)),
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          signal: ctx.signal.aborted ? ctx.signal : controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: maxResults }),
        });
        if (!res.ok) return `error: HTTP ${res.status} ${res.statusText}`;
        const data = (await res.json()) as {
          results?: { title?: string; url?: string; content?: string }[];
        };
        const results = (data.results ?? []).slice(0, maxResults);
        if (!results.length) return '(no results)';
        return results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title ?? '(untitled)'}\n   ${r.url ?? ''}\n   ${(
                r.content ?? ''
              ).slice(0, SNIPPET)}`,
          )
          .join('\n');
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
