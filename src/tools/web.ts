import { lookup } from 'node:dns/promises';
import type { Tool } from '../kernel/types.js';

const MAX_BYTES = 500_000;
const MAX_REDIRECTS = 4;

/**
 * SSRF guard: refuse connections to loopback / link-local / private / reserved
 * address space so the model cannot reach internal services or metadata
 * endpoints. Set RINGZERO_ALLOW_PRIVATE_NET=1 to disable (not recommended).
 */

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const octet = Number(p);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isPrivateIpv4(v: number): boolean {
  const a = v >>> 24;
  const b = (v >>> 16) & 0xff;
  const c = (v >>> 8) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, broadcast
  return false;
}

/** True for loopback, link-local, private, ULA, multicast, and documentation ranges. */
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped (::ffff:) and NAT64 (64:ff9b::/96) forms embed a plain IPv4.
  const embedded = ip.match(/^(?:::ffff:|64:ff9b::|64:ff9b:1::)(.+)$/i);
  if (embedded) {
    const v4 = parseIpv4(embedded[1]!);
    return v4 !== null && isPrivateIpv4(v4);
  }
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  if (lower.startsWith('2001:db8')) return true; // 2001:db8::/32 documentation
  const v4 = parseIpv4(ip);
  return v4 !== null && isPrivateIpv4(v4);
}

/**
 * Check a URL before fetching it. Returns an error message, or null if allowed.
 * Hostnames are resolved with DNS; every resolved address must be public.
 */
export async function checkUrlAllowed(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'error: invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return 'error: only http(s) URLs supported';
  const override = process.env.RINGZERO_ALLOW_PRIVATE_NET === '1';
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literal = parseIpv4(hostname);
  if (literal !== null) {
    if (!override && isPrivateIpv4(literal))
      return `error: private network address blocked (${hostname})`;
    return null;
  }
  if (hostname === '::1' || hostname === '::') {
    return override ? null : `error: private network address blocked (${hostname})`;
  }
  if (!/^[a-z0-9.-]+$/i.test(hostname)) return 'error: invalid hostname';
  try {
    const addrs = await lookup(hostname, { all: true });
    if (addrs.length === 0) return 'error: host not found';
    for (const { address } of addrs) {
      if (!override && isPrivateIp(address))
        return `error: host resolves to private address ${address} (${hostname})`;
    }
    return null;
  } catch (err) {
    return `error: DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function webFetchTool(): Tool {
  return {
    definition: {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its text content (HTML, JSON, or plain text). Capped at ~500KB. ' +
        'Private/loopback addresses are blocked.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    async execute(input, ctx) {
      const url = String(input.url ?? '');
      if (!/^https?:\/\//i.test(url)) return 'error: only http(s) URLs supported';
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const problem = await checkUrlAllowed(current);
        if (problem) return problem;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
          const res = await fetch(current, {
            redirect: 'manual',
            signal: ctx.signal.aborted ? ctx.signal : controller.signal,
            headers: { 'user-agent': 'ringzero-agent/0.1' },
          });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) return 'error: redirect without Location header';
            try {
              current = new URL(loc, current).toString();
            } catch {
              return 'error: invalid redirect Location';
            }
            continue;
          }
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
      }
      return `error: too many redirects (max ${MAX_REDIRECTS})`;
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
