/**
 * HIP-0300: Unified MCP Tools Architecture
 *
 * 8 core tools + optional tools. One canonical way to do everything.
 *
 * Core:    fs, exec, code, git, fetch, workspace, ui
 * Optional: think, llm, memory, hanzo, plan, tasks, mode
 */

import { Tool } from '../../types/index.js';

// Core HIP-0300 tools
import { fsTool } from './fs.js';
import { execTool } from './exec.js';
import { codeTool } from './code.js';
import { fetchTool } from './fetch.js';
import { workspaceTool } from './workspace.js';

// VCS — already a single action-routed tool
import { gitTool } from '../git.js';

// UI — already unified
import { unifiedUITool } from '../unified-ui.js';

// Optional tools
import { thinkTool } from '../think.js';
import { memoryTool } from '../memory.js';
import { planTool } from '../plan.js';
import { tasksTool } from '../tasks.js';
import { modeTool } from '../mode-preset.js';
import { hanzoTool } from './hanzo.js';

// The canonical tool surface
export const coreTools: Tool[] = [
  fsTool,           // Bytes + Paths
  execTool,         // Execution
  codeTool,         // Symbols + Semantics
  gitTool,          // Diffs + History
  fetchTool,        // HTTP/API
  workspaceTool,    // Project Context
  unifiedUITool,    // UI Components
];

export const optionalTools: Tool[] = [
  thinkTool,   // Structured reasoning
  memoryTool,  // Persistent storage
  hanzoTool,   // Hanzo platform (iam/kms/paas/commerce/storage/auth/api)
  planTool,    // Task planning
  tasksTool,   // Task tracking
  modeTool,    // Developer modes
];

export const allUnifiedTools: Tool[] = [
  ...coreTools,
  ...optionalTools,
];

// Re-exports
export { fsTool } from './fs.js';
export { execTool } from './exec.js';
export { codeTool } from './code.js';
export { fetchTool } from './fetch.js';
export { workspaceTool } from './workspace.js';
export { hanzoTool } from './hanzo.js';
