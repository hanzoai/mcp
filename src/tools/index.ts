/**
 * Tool registry for Hanzo MCP — HIP-0300 Unified Architecture
 *
 * Default: 7 core + optional tools (fs, exec, code, git, fetch, workspace, ui + think, llm, memory, hanzo, plan, tasks, mode)
 * Legacy: Individual tools (read, write, edit, bash, etc.) available via enableLegacy
 */

import { Tool } from '../types/index.js';
import { registerTool, getAllRegisteredTools } from './tool-registry.js';

// HIP-0300 unified tools
import { allUnifiedTools, coreTools as unifiedCoreTools, optionalTools } from './unified/index.js';
import { fsTool } from './unified/fs.js';
import { execTool } from './unified/exec.js';
import { codeTool } from './unified/code.js';
import { fetchTool } from './unified/fetch.js';
import { workspaceTool } from './unified/workspace.js';
import { hanzoTool } from './unified/hanzo.js';

// Individual tools (legacy, available for backwards compat)
import { fileTools } from './file-ops.js';
import { searchTools } from './search.js';
import { shellTools } from './shell.js';
import { editTools } from './edit.js';
import { thinkTools as aiTools } from './think.js';
import { astTools } from './ast-search.js';
import { vectorTools } from './vector-search.js';
import { tasksTools as todoTools } from './tasks.js';
import { modePresetTools } from './mode-preset.js';
import { hanzoCloudTools } from './hanzo-cloud.js';
import { gitTools as vcsTools } from './git.js';
import { refactorTools } from './refactor.js';
import { memoryTools } from './memory.js';
import { planTools } from './plan.js';

// UI tools
import { uiTools } from '../ui/ui-tools.js';
import { multiFrameworkTools } from '../ui/multi-framework-tools.js';
import { autoguiTools } from '../autogui/tools/autogui-tools.js';
import { orchestrationTools } from '../orchestration/agent-tools.js';
import HanzoDesktopTool from './hanzo-desktop.js';
import PlaywrightControlTool from './playwright-control.js';
import { unifiedUITool } from './unified-ui.js';
import { uiRegistryTools } from './ui-registry.js';
import { githubUITools } from './ui-github-api.js';

// Desktop automation tools
export const desktopTools: Tool[] = [
  new HanzoDesktopTool(),
  new PlaywrightControlTool()
];

// Legacy individual tools
export const legacyCoreTools: Tool[] = [
  ...fileTools,
  ...searchTools,
  ...shellTools,
  ...editTools
];

// HIP-0300 canonical surface (default)
export const coreTools = unifiedCoreTools;

// All tools — HIP-0300 unified surface
export const allTools: Tool[] = allUnifiedTools;

// Register all tools
allTools.forEach(tool => registerTool(tool));

// Tool maps
export const coreToolMap = new Map<string, Tool>(coreTools.map(tool => [tool.name, tool]));
export const toolMap = new Map<string, Tool>(allTools.map(tool => [tool.name, tool]));

// Re-export unified tools
export { fsTool, execTool, codeTool, fetchTool, workspaceTool, hanzoTool };
export { allUnifiedTools, optionalTools } from './unified/index.js';

// Re-export legacy tools (for backwards compat imports)
export { fileTools } from './file-ops.js';
export { searchTools } from './search.js';
export { shellTools } from './shell.js';
export { editTools } from './edit.js';
export { thinkTools as aiTools, thinkTools } from './think.js';
export { astTools } from './ast-search.js';
export { vectorTools } from './vector-search.js';
export { tasksTools as todoTools, tasksTools } from './tasks.js';
export { modePresetTools, modeUtils } from './mode-preset.js';
export { hanzoCloudTools, iamTools, kmsTools, paasTools, billingTools, billingTool, commerceTools, storageTools, authTools, apiTools } from './hanzo-cloud.js';
export { gitTools as vcsTools } from './git.js';
export { refactorTools } from './refactor.js';
export { memoryTools } from './memory.js';
export { planTools } from './plan.js';
export { uiTools } from '../ui/ui-tools.js';
export { autoguiTools } from '../autogui/tools/autogui-tools.js';
export { orchestrationTools } from '../orchestration/agent-tools.js';
export { uiRegistryTools } from './ui-registry.js';
export { githubUITools } from './ui-github-api.js';
export { registerTool, getAllRegisteredTools } from './tool-registry.js';

