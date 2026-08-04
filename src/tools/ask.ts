/**
 * ask_user: let the agent pause and ask the user a question mid-run.
 * Only available when the session is interactive (TUI/REPL wire a free-text
 * prompt channel into ToolContext.promptUser); one-shot, RPC, watch, and
 * sub-agent runs return a short "(unavailable)" note instead of blocking.
 */
import type { Tool, ToolContext } from '../kernel/types.js';

const MAX_CHOICES = 5;

export function askUserTool(): Tool {
  return {
    definition: {
      name: 'ask_user',
      description:
        'Ask the user a question mid-run and return their answer (free text, or pick from choices). Only available in interactive sessions; use it when a decision is blocking and guessing would waste a whole turn.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'the question to ask' },
          choices: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_CHOICES,
            description: 'optional numbered options (each ≤ 80 chars)',
          },
        },
        required: ['prompt'],
      },
    },
    async execute(input, ctx: ToolContext) {
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) return 'error: empty prompt';
      if (!ctx.promptUser) return '(ask_user is unavailable in this mode — non-interactive run)';
      const choices = Array.isArray(input.choices)
        ? input.choices
            .map((c) => String(c).trim())
            .filter(Boolean)
            .slice(0, MAX_CHOICES)
        : [];
      let q = prompt;
      if (choices.length) {
        q += `\nOptions:\n${choices.map((c, i) => `${i + 1}. ${c.slice(0, 80)}`).join('\n')}\nReply with a number (1-${choices.length}) or your own answer.`;
      }
      const answer = await ctx.promptUser(q);
      if (answer === null) return '(cancelled — user closed the prompt)';
      const trimmed = answer.trim();
      if (!trimmed) return '(empty answer)';
      const num = Number(trimmed);
      if (choices.length && Number.isInteger(num) && num >= 1 && num <= choices.length) {
        return `user chose: ${choices[num - 1]!}`;
      }
      return `user answered: ${trimmed.slice(0, 2000)}`;
    },
  };
}
