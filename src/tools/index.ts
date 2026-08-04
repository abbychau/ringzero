import type { Tool } from '../kernel/types.js';
import { readFileTool, writeFileTool, editFileTool } from './fs.js';
import { grepTool, globTool } from './search.js';
import { bashTool } from './bash.js';
import { webFetchTool } from './web.js';
import { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool } from './git.js';
import { planTool } from './plan.js';
import { relatedFilesTool } from './related.js';
import { listDirTool, treeTool } from './explore.js';

/** Default built-in toolset. Later phases add task (sub-agent) and mcp. */
export function defaultTools(): Tool[] {
  return [
    readFileTool(),
    writeFileTool(),
    editFileTool(),
    listDirTool(),
    treeTool(),
    grepTool(),
    globTool(),
    relatedFilesTool(),
    bashTool(),
    webFetchTool(),
    gitStatusTool(),
    gitDiffTool(),
    gitLogTool(),
    gitCommitTool(),
    planTool(),
  ];
}
