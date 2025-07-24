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

// Export prompts
export { getSystemPrompt } from './prompts/system.js';

// Import Tool type for use in the function signature
import { Tool } from './types/index.js';

// Main server factory
export async function createMCPServer(config?: {
  name?: string;
  version?: string;
  projectPath?: string;
  customTools?: Tool[];
}) {
  const { 
    name = 'hanzo-mcp',
    version = '1.0.0',
    projectPath = process.cwd(),
    customTools = []
  } = config || {};
  
  // Import tools
  const { allTools, toolMap } = await import('./tools/index.js');
  
  // Combine built-in and custom tools
  const combinedTools = [...allTools, ...customTools];
  const combinedToolMap = new Map(combinedTools.map(t => [t.name, t]));
  
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
      tools: combinedTools.map(tool => ({
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
    tools: combinedTools,
    
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error(`${name} MCP server started with ${combinedTools.length} tools`);
    },
    
    addTool(tool: Tool) {
      combinedTools.push(tool);
      combinedToolMap.set(tool.name, tool);
    },
    
    removeTool(name: string) {
      const index = combinedTools.findIndex(t => t.name === name);
      if (index >= 0) {
        combinedTools.splice(index, 1);
        combinedToolMap.delete(name);
      }
    }
  };
}