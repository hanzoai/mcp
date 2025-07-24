/**
 * Tool registry for Hanzo MCP
 */

import { Tool } from '../types';
import { fileTools } from './file-ops';
import { searchTools } from './search';
import { shellTools } from './shell';
import { editTools } from './edit';

// Combine all tools
export const allTools: Tool[] = [
  ...fileTools,
  ...searchTools,
  ...shellTools,
  ...editTools
];

// Create a tool map for quick lookup
export const toolMap = new Map<string, Tool>(
  allTools.map(tool => [tool.name, tool])
);

// Export individual tool categories
export { fileTools } from './file-ops';
export { searchTools } from './search';
export { shellTools } from './shell';
export { editTools } from './edit';