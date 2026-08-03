import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type McpServerConfig =
  | { command: string; args?: string[]; cwd?: string }
  | { url: string; headers?: Record<string, string> };

export type McpConfig = Record<string, McpServerConfig>;

/** Load MCP server config: env RINGZERO_MCP (JSON) > <dir>/.ringzero/mcp.json. */
export function loadMcpConfig(cwd: string, home: string): McpConfig {
  const fromEnv = process.env.RINGZERO_MCP;
  if (fromEnv) {
    try {
      return JSON.parse(fromEnv) as McpConfig;
    } catch {
      /* ignore bad env */
    }
  }
  for (const dir of [cwd, home]) {
    const p = join(dir, '.ringzero', 'mcp.json');
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as McpConfig;
      } catch {
        /* ignore bad file */
      }
    }
  }
  return {};
}