// Tool configuration
export interface ToolConfig {
  /** Use HIP-0300 unified tools (default: true) */
  unified?: boolean;
  /** Enable legacy individual tools instead */
  enableLegacy?: boolean;
  enableCore?: boolean;
  enableAI?: boolean;
  enableAST?: boolean;
  enableVector?: boolean;
  enableTodo?: boolean;
  enableModes?: boolean;
  enableCloud?: boolean;
  enableVCS?: boolean;
  enableRefactor?: boolean;
  enableMemory?: boolean;
  enablePlan?: boolean;
  enableUI?: boolean;
  enableAutoGUI?: boolean;
  enableOrchestration?: boolean;
  enableUIRegistry?: boolean;
  enableGitHubUI?: boolean;
  enableDesktop?: boolean;
  dedupeTools?: boolean;
  enabledCategories?: string[];
  disabledTools?: string[];
  customTools?: Tool[];
}

function dedupeByName(tools: Tool[]): Tool[] {
  const seen = new Set<string>();
  return tools.filter(t => { if (seen.has(t.name)) return false; seen.add(t.name); return true; });
}

/**
 * Get tools based on configuration.
 * Default: HIP-0300 unified surface (fs, exec, code, git, fetch, workspace, ui, think, llm, memory, hanzo, plan, tasks, mode)
 */
export function getConfiguredTools(config: ToolConfig = {}): Tool[] {
  const {
    unified = true,
    enableLegacy = false,
    enableUI = false,
    enableAutoGUI = false,
    enableOrchestration = false,
    enableUIRegistry = false,
    enableGitHubUI = false,
    enableDesktop = false,
    dedupeTools = true,
    disabledTools = [],
    customTools = []
  } = config;

  let tools: Tool[];

  if (unified && !enableLegacy) {
    // HIP-0300 canonical surface
    tools = [...allUnifiedTools];
  } else {
    // Legacy individual tools
    const {
      enableCore = true,
      enableAI = true,
      enableAST = true,
      enableVector = true,
      enableTodo = true,
      enableModes = true,
      enableCloud = true,
      enableVCS = true,
      enableRefactor = true,
      enableMemory = true,
      enablePlan = true,
      enabledCategories = [],
    } = config;

    tools = [];
    if (enableCore) {
      if (enabledCategories.length > 0) {
        if (enabledCategories.includes('files')) tools.push(...fileTools);
        if (enabledCategories.includes('search')) tools.push(...searchTools);
        if (enabledCategories.includes('shell')) tools.push(...shellTools);
        if (enabledCategories.includes('edit')) tools.push(...editTools);
        if (enabledCategories.includes('desktop')) tools.push(...desktopTools);
      } else {
        tools.push(...legacyCoreTools);
      }
    }
    if (enableAI) tools.push(...aiTools);
    if (enableAST) tools.push(...astTools);
    if (enableVector) tools.push(...vectorTools);
    if (enableTodo) tools.push(...todoTools);
    if (enableModes) tools.push(...modePresetTools);
    if (enableCloud) tools.push(...hanzoCloudTools);
    if (enableVCS) tools.push(...vcsTools);
    if (enableRefactor) tools.push(...refactorTools);
    if (enableMemory) tools.push(...memoryTools);
    if (enablePlan) tools.push(...planTools);
  }

  // UI extensions
  if (enableUI) { tools.push(...uiTools, ...multiFrameworkTools); }
  if (enableAutoGUI) tools.push(...autoguiTools);
  if (enableOrchestration) tools.push(...orchestrationTools);
  if (enableUIRegistry) tools.push(...uiRegistryTools);
  if (enableGitHubUI) tools.push(...githubUITools);
  if (enableDesktop) tools.push(...desktopTools);

  // Custom tools
  tools.push(...customTools);

  if (dedupeTools) tools = dedupeByName(tools);
  if (disabledTools.length > 0) tools = tools.filter(t => !disabledTools.includes(t.name));

  return tools;
}
