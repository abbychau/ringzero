import type { Provider, Tool, TokenUsage } from '../kernel/types.js';
import { Agent } from '../kernel/agent.js';
import { defaultTools } from './index.js';
import { PermissionGate } from '../permission/gate.js';

const SUBAGENT_SYSTEM = `You are a sub-agent. Complete the given task using tools. Be efficient: read only what you need, prefer targeted edits. Finish by replying with a concise summary (a few lines) of what you did and the key result.`;

export interface TaskToolOptions {
  provider: Provider;
  permission: PermissionGate;
  cwd: string;
  home: string;
  contextBudget?: number;
  preserveRecentTokens?: number;
  maxSteps?: number;
  /** Called with the sub-agent's cumulative token usage when it finishes. */
  onUsage?: (u: TokenUsage) => void;
}

/**
 * Sub-agent tool (token-efficient): spawns a fresh Agent on the same provider,
 * runs it with default tools, and returns only a short summary. The sub-agent's
 * transcript is ephemeral (not persisted), so only the summary enters context.
 */
export function createTaskTool(opts: TaskToolOptions): Tool {
  return {
    definition: {
      name: 'task',
      description:
        'Delegate a self-contained subtask to a sub-agent that runs tools independently and returns a short summary. Use for large independent chunks of work.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' } },
        required: ['task'],
      },
    },
    async execute(input, ctx) {
      const sub = new Agent({
        provider: opts.provider,
        tools: defaultTools(),
        permission: opts.permission,
        system: [SUBAGENT_SYSTEM],
        cwd: ctx.cwd,
        home: ctx.home,
        contextBudget: opts.contextBudget,
        preserveRecentTokens: opts.preserveRecentTokens,
        maxSteps: opts.maxSteps ?? 12,
      });
      let summary = '';
      for await (const ev of sub.run(String(input.task ?? ''))) {
        if (ev.type === 'text') summary += ev.text;
        else if (ev.type === 'finish' && ev.usage) opts.onUsage?.(ev.usage);
      }
      return (summary || '[sub-agent returned nothing]').slice(0, 4000);
    },
  };
}
