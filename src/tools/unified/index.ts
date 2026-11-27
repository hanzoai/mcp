/**
 * HIP-0300: Canonical 19-Tool MCP Surface ("One and One Way to Do Everything")
 *
 * Exact same 19 orthogonal tools across Rust (`hanzo-mcp`), TypeScript (`@hanzo/mcp`),
 * and Python (`hanzo-mcp`):
 *   fs, exec, code, git, fetch, workspace, browser, computer, ui,
 *   kai, think, plan, memory, tasks, tracker, coding, research, skills, hanzo
 */

import { Tool } from '../../types/index.js';

// Core HIP-0300 local tools
import { fsTool } from './fs.js';
import { execTool } from './exec.js';
import { codeTool } from './code.js';
import { gitTool } from '../git.js';
import { fetchTool } from './fetch.js';
import { workspaceTool } from './workspace.js';
import { browserTool, browserReadTool, cdpTool } from '../browser.js';
import { computerTool } from '../computer.js';
import { unifiedUITool } from '../unified-ui.js';

// Canonical reasoning, planning, memory & cloud domain tools
import { kaiActionTool } from '../kai-action.js';
import { thinkTool } from '../think.js';
import { planTool } from '../plan.js';
import { memoryTool } from '../memory.js';
import { tasksTool } from '../tasks.js';
import { trackerTool, trackerTools } from '../tracker.js';
import { codingTool } from '../coding.js';
import { researchTool } from '../research.js';
import { skillsTool } from '../skills.js';
import { hanzoTool } from './hanzo.js';

// Absorbed tools kept as silent `tools/call` aliases & library exports (never advertised in `tools/list`)
import { gimpTool } from '../gimp.js';
import { codeIntelTools } from '../code-intel.js';
import {
  kaiTools,
  kaiAgentTools,
  kaiPurposeBuiltTools,
  kai8Tools,
  kaiDecideTool,
  kaiChoiceTool,
  kaiScoreTool,
  kaiNoulTool,
  kaiAgentStepTool,
  kaiToolSelectTool,
  kaiNextActionTool,
  kaiCommandGuardTool,
  kaiInjectionScreenTool,
  kaiExtractTool,
  kaiLogTriageTool,
  kaiRecoverTool,
} from '../kai.js';
import { kaiActionTools } from '../kai-action.js';
import { npxTool, uvxTool, jqTool } from '../packages.js';
import { llmTool } from '../llm.js';
import { modeTool } from '../mode-preset.js';
import { kaiCompactTool } from '../compact.js';
import { vaultTool } from '../vault.js';
import { connectorsTool } from '../connectors.js';
import { crmTool } from '../crm.js';
import { refactorTool } from '../refactor.js';
import { researchPlaneTools } from '../research-plane.js';

export const CANONICAL_TOOL_NAMES = [
  'fs',
  'exec',
  'code',
  'git',
  'fetch',
  'workspace',
  'browser',
  'computer',
  'ui',
  'kai',
  'think',
  'plan',
  'memory',
  'tasks',
  'tracker',
  'coding',
  'research',
  'skills',
  'hanzo',
] as const;

// Core local group (`--core-only`)
export const coreTools: Tool[] = [
  fsTool,
  execTool,
  codeTool,
  gitTool,
  fetchTool,
  workspaceTool,
  unifiedUITool,
];

// Extended canonical domain tools
export const optionalTools: Tool[] = [
  browserTool,
  computerTool,
  kaiActionTool,
  thinkTool,
  planTool,
  memoryTool,
  tasksTool,
  trackerTool,
  codingTool,
  researchTool,
  skillsTool,
  hanzoTool,
];

// The exact 19-tool canonical surface, ordered identically to Rust CANONICAL_TOOLS
export const allUnifiedTools: Tool[] = [
  fsTool,
  execTool,
  codeTool,
  gitTool,
  fetchTool,
  workspaceTool,
  browserTool,
  computerTool,
  unifiedUITool,
  kaiActionTool,
  thinkTool,
  planTool,
  memoryTool,
  tasksTool,
  trackerTool,
  codingTool,
  researchTool,
  skillsTool,
  hanzoTool,
];

