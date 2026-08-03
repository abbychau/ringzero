import type { Tool } from '../kernel/types.js';
import { McpClient } from './client.js';
import { stdioTransport, httpTransport } from './transports.js';
import type { McpConfig } from './config.js';

/**
 * Connect to all configured MCP servers and expose their tools as ringzero
 * Tool objects (name-prefixed with the server name to avoid collisions).
 */
export async function createMcpTools(cfg: McpConfig, cwd: string): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const [serverName, s] of Object.entries(cfg)) {
    const transport =
      'command' in s
        ? stdioTransport(s.command, s.args ?? [], s.cwd ?? cwd)
        : httpTransport(s.url, s.headers);
    const client = new McpClient(transport);
    try {
      await client.connect();
      const defs = await client.listTools();
      for (const d of defs) {
        const fullName = `${serverName}_${d.name}`;
        tools.push({
          definition: {
            name: fullName,
            description: d.description ?? '',
            inputSchema: d.inputSchema ?? {},
          },
          async execute(input) {
            return client.callTool(d.name, input as Record<string, unknown>);
          },
        });
      }
      const resources = await client.listResources();
      if (resources.length) {
        tools.push({
          definition: {
            name: `${serverName}_read_resource`,
            description: `Read a resource (by URI) from MCP server ${serverName}.`,
            inputSchema: {
              type: 'object',
              properties: { uri: { type: 'string' } },
              required: ['uri'],
            },
          },
          async execute(input) {
            return client.readResource(String(input.uri ?? ''));
          },
        });
      }
    } catch (e) {
      console.error(
        `[mcp] failed to connect "${serverName}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return tools;
}
