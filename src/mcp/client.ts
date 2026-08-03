import type { Transport } from './transports.js';
import { VERSION } from '../version.js';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
}

interface McpContentBlock {
  type?: string;
  text?: string;
  mimeType?: string;
  uri?: string;
}

interface McpCallResult {
  isError?: boolean;
  content?: McpContentBlock[];
}

function parseResponse(raw: string): JsonRpcResponse | undefined {
  try {
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== 'object' || o === null) return undefined;
    return o as JsonRpcResponse;
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** JSON-RPC 2.0 MCP client over any Transport. Zero deps. */
export class McpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly transport: Transport) {}

  async connect(): Promise<void> {
    await this.transport.start((raw) => this.handleMessage(raw));
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ringzero', version: VERSION },
    });
    await this.notify('notifications/initialized', {});
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.transport.send(JSON.stringify(req)).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.transport.send(JSON.stringify(req));
  }

  async ping(): Promise<void> {
    await this.request('ping');
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.request('tools/list');
    const tools = asRecord(res).tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((t): McpTool => {
      const o = asRecord(t);
      return {
        name: String(o.name ?? 'tool'),
        description: typeof o.description === 'string' ? o.description : undefined,
        inputSchema: asRecord(o.inputSchema),
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request('tools/call', { name, arguments: args })) as
      Partial<McpCallResult> | undefined;
    const content = Array.isArray(res?.content) ? res.content : [];
    if (res?.isError) {
      const text = content.map((c) => c.text ?? '').join('\n');
      return `error: ${text || 'mcp tool error'}`;
    }
    const parts: string[] = [];
    for (const c of content) {
      if (c.type === 'text') parts.push(c.text ?? '');
      else if (c.type === 'image') parts.push(`[image ${c.mimeType ?? 'unknown'}]`);
      else parts.push(JSON.stringify(c));
    }
    return parts.join('\n') || '(empty result)';
  }

  async listResources(): Promise<McpResourceInfo[]> {
    const res = await this.request('resources/list');
    const items = asRecord(res).resources;
    if (!Array.isArray(items)) return [];
    return items.map((r): McpResourceInfo => {
      const o = asRecord(r);
      return {
        uri: String(o.uri ?? ''),
        name: typeof o.name === 'string' ? o.name : undefined,
        description: typeof o.description === 'string' ? o.description : undefined,
      };
    });
  }

  async readResource(uri: string): Promise<string> {
    const res = await this.request('resources/read', { uri });
    const contents = asRecord(res).contents;
    if (!Array.isArray(contents)) return '(empty resource)';
    const parts = contents.map((c): string => {
      const o = asRecord(c);
      return typeof o.text === 'string' && o.text ? o.text : `[${String(o.uri ?? '')}]`;
    });
    return parts.join('\n') || '(empty resource)';
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private handleMessage(raw: string): void {
    const msg = parseResponse(raw);
    if (!msg || msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error)
      p.reject(new Error(`MCP ${msg.error.code ?? 'error'}: ${msg.error.message ?? 'unknown'}`));
    else p.resolve(msg.result);
    // server-initiated notifications/methods are ignored for v1
  }
}