// Silent `tools/call` dispatch aliases for backward compatibility (hidden from `tools/list`)
const webSearchAlias: Tool = {
  name: 'web_search',
  description: 'Silent alias -> fetch(action="search")',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, q: { type: 'string' } } },
  handler: (args: any) => fetchTool.handler({ ...args, action: 'search', query: args?.query ?? args?.q }),
};
const webReadAlias: Tool = {
  name: 'web_read',
  description: 'Silent alias -> fetch(action="read")',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  handler: (args: any) => fetchTool.handler({ ...args, action: 'read' }),
};
const visionAlias: Tool = {
  name: 'vision',
  description: 'Silent alias -> fetch(action="vision")',
  inputSchema: { type: 'object', properties: { image: { type: 'string' }, prompt: { type: 'string' } } },
  handler: (args: any) => fetchTool.handler({ ...args, action: 'vision' }),
};
const agentAlias: Tool = {
  name: 'agent',
  description: 'Silent alias -> think(action="agent")',
  inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
  handler: (args: any) => thinkTool.handler({ ...args, action: 'agent', task: args?.task ?? args?.prompt }),
};
const lspAlias: Tool = {
  name: 'lsp',
  description: 'Silent alias -> code(action="lsp")',
  inputSchema: { type: 'object', properties: { action: { type: 'string' }, file: { type: 'string' } } },
  handler: (args: any) => codeTool.handler({ ...args, action: 'lsp', lsp_action: args?.action || 'symbols' }),
};
const configAlias: Tool = {
  name: 'config',
  description: 'Silent alias -> workspace(action="config")',
  inputSchema: { type: 'object', properties: { action: { type: 'string' }, key: { type: 'string' } } },
  handler: (args: any) => workspaceTool.handler({ ...args, action: 'config', config_action: args?.action }),
};
const systemAlias: Tool = {
  name: 'system',
  description: 'Silent alias -> workspace(action="system")',
  inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
  handler: (args: any) => workspaceTool.handler({ ...args, action: 'system', sub_action: args?.action }),
};

export const legacyAliasTools: Tool[] = [
  ...kaiTools,
  ...kaiPurposeBuiltTools,
  ...kaiAgentTools,
  kaiCompactTool,
  ...trackerTools,
  ...codeIntelTools,
  ...researchPlaneTools,
  llmTool,
  agentAlias,
  modeTool,
  gimpTool,
  browserReadTool,
  cdpTool,
  npxTool,
  uvxTool,
  jqTool,
  vaultTool,
  connectorsTool,
  crmTool,
  refactorTool,
  lspAlias,
  configAlias,
  systemAlias,
  webSearchAlias,
  webReadAlias,
  visionAlias,
];

export const legacyToolAliasMap = new Map<string, Tool>(legacyAliasTools.map((t) => [t.name, t]));

// Re-exports
export { fsTool } from './fs.js';
export { execTool } from './exec.js';
export { codeTool } from './code.js';
export { fetchTool } from './fetch.js';
export { workspaceTool } from './workspace.js';
export { hanzoTool } from './hanzo.js';
export { computerTool, computerTools } from '../computer.js';
export { codingTool, codingTools } from '../coding.js';
export { researchTool, researchTools } from '../research.js';
export { skillsTool, skillsTools } from '../skills.js';
export { codeIntelTools, codeSearchTool, codeContextTool, codeAskTool, codeIndexTool } from '../code-intel.js';
export { trackerTool, trackerTools, trackerBoardsTool, trackerIssuesTool, trackerCreateTool, trackerUpdateTool } from '../tracker.js';
export {
  kaiTools,
  kaiDecideTool,
  kaiChoiceTool,
  kaiScoreTool,
  kaiNoulTool,
  kaiAgentStepTool,
  kaiAgentTools,
  kaiPurposeBuiltTools,
  kai8Tools,
  kaiToolSelectTool,
  kaiNextActionTool,
  kaiCommandGuardTool,
  kaiInjectionScreenTool,
  kaiExtractTool,
  kaiLogTriageTool,
  kaiRecoverTool,
} from '../kai.js';
export { kaiActionTool, kaiActionTools } from '../kai-action.js';
export { kaiCompactTool } from '../compact.js';
export { llmTools, llmTool } from '../llm.js';
export { browserTools, browserTool, browserReadTool, cdpTool, diagnoseBrowserError } from '../browser.js';
export { packageTools, npxTool, uvxTool, jqTool } from '../packages.js';
export { vaultTools, vaultTool } from '../vault.js';
export { connectorsTools, connectorsTool, CONNECTORS, COMPATIBLE_16_APPS } from '../connectors.js';
export { crmTools, crmTool, CRM_OBJECTS, CRM_ACTIONS, resolveCrmObject } from '../crm.js';
