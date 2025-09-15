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
  .version(packageJson.version);

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
  .command('install')
  .description('Install MCP server for various applications')
  .option('--claude-desktop', 'Install for Claude Desktop')
  .option('--claude-code', 'Install for Claude Code')
  .option('--gemini', 'Install for Google Gemini')
  .option('--codex', 'Install for OpenAI Codex')
  .option('--cursor', 'Install for Cursor IDE')
  .option('--windsurf', 'Install for Windsurf IDE')
  .option('--vscode', 'Install for VS Code')
  .option('--jetbrains', 'Install for JetBrains IDEs (IntelliJ, WebStorm, etc.)')
  .option('--all', 'Install for all supported applications')
  .action(async (options) => {
    const installations: Array<{ name: string; install: () => Promise<void> }> = [];
    
    // Helper function to install for Claude Desktop
    const installClaudeDesktop = async () => {
      console.log('📦 Installing for Claude Desktop...');
      const configDir = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Claude');
      const configFile = path.join(configDir, 'claude_desktop_config.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
        
        config.mcpServers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ Claude Desktop configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Claude Desktop installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for Claude Code
    const installClaudeCode = async () => {
      console.log('📦 Installing for Claude Code...');
      const configDir = path.join(process.env.HOME || '', '.config', 'claude-code');
      const configFile = path.join(configDir, 'mcp.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.servers) {
          config.servers = {};
        }
        
        config.servers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ Claude Code configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Claude Code installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for Cursor
    const installCursor = async () => {
      console.log('📦 Installing for Cursor IDE...');
      const configDir = path.join(process.env.HOME || '', '.cursor', 'mcp');
      const configFile = path.join(configDir, 'config.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.servers) {
          config.servers = {};
        }
        
        config.servers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ Cursor configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Cursor installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for VS Code
    const installVSCode = async () => {
      console.log('📦 Installing for VS Code...');
      const configDir = path.join(process.env.HOME || '', '.vscode', 'mcp');
      const configFile = path.join(configDir, 'servers.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.servers) {
          config.servers = {};
        }
        
        config.servers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ VS Code configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ VS Code installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for Gemini
    const installGemini = async () => {
      console.log('📦 Installing for Google Gemini...');
      const configDir = path.join(process.env.HOME || '', '.gemini', 'mcp');
      const configFile = path.join(configDir, 'servers.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.servers) {
          config.servers = {};
        }
        
        config.servers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ Gemini configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Gemini installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for Codex
    const installCodex = async () => {
      console.log('📦 Installing for OpenAI Codex...');
      const configDir = path.join(process.env.HOME || '', '.openai', 'codex', 'mcp');
      const configFile = path.join(configDir, 'config.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.servers) {
          config.servers = {};
        }
        
        config.servers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ Codex configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Codex installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for Windsurf
    const installWindsurf = async () => {
      console.log('📦 Installing for Windsurf IDE...');
      const configDir = path.join(process.env.HOME || '', '.windsurf', 'mcp');
      const configFile = path.join(configDir, 'config.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.servers) {
          config.servers = {};
        }
        
        config.servers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ Windsurf configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Windsurf installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for JetBrains IDEs
    const installJetBrains = async () => {
      console.log('📦 Installing for JetBrains IDEs...');
      // JetBrains uses a common config location for all their IDEs
      const configDir = path.join(process.env.HOME || '', '.jetbrains', 'mcp');
      const configFile = path.join(configDir, 'servers.json');
      
      try {
        await fs.mkdir(configDir, { recursive: true });
        let config: any = {};
        try {
          const configContent = await fs.readFile(configFile, 'utf-8');
          config = JSON.parse(configContent);
        } catch {
          // Config doesn't exist yet
        }
        
        if (!config.servers) {
          config.servers = {};
        }
        
        config.servers['hanzo-mcp'] = {
          command: 'npx',
          args: ['-y', '@hanzo/mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ JetBrains IDEs configured: ${configFile}`);
        console.log('  (Works with IntelliJ IDEA, WebStorm, PyCharm, etc.)');
      } catch (error: any) {
        console.error(`✗ JetBrains installation failed: ${error.message}`);
      }
    };
    
    // Determine what to install
    if (options.all) {
      installations.push(
        { name: 'Claude Desktop', install: installClaudeDesktop },
        { name: 'Claude Code', install: installClaudeCode },
        { name: 'Gemini', install: installGemini },
        { name: 'Codex', install: installCodex },
        { name: 'Cursor', install: installCursor },
        { name: 'Windsurf', install: installWindsurf },
        { name: 'VS Code', install: installVSCode },
        { name: 'JetBrains IDEs', install: installJetBrains }
      );
    } else {
      if (options.claudeDesktop) {
        installations.push({ name: 'Claude Desktop', install: installClaudeDesktop });
      }
      if (options.claudeCode) {
        installations.push({ name: 'Claude Code', install: installClaudeCode });
      }
      if (options.gemini) {
        installations.push({ name: 'Gemini', install: installGemini });
      }
      if (options.codex) {
        installations.push({ name: 'Codex', install: installCodex });
      }
      if (options.cursor) {
        installations.push({ name: 'Cursor', install: installCursor });
      }
      if (options.windsurf) {
        installations.push({ name: 'Windsurf', install: installWindsurf });
      }
      if (options.vscode) {
        installations.push({ name: 'VS Code', install: installVSCode });
      }
      if (options.jetbrains) {
        installations.push({ name: 'JetBrains IDEs', install: installJetBrains });
      }
    }
    
    if (installations.length === 0) {
      console.log('No installation target specified. Use one of:');
      console.log('\n📱 AI Assistants:');
      console.log('  --claude-desktop  Install for Claude Desktop');
      console.log('  --claude-code     Install for Claude Code');
      console.log('  --gemini          Install for Google Gemini');
      console.log('  --codex           Install for OpenAI Codex');
      console.log('\n💻 IDEs & Editors:');
      console.log('  --cursor          Install for Cursor IDE');
      console.log('  --windsurf        Install for Windsurf IDE');
      console.log('  --vscode          Install for VS Code');
      console.log('  --jetbrains       Install for JetBrains IDEs (IntelliJ, WebStorm, etc.)');
      console.log('\n🎯 Quick Options:');
      console.log('  --all             Install for all supported applications');
      process.exit(1);
    }
    
    console.log(`\n🚀 Installing Hanzo MCP v${packageJson.version}...\n`);
    
    // Run all installations
    for (const { name, install } of installations) {
      await install();
    }
    
    console.log('\n✅ Installation complete!');
    console.log('Restart the respective applications to use Hanzo MCP tools.');
  });

// Keep the legacy command for backward compatibility
program
  .command('install-desktop')
  .description('Install MCP server for Claude Desktop (deprecated, use "install --claude-desktop")')
  .action(async () => {
    console.log('Note: This command is deprecated. Use "hanzo-mcp install --claude-desktop" instead.\n');
    // Call the new install command with claude-desktop flag
    await program.parseAsync(['node', 'cli', 'install', '--claude-desktop'], { from: 'user' });
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