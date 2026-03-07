/**
 * Central tool registry to avoid circular dependencies
 */

import { Tool } from '../types/index.js';

// Registry that will be populated by each tool module
export const toolRegistry = new Map<string, Tool>();

// Function to register a tool
export function registerTool(tool: Tool) {
  toolRegistry.set(tool.name, tool);
}

// Function to get all registered tools
export function getAllRegisteredTools(): Tool[] {
  return Array.from(toolRegistry.values());
}
