#!/usr/bin/env node

/**
 * Hanzo MCP CLI
 * Model Context Protocol server for AI development tools
 */

import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import our tools
import { allTools, toolMap } from './tools/index.js';
import { getSystemPrompt } from './prompts/system.js';

// Version from package.json
const packageJson = JSON.parse(
  await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf-8')
);

const program = new Command();

program
  .name('hanzo-mcp')
  .description('Hanzo MCP Server - Model Context Protocol tools for AI development')
  .version(packageJson.version);

program
  .command('serve')
  .description('Start the MCP server')
  .option('-t, --transport <type>', 'Transport type (stdio, http)', 'stdio')
  .option('-p, --port <port>', 'Port for HTTP transport', '3000')
  .option('--project <path>', 'Project path for context', process.cwd())
  .action(async (options) => {
    console.error(`Starting Hanzo MCP server v${packageJson.version}...`);
    console.error(`Loaded ${allTools.length} tools`);
    
    if (options.transport === 'stdio') {
      await startStdioServer(options);
    } else {
      console.error('HTTP transport not yet implemented');
      process.exit(1);
    }
  });

program
  .command('list-tools')
  .description('List available MCP tools')
  .action(async () => {
    console.log(`\nHanzo MCP Tools (${allTools.length} total):\n`);
    
    // Group tools by category
    const categories = {
      'File Operations': ['read_file', 'write_file', 'list_files', 'create_file', 'delete_file', 'move_file', 'get_file_info', 'directory_tree'],
      'Search': ['grep', 'find_files', 'search'],
      'Editing': ['edit_file', 'multi_edit'],
      'Shell': ['bash', 'run_command', 'run_background', 'list_processes', 'get_process_output', 'kill_process']
    };
    
    for (const [category, toolNames] of Object.entries(categories)) {
      console.log(`${category}:`);
      for (const toolName of toolNames) {
        const tool = toolMap.get(toolName);
        if (tool) {
          console.log(`  - ${tool.name}: ${tool.description}`);
        }
      }
      console.log();
    }
  });

program
  .command('install-desktop')
  .description('Install MCP server for Claude Desktop')
  .action(async () => {
    console.log('Installing Hanzo MCP for Claude Desktop...');
    
    const configDir = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Claude');
    const configFile = path.join(configDir, 'claude_desktop_config.json');
    
    try {
      // Ensure config directory exists
      await fs.mkdir(configDir, { recursive: true });
      
      // Read existing config or create new one
      let config: any = {};
      try {
        const configContent = await fs.readFile(configFile, 'utf-8');
        config = JSON.parse(configContent);
      } catch {
        // Config doesn't exist yet
      }
      
      // Add our MCP server
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      
      config.mcpServers['hanzo-mcp'] = {
        command: 'npx',
        args: ['-y', '@hanzo/mcp', 'serve'],
        env: {}
      };
      
      // Write config
      await fs.writeFile(configFile, JSON.stringify(config, null, 2));
      
      console.log('✓ Successfully installed Hanzo MCP for Claude Desktop');
      console.log(`✓ Configuration saved to: ${configFile}`);
      console.log('\nRestart Claude Desktop to use Hanzo MCP tools.');
    } catch (error: any) {
      console.error(`Error installing: ${error.message}`);
      process.exit(1);
    }
  });

async function startStdioServer(options: any) {
  const server = new Server(
    {
      name: 'hanzo-mcp',
      version: packageJson.version,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // Register all tools
  console.error(`Registering ${allTools.length} tools...`);

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    
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
      console.error(`Executing tool: ${tool.name}`);
      const result = await tool.handler(request.params.arguments || {});
      return result;
    } catch (error: any) {
      console.error(`Tool error: ${error.message}`);
      return {
        content: [{
          type: 'text',
          text: `Error executing ${tool.name}: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // Handle resources (for system prompt)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [{
        uri: 'hanzo://system-prompt',
        name: 'System Prompt',
        mimeType: 'text/plain',
        description: 'Hanzo MCP system prompt and context'
      }]
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'hanzo://system-prompt') {
      const systemPrompt = await getSystemPrompt(options.project);
      return {
        contents: [{
          uri: request.params.uri,
          mimeType: 'text/plain',
          text: systemPrompt
        }]
      };
    }
    
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: 'text/plain',
        text: 'Resource not found'
      }]
    };
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Hanzo MCP server started successfully');
}

// Parse command line arguments
program.parse();