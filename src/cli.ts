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
import { getConfiguredTools, ToolConfig } from './tools/index.js';
import { getSystemPrompt } from './prompts/system.js';

// Version from package.json
const packageJson = JSON.parse(
  await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf-8')
);

const program = new Command();

program
  .name('hanzo-mcp')
  .description('Hanzo MCP Server - Model Context Protocol tools for AI development')
  .version(packageJson.version)
  .option('--version', 'Display version number')
  .action((options) => {
    // Default action when no command is specified
    if (options.version) {
      console.log(packageJson.version);
      process.exit(0);
    }
    // If no options, show help
    program.outputHelp();
  });

program
  .command('serve', { isDefault: true })
  .description('Start the MCP server')
  .option('-t, --transport <type>', 'Transport type (stdio, http)', 'stdio')
  .option('-p, --port <port>', 'Port for HTTP transport', '3000')
  .option('--project <path>', 'Project path for context', process.cwd())
  .option('--disable-ui', 'Disable UI tools for component development')
  .option('--disable-autogui', 'Disable AutoGUI tools for computer control')
  .option('--disable-orchestration', 'Disable orchestration tools for agent management')
  .option('--core-only', 'Enable only core tools (files, search, shell, edit)')
  .option('--disable-tools <tools>', 'Comma-separated list of tools to disable')
  .option('--enable-categories <categories>', 'Comma-separated list of categories to enable (files,search,shell,edit)')
  .action(async (options) => {
    // Configure tools based on options
    const toolConfig: ToolConfig = {
      enableCore: !options.coreOnly || options.enableCategories,
      enableUI: options.coreOnly ? false : !options.disableUi,  // Enable by default unless disabled
      enableAutoGUI: options.coreOnly ? false : !options.disableAutogui,  // Enable by default unless disabled
      enableOrchestration: options.coreOnly ? false : !options.disableOrchestration,  // Enable by default
      enabledCategories: options.enableCategories ? options.enableCategories.split(',') : [],
      disabledTools: options.disableTools ? options.disableTools.split(',') : []
    };

    const tools = getConfiguredTools(toolConfig);
    
    console.error(`Starting Hanzo MCP server v${packageJson.version}...`);
    console.error(`Loaded ${tools.length} tools`);
    if (toolConfig.enableUI) {
      console.error('UI tools enabled');
    }
    if (toolConfig.enableAutoGUI) {
      console.error('AutoGUI tools enabled');
    }
    if (toolConfig.enableOrchestration) {
      console.error('Orchestration tools enabled');
    }
    
    if (options.transport === 'stdio') {
      await startStdioServer(options, toolConfig);
    } else {
      console.error('HTTP transport not yet implemented');
      process.exit(1);
    }
  });

program
  .command('list-tools')
  .description('List available MCP tools')
  .option('--disable-ui', 'Exclude UI tools from listing')
  .option('--disable-autogui', 'Exclude AutoGUI tools from listing')
  .option('--disable-orchestration', 'Exclude orchestration tools from listing')
  .option('--core-only', 'Show only core tools')
  .option('--category <category>', 'Filter by category (files, search, shell, edit, ui, autogui)')
  .action(async (options) => {
    // Configure tools based on options
    const toolConfig: ToolConfig = {
      enableCore: true,
      enableUI: options.coreOnly ? false : !options.disableUi,  // Enable by default
      enableAutoGUI: options.coreOnly ? false : !options.disableAutogui,  // Enable by default
      enableOrchestration: options.coreOnly ? false : !options.disableOrchestration,  // Enable by default
    };

    const tools = getConfiguredTools(toolConfig);
    const toolMap = new Map(tools.map(t => [t.name, t]));
    
    console.log(`\nHanzo MCP Tools (${tools.length} total):\n`);
    
    // Group tools by category
    const categories: Record<string, string[]> = {
      'File Operations': ['read_file', 'write_file', 'list_files', 'create_file', 'delete_file', 'move_file', 'get_file_info', 'directory_tree'],
      'Search': ['grep', 'find_files', 'search'],
      'Editing': ['edit_file', 'multi_edit'],
      'Shell': ['bash', 'run_command', 'run_background', 'list_processes', 'get_process_output', 'kill_process']
    };
    
    // Add UI tools category if enabled
    if (toolConfig.enableUI) {
      categories['UI Tools'] = [
        'ui_init', 'ui_list_components', 'ui_get_component', 'ui_get_component_source',
        'ui_get_component_demo', 'ui_add_component', 'ui_list_blocks', 'ui_get_block',
        'ui_list_styles', 'ui_search_registry', 'ui_get_installation_guide'
      ];
    }
    
    // Add AutoGUI tools category if enabled
    if (toolConfig.enableAutoGUI) {
      categories['AutoGUI Tools'] = [
        'autogui_status', 'autogui_configure', 'autogui_get_screen_size', 'autogui_get_screens',
        'autogui_get_mouse_position', 'autogui_move_mouse', 'autogui_click', 'autogui_drag', 'autogui_scroll',
        'autogui_type', 'autogui_press_key', 'autogui_hotkey', 'autogui_screenshot', 'autogui_get_pixel',
        'autogui_locate_image', 'autogui_get_windows', 'autogui_control_window', 'autogui_sleep'
      ];
    }
    
    // Add Orchestration tools category if enabled
    if (toolConfig.enableOrchestration) {
      categories['Orchestration Tools'] = [
        'spawn_agent', 'swarm_orchestration', 'critic_agent',
        'hanzo_node', 'llm_router', 'consensus'
      ];
    }
    
    // Filter by category if specified
    const categoriesToShow = options.category 
      ? Object.entries(categories).filter(([cat]) => cat.toLowerCase().includes(options.category.toLowerCase()))
      : Object.entries(categories);
    
    for (const [category, toolNames] of categoriesToShow) {
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

async function startStdioServer(options: any, toolConfig: ToolConfig) {
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

  // Get configured tools
  const configuredTools = getConfiguredTools(toolConfig);
  const toolMap = new Map(configuredTools.map(t => [t.name, t]));
  
  // Register all tools
  console.error(`Registering ${configuredTools.length} tools...`);

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