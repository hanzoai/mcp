/**
 * Tool registry for Hanzo MCP
 */

import { Tool } from '../types';
import { fileTools } from './file-ops';
import { searchTools } from './search';
import { shellTools } from './shell';
import { editTools } from './edit';
import { uiTools } from '../ui/ui-tools.js';
import { multiFrameworkTools } from '../ui/multi-framework-tools.js';
import { autoguiTools } from '../autogui/tools/autogui-tools.js';
import { orchestrationTools } from '../orchestration/agent-tools.js';
import { searchTools as unifiedSearchTools } from '../search/unified-search.js';
import { searchTools as standardSearchTools } from '../search/index.js';
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

// Core tool categories
export const coreTools: Tool[] = [
  ...fileTools,
  ...searchTools,
  ...shellTools,
  ...editTools
];

// All tools including unified UI, AutoGUI, Orchestration, Desktop, and standard search tools
export const allTools: Tool[] = [
  ...coreTools,
  unifiedUITool,  // Single unified UI tool replaces all separate UI tools
  ...autoguiTools,
  ...orchestrationTools,
  ...desktopTools,
  ...standardSearchTools
];

// Create tool maps for quick lookup
export const coreToolMap = new Map<string, Tool>(
  coreTools.map(tool => [tool.name, tool])
);

export const toolMap = new Map<string, Tool>(
  allTools.map(tool => [tool.name, tool])
);

// Export tool categories
export { fileTools } from './file-ops';
export { searchTools } from './search';
export { shellTools } from './shell';
export { editTools } from './edit';
export { uiTools } from '../ui/ui-tools.js';
export { autoguiTools } from '../autogui/tools/autogui-tools.js';
export { orchestrationTools } from '../orchestration/agent-tools.js';
export { uiRegistryTools } from './ui-registry.js';
export { githubUITools } from './ui-github-api.js';

// Tool configuration interface
export interface ToolConfig {
  enableCore?: boolean;
  enableUI?: boolean;
  enableAutoGUI?: boolean;
  enableOrchestration?: boolean;
  enableUIRegistry?: boolean;
  enableGitHubUI?: boolean;
  enabledCategories?: string[];
  disabledTools?: string[];
  customTools?: Tool[];
}

/**
 * Get tools based on configuration
 */
export function getConfiguredTools(config: ToolConfig = {}): Tool[] {
  const {
    enableCore = true,
    enableUI = false,
    enableAutoGUI = false,
    enableOrchestration = true,  // Enable by default for agent capabilities
    enableUIRegistry = true,     // Enable by default for UI development
    enableGitHubUI = true,        // Enable by default for GitHub UI fetching
    enabledCategories = [],
    disabledTools = [],
    customTools = []
  } = config;

  let tools: Tool[] = [];

  // Add core tools if enabled
  if (enableCore) {
    if (enabledCategories.length > 0) {
      // Only include specified categories
      if (enabledCategories.includes('files')) tools.push(...fileTools);
      if (enabledCategories.includes('search')) tools.push(...searchTools);
      if (enabledCategories.includes('shell')) tools.push(...shellTools);
      if (enabledCategories.includes('edit')) tools.push(...editTools);
    } else {
      // Include all core tools
      tools.push(...coreTools);
    }
  }

  // Add UI tools if enabled
  if (enableUI) {
    tools.push(...uiTools);
    tools.push(...multiFrameworkTools);
  }

  // Add AutoGUI tools if enabled
  if (enableAutoGUI) {
    tools.push(...autoguiTools);
  }

  // Add Orchestration tools if enabled
  if (enableOrchestration) {
    tools.push(...orchestrationTools);
  }

  // Add UI Registry tools if enabled
  if (enableUIRegistry) {
    tools.push(...uiRegistryTools);
  }

  // Add GitHub UI tools if enabled
  if (enableGitHubUI) {
    tools.push(...githubUITools);
  }

  // Add custom tools
  tools.push(...customTools);

  // Filter out disabled tools
  if (disabledTools.length > 0) {
    tools = tools.filter(tool => !disabledTools.includes(tool.name));
  }

  return tools;
}