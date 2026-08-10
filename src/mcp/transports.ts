import { spawn, type ChildProcess } from 'node:child_process';
import { consumeSSE } from '../providers/streaming.js';

/** A transport delivers raw JSON-RPC message strings. */
export interface Transport {
  start(onMessage: (raw: string) => void): Promise<void>;
  send(raw: string): Promise<void>;
  close(): Promise<void>;
}

/** stdio transport: spawns an MCP server process, newline-delimited JSON. */
export function stdioTransport(command: string, args: string[], cwd: string): Transport {
  let child: ChildProcess | undefined;
  let onMsg: (raw: string) => void = () => {};
  let buf = '';
  return {
    async start(onMessage) {
      onMsg = onMessage;
      child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) onMsg(line);
        }
      });
      child.stderr!.on('data', (d: Buffer) => {
        const s = d.toString().trim();
        if (s) console.error(`[mcp-stdio] ${s}`);
      });
      child.on('error', (e) => console.error(`[mcp-stdio] spawn error: ${e.message}`));
    },
    async send(raw) {
      if (!child?.stdin?.writable) throw new Error('mcp stdio not started');
      child.stdin.write(raw + '\n');
    },
    async close() {
      child?.kill();
    },
  };
}

/** streamable HTTP transport (MCP spec 2025-06-18): POST + JSON or SSE response. */
export function httpTransport(url: string, headers: Record<string, string> = {}): Transport {
  let sessionId: string | undefined;
  let onMsg: (raw: string) => void = () => {};
  return {
    async start(onMessage) {
      onMsg = onMessage;
    },
    async send(raw) {
      const h: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      };
      if (sessionId) h['mcp-session-id'] = sessionId;
      const res = await fetch(url, { method: 'POST', headers: h, body: raw });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `MCP HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
        );
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      if (!res.body) return;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream')) {
        for await (const ev of consumeSSE(res.body)) {
          if (ev.data) onMsg(ev.data);
        }
      } else {
        onMsg(await res.text());
      }
    },
    async close() {
      /* no persistent connection to close */
    },
  };
}
