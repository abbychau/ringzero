import type { Tool, ToolContext } from '../kernel/types.js';
import { PLAN_APPROVED, PLAN_REJECTED } from '../kernel/types.js';

/**
 * Plan tool: the agent presents a plan and the user approves or rejects it.
 * In plan mode the kernel blocks all non-read-only tools until approval;
 * the plan tool itself self-gates through ctx.ask.
 */
export function planTool(): Tool {
  return {
    definition: {
      name: 'plan',
      description:
        'Present a plan for the user to approve before making changes. Call this before ' +
        'running any mutating tool (write/edit/bash/git commit) when a task involves ' +
        'multiple steps. Returns approval or rejection.',
      inputSchema: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: 'The plan text: what you will change and how.' },
        },
        required: ['plan'],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const plan = String(input.plan ?? '').trim();
      if (!plan) return 'error: plan text is empty';
      const ok = await ctx.ask(`📋 Plan — approve?\n\n${plan}`);
      return ok ? PLAN_APPROVED : PLAN_REJECTED;
    },
  };
}
