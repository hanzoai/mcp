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
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
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
import { startZapServer } from './zap-server.js';

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
  
  // ── MCP method handlers (shared between MCP + ZAP for full parity) ────

  const listToolsHandler = async () => ({
    tools: configuredTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });

  const callToolHandler = async (params: { name: string; arguments?: Record<string, unknown> }) => {
    const tool = combinedToolMap.get(params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${params.name}` }],
        isError: true,
      };
    }
    try {
      return await tool.handler(params.arguments || {});
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error executing ${tool.name}: ${error.message}` }],
        isError: true,
      };
    }
  };

  const listResourcesHandler = async () => ({
    resources: [{
      uri: 'hanzo://system-prompt',
      name: 'System Prompt',
      mimeType: 'text/plain',
      description: 'Hanzo MCP system prompt and context',
    }],
  });

  const readResourceHandler = async (params: { uri: string }) => {
    if (params.uri === 'hanzo://system-prompt') {
      const { getSystemPrompt: getSysPrompt } = await import('./prompts/system.js');
      const systemPrompt = await getSysPrompt(projectPath);
      return {
        contents: [{ uri: params.uri, mimeType: 'text/plain', text: systemPrompt }],
      };
    }
    return {
      contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'Resource not found' }],
    };
  };

  // Method dispatch map — used by ZAP pass-through for full protocol parity
  const methodHandlers: Record<string, (params: any) => Promise<any>> = {
    'tools/list': listToolsHandler,
    'tools/call': (params: any) => callToolHandler(params),
    'resources/list': listResourcesHandler,
    'resources/read': (params: any) => readResourceHandler(params),
  };

  // Register with MCP server
  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, async (request) => callToolHandler(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, listResourcesHandler);
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResourceHandler(request.params));
  
  return {
    server,
    tools: configuredTools,
    
    async start() {
      // Start ZAP server for browser extension discovery
      // ZAP is a binary transport for MCP — full protocol parity via handleMethod pass-through
      const zapServer = await startZapServer({
        tools: configuredTools,
        name,
        callTool: async (toolName, args) => {
          const tool = combinedToolMap.get(toolName);
          if (!tool) throw new Error(`Unknown tool: ${toolName}`);
          return tool.handler(args);
        },
        // Pass-through for ALL MCP methods not handled by ZAP's built-in switch
        // This ensures resources/*, prompts/*, and any future methods work over ZAP
        handleMethod: async (method, params) => {
          const handler = methodHandlers[method];
          if (handler) return handler(params || {});
          throw new Error(`Unsupported method: ${method}`);
        },
      }).catch((err) => {
        console.error(`[ZAP] Failed to start: ${err.message}`);
        return null;
      });

      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error(`${name} MCP server started with ${configuredTools.length} tools`);
      if (zapServer) {
        console.error(`[ZAP] Browser extensions can discover this server on port ${zapServer.port}`);
      }
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