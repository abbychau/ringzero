import type { Tool } from '../kernel/types.js';

export interface TodoItem {
  text: string;
  done: boolean;
}

/**
 * Todo tool: a mutable scratch list the agent uses to track multi-step work.
 * The shared array lives in the caller (per session), so state survives
 * across turns; onChange notifies the caller (e.g. to persist to disk).
 */
export function createTodoTool(todos: TodoItem[], onChange?: () => void): Tool {
  const render = (): string => {
    if (todos.length === 0) return '(no todos)';
    return todos.map((t, i) => `${i + 1}. ${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n');
  };
  const touch = (): string => {
    onChange?.();
    return render();
  };
  return {
    definition: {
      name: 'todo',
      description:
        'Maintain a numbered todo list for the current task. Ops: add <text>, done <n>, ' +
        'open <n>, clear, list. Returns the full list after each change.',
      inputSchema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['add', 'done', 'open', 'clear', 'list'],
            description: 'Operation to perform.',
          },
          text: { type: 'string', description: 'Text for op=add.' },
          n: { type: 'number', description: '1-based index for op=done/open.' },
        },
        required: ['op'],
      },
    },
    async execute(input: Record<string, unknown>): Promise<string> {
      const op = String(input.op ?? '');
      const n = Number(input.n);
      switch (op) {
        case 'add': {
          const text = String(input.text ?? '').trim();
          if (!text) return 'error: text is required for add';
          todos.push({ text, done: false });
          return touch();
        }
        case 'done':
        case 'open': {
          const idx = Math.floor(n) - 1;
          if (!Number.isInteger(n) || idx < 0 || idx >= todos.length)
            return `error: n out of range (1-${todos.length})`;
          todos[idx]!.done = op === 'done';
          return touch();
        }
        case 'clear':
          todos.length = 0;
          return touch();
        case 'list':
          return render();
        default:
          return `error: unknown op "${op}" (add|done|open|clear|list)`;
      }
    },
  };
}
