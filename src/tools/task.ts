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
  /** Tools available to sub-agents (default: the built-in toolset). */
  tools?: Tool[];
  /** Max parallel sub-agents in batch mode (default 4). */
  maxConcurrency?: number;
  /** Called with each sub-agent's cumulative token usage when it finishes. */
  onUsage?: (u: TokenUsage) => void;
}

const SUMMARY_CAP = 4000;
const MERGED_CAP = 8000;

/**
 * Sub-agent tool (token-efficient): spawns fresh Agents on the same provider
 * (same model as the main loop — no multi-model routing), runs them with the
 * default tools, and returns only short summaries. Sub-agent transcripts are
 * ephemeral (not persisted), so only the summaries enter context.
 *
 * Single mode: `task` string → one sub-agent, returns its summary.
 * Batch mode: `tasks` array → N sub-agents run in parallel (capped), results
 * merged into one numbered report; one failing sub-agent doesn't kill the rest.
 */
export function createTaskTool(opts: TaskToolOptions): Tool {
  const runSub = async (task: string, ctx: { cwd: string; home: string; signal: AbortSignal }) => {
    const sub = new Agent({
      provider: opts.provider,
      tools: opts.tools ?? defaultTools(),
      permission: opts.permission,
      system: [SUBAGENT_SYSTEM],
      cwd: ctx.cwd,
      home: ctx.home,
      contextBudget: opts.contextBudget,
      preserveRecentTokens: opts.preserveRecentTokens,
      maxSteps: opts.maxSteps ?? 12,
      signal: ctx.signal,
    });
    let summary = '';
    try {
      for await (const ev of sub.run(task)) {
        if (ev.type === 'text') summary += ev.text;
        else if (ev.type === 'finish' && ev.usage) opts.onUsage?.(ev.usage);
      }
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return (summary || '[sub-agent returned nothing]').slice(0, SUMMARY_CAP);
  };

  return {
    definition: {
      name: 'task',
      description:
        'Delegate independent subtasks to sub-agents that run tools themselves and return short summaries. ' +
        'Give `task` (string) for a single subtask, or `tasks` (array of strings) to fan out N independent ' +
        'research/implementation subtasks in parallel — results come back merged into one numbered report. ' +
        'Use for large independent chunks of work.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Single subtask (use this OR tasks).' },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Parallel subtasks, run concurrently and merged (use this OR task).',
          },
        },
      },
    },
    async execute(input, ctx) {
      const tasks = input.tasks;
      if (Array.isArray(tasks)) {
        if (tasks.length === 0) return 'error: tasks array is empty';
        const limit = Math.max(1, opts.maxConcurrency ?? 4);
        const results: string[] = new Array(tasks.length);
        let next = 0;
        const worker = async () => {
          while (next < tasks.length) {
            const i = next++;
            results[i] = await runSub(String(tasks[i] ?? ''), ctx);
          }
        };
        await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
        const merged = tasks
          .map(
            (t, i) =>
              `### Task ${i + 1}: ${String(t).trim().split('\n')[0]!.slice(0, 80)}\n${results[i]}`,
          )
          .join('\n\n');
        return merged.length > MERGED_CAP
          ? merged.slice(0, MERGED_CAP) + '\n…[merged output truncated]…'
          : merged;
      }
      return runSub(String(input.task ?? ''), ctx);
    },
  };
}
