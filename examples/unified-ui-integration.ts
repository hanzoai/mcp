/**
 * Example: Integrating the Unified UI Tool
 * Shows how to replace multiple UI tools with the single unified tool
 */

import { unifiedUITool } from '../src/ui/unified-ui-tool.js';
import { MCPServerConfig } from '../src/types/index.js';

// Example 1: Basic MCP Server Configuration
export const mcpServerConfig: MCPServerConfig = {
  name: '@hanzo/mcp',
  version: '2.1.0',
  tools: [
    // Before: 14+ separate UI tools
    // Now: Just one unified tool
    unifiedUITool,
    // ... other tools
  ]
};

// Example 2: Using the unified tool programmatically
async function exampleUsage() {
  console.log('=== Unified UI Tool Examples ===\n');

  // Initialize a project
  const initResult = await unifiedUITool.handler({
    method: 'init',
    style: 'default'
  });
  console.log('1. Initialize:', initResult.content[0].text?.substring(0, 100) + '...\n');

  // List components
  const listResult = await unifiedUITool.handler({
    method: 'list_components',
    type: 'ui'
  });
  console.log('2. List Components:', listResult.content[0].text?.substring(0, 100) + '...\n');

  // Get component details
  const componentResult = await unifiedUITool.handler({
    method: 'get_component',
    name: 'button'
  });
  console.log('3. Get Component:', componentResult.content[0].text?.substring(0, 100) + '...\n');

  // Search for components
  const searchResult = await unifiedUITool.handler({
    method: 'search',
    query: 'form'
  });
  console.log('4. Search:', searchResult.content[0].text?.substring(0, 100) + '...\n');

  // Multi-framework support
  const vueResult = await unifiedUITool.handler({
    method: 'add_component',
    component: 'button',
    framework: 'vue'
  });
  console.log('5. Vue Component:', vueResult.content[0].text?.substring(0, 100) + '...\n');

  // Compare frameworks
  const compareResult = await unifiedUITool.handler({
    method: 'compare_frameworks',
    component: 'button'
  });
  console.log('6. Compare Frameworks:', compareResult.content[0].text?.substring(0, 100) + '...\n');
}

// Example 3: AI Assistant Usage Patterns
const aiAssistantExamples = {
  // Pattern 1: Simple component lookup
  getComponent: {
    method: 'get_component',
    name: 'dialog'
  },

  // Pattern 2: Framework-specific installation
  addVueComponent: {
    method: 'add_component',
    component: 'card',
    framework: 'vue',
    style: 'new-york'
  },

  // Pattern 3: Search and discover
  searchForms: {
    method: 'search',
    query: 'form input validation'
  },

  // Pattern 4: Framework migration
  convertComponent: {
    method: 'convert_framework',
    component: 'button',
    from: 'react',
    to: 'svelte'
  },

  // Pattern 5: List blocks for landing page
  listBlocks: {
    method: 'list_blocks',
    category: 'Landing'
  }
};

// Example 4: Method discovery for AI
function discoverMethods() {
  const methods = [
    'init',
    'list_components',
    'get_component',
    'get_source',
    'get_demo',
    'add_component',
    'list_blocks',
    'get_block',
    'list_styles',
    'search',
    'installation_guide',
    'compare_frameworks',
    'convert_framework'
  ];

  console.log('Available UI Methods:');
  methods.forEach(method => {
    console.log(`- ${method}`);
  });
}

// Example 5: Error handling
async function errorHandlingExample() {
  // Missing method
  const noMethod = await unifiedUITool.handler({});
  console.log('Error (no method):', noMethod.content[0].text);

  // Invalid method
  const invalidMethod = await unifiedUITool.handler({
    method: 'invalid_method' as any
  });
  console.log('Error (invalid method):', invalidMethod.content[0].text);

  // Missing required parameter
  const missingParam = await unifiedUITool.handler({
    method: 'get_component'
    // missing 'name' parameter
  });
  console.log('Result (missing param):', missingParam.content[0].text);
}

// Run examples if this file is executed directly
if (require.main === module) {
  exampleUsage().catch(console.error);
}