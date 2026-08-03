import { runCommand } from '../tools/bash.js';

export type ToolAfterHookFn = (
  name: string,
  args: Record<string, unknown>,
  output: string,
) => Promise<{ output?: string } | undefined> | { output?: string } | undefined;

/**
 * Build a post-tool verification hook from a shell command (RINGZERO_VERIFY,
 * e.g. "npm test" or "npm run build"). After the first write/edit tool of a
 * run, the command executes once and its output is appended to the tool
 * result, so the model immediately sees whether the change broke anything.
 * The `verified` flag makes it run at most once per Agent run.
 */
export function makeVerifyHook(command: string, cwd: string): ToolAfterHookFn {
  let verified = false;
  return async (name, _args, output) => {
    if (verified) return undefined;
    if (name !== 'write_file' && name !== 'edit_file') return undefined;
    verified = true;
    try {
      const out = await runCommand(command, cwd, 60_000);
      return { output: `${output}\n[verify] ${out.trim()}` };
    } catch (e) {
      return {
        output: `${output}\n[verify] error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };
}
