/**
 * Hanzo UI MCP module exports - Unified version
 * This replaces the multiple tool exports with a single unified UI tool
 */

// Keep existing type and API exports for backward compatibility
export * from './registry-types.js';
export * from './registry-api.js';

// Export the unified tool
export { unifiedUITool, default as uiTool } from './unified-ui-tool.js';

// For backward compatibility, we can optionally export a tools array with just the unified tool
export const uiTools = [unifiedUITool];

// Note: The old multi-tool exports are deprecated in favor of the unified tool
// To migrate:
// 1. Update imports from './ui/index.js' to './ui/index-unified.js'
// 2. Replace multiple tool registrations with just the unified tool
// 3. AI assistants will automatically use the method parameter