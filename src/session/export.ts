import type { SessionStore } from './store.js';

/**
 * Render a session as a Markdown transcript: title, meta, per-message
 * sections with tool calls, and total token usage at the end.
 */
export function exportMarkdown(store: SessionStore, id: string): string | null {
  const meta = store.list().find((m) => m.id === id);
  if (!meta) return null;
  const msgs = store.load(id);
  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  lines.push('');
  lines.push(`- session: ${meta.id}`);
  lines.push(`- created: ${new Date(meta.created).toISOString()}`);
  lines.push(`- updated: ${new Date(meta.updated).toISOString()}`);
  lines.push('');

  for (const m of msgs) {
    if (m.role === 'user') {
      lines.push(`## User\n\n${m.content}\n`);
    } else if (m.role === 'assistant') {
      lines.push(`## Assistant\n\n${m.content || '(no text)'}\n`);
      if (m.toolCalls?.length) {
        lines.push(
          '**tools:** ' + m.toolCalls.map((tc) => `${tc.name}(${tc.args})`).join(', ') + '\n',
        );
      }
    } else if (m.role === 'tool') {
      lines.push(`### tool: ${m.toolName ?? m.toolCallId ?? '?'}\n\n${m.content}\n`);
    }
  }

  const usage = msgs.reduce(
    (acc, m) => {
      if (m.role === 'assistant' && m.usage) {
        acc.input += m.usage.input;
        acc.output += m.usage.output;
        acc.cacheRead += m.usage.cacheRead ?? 0;
        acc.cacheWrite += m.usage.cacheWrite ?? 0;
      }
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  lines.push(
    `---\n**token usage:** in=${usage.input} out=${usage.output}` +
      (usage.cacheRead ? ` cached=${usage.cacheRead}` : '') +
      (usage.cacheWrite ? ` cacheWrite=${usage.cacheWrite}` : ''),
  );
  lines.push('');
  return lines.join('\n');
}
