import type { Tool } from '../kernel/types.js';
import { runCommand } from './bash.js';

const MAX_RUNS = 3;
const TIMEOUT_MS = 60_000;

/**
 * The `verify` tool: run the project verify command (build/tests) and report
 * its output. The output includes the exit code on failure. It is capped at
 * MAX_RUNS invocations per agent run so a model stuck in a verify→fix loop
 * cannot spin forever. The automatic post-edit hook (makeVerifyHook) covers
 * the first check; this tool covers explicit re-checks after each fix.
 */
export function createVerifyTool(command: string, cwd: string): Tool {
  let runs = 0;
  return {
    definition: {
      name: 'verify',
      description:
        'Run the project verify command (build/tests) and return its output. ' +
        'Call it after editing so a broken build or test surfaces immediately; ' +
        'the output includes the exit code on failure. At most 3 calls per run.',
      inputSchema: { type: 'object', properties: {} },
    },
    async execute(_input, ctx) {
      if (runs >= MAX_RUNS) {
        return `[verify ${runs}/${MAX_RUNS}] skipped: already ran ${runs} times this run — fix based on the last output`;
      }
      runs++;
      try {
        const out = await runCommand(command, cwd, TIMEOUT_MS, ctx.signal);
        return `[verify ${runs}/${MAX_RUNS}] ${out.trim()}`;
      } catch (e) {
        return `[verify ${runs}/${MAX_RUNS}] error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
