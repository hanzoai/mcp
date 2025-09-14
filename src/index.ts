/**
 * @hanzo/mcp - Model Context Protocol Server
 * 
 * A comprehensive MCP implementation with 20+ built-in tools for:
 * - File operations (read, write, edit, search)
 * - Shell execution (bash, background processes)
 * - Code intelligence (grep, AST-aware search)
 * - Project management (git, directory trees)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Export types
export * from './types/index.js';

// Export tools
export * from './tools/index.js';

// Export UI tools
export * from './ui/index.js';

// Export prompts
export { getSystemPrompt } from './prompts/system.js';

// Import Tool type and tool configuration for use in function signatures
import { Tool } from './types/index.js';
import { ToolConfig } from './tools/index.js';

// Main server factory
export async function createMCPServer(config?: {
  name?: string;
  version?: string;
  projectPath?: string;
  customTools?: Tool[];
  toolConfig?: ToolConfig;
}) {
  const { 
    name = 'hanzo-mcp',
    version = '1.0.0',
    projectPath = process.cwd(),
    customTools = [],
    toolConfig = { enableCore: true, enableUI: false }
  } = config || {};
  
  // Import tools
  const { getConfiguredTools } = await import('./tools/index.js');
  
  // Get configured tools based on toolConfig
  const configuredTools = getConfiguredTools({
    ...toolConfig,
    customTools: [...(toolConfig.customTools || []), ...customTools]
  });
  
  const combinedToolMap = new Map(configuredTools.map(t => [t.name, t]));
  
  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );
  
  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: configuredTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    };
  });
  
  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = combinedToolMap.get(request.params.name);
    
    if (!tool) {
      return {
        content: [{
          type: 'text',
          text: `Unknown tool: ${request.params.name}`
        }],
        isError: true
      };
    }
    
    try {
      const result = await tool.handler(request.params.arguments || {});
      return result;
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error executing ${tool.name}: ${error.message}`
        }],
        isError: true
      };
    }
  });
  
  return {
    server,
    tools: configuredTools,
    
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error(`${name} MCP server started with ${configuredTools.length} tools`);
    },
    
    addTool(tool: Tool) {
      configuredTools.push(tool);
      combinedToolMap.set(tool.name, tool);
    },
    
    removeTool(name: string) {
      const index = configuredTools.findIndex(t => t.name === name);
      if (index >= 0) {
        configuredTools.splice(index, 1);
        combinedToolMap.delete(name);
      }
    }
  };
}