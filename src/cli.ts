#!/usr/bin/env node

/**
 * Hanzo MCP CLI
 * Model Context Protocol server for AI development tools
 */

import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs/promises';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import our tools
import {
  getConfiguredTools, ToolConfig, coreTools, optionalTools, codeIntelTools, trackerTools, uiTools,
  autoguiTools, orchestrationTools, uiRegistryTools, githubUITools, desktopTools, cryptuonCommunityTools,
} from './tools/index.js';
import { Tool } from './types/index.js';
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
  .option('--full-surface', 'Enable full legacy tool surface (multi-word aliases and optional categories)')
  .option('--enable-ui', 'Enable UI tools')
  .option('--enable-autogui', 'Enable AutoGUI tools')
  .option('--enable-orchestration', 'Enable orchestration tools')
  .option('--enable-ui-registry', 'Enable UI registry tools')
  .option('--enable-github-ui', 'Enable GitHub UI tools')
  .option('--enable-desktop', 'Enable desktop/playwright tools')
  .option('--enable-community-cryptuon', 'Enable cryptuon community tools (tesseract.deploy/health_check/monitor, compress.solana)')
  .option('--disable-ui', 'Disable UI tools for component development')
  .option('--disable-autogui', 'Disable AutoGUI tools for computer control')
  .option('--disable-orchestration', 'Disable orchestration tools for agent management')
  .option('--core-only', 'Offer only the core tools: fs, exec, code, git, fetch, workspace, ui')
  .option('--disable-tools <tools>', 'Comma-separated list of tools to disable')
  .option('--enable-categories <categories>', 'Comma-separated list of categories to enable (files,search,shell,edit)')
  .action(async (options) => {
    const toolConfig = surface(options);
    const tools = getConfiguredTools(toolConfig);

    // Diagnostic preamble. Always-on (stderr only; doesn't pollute JSON-RPC
    // on stdout). Lets users hand a log to support when MCP "doesn't work":
    // emits node version, platform, package version, and (if HANZO_MCP_DEBUG=1)
    // a one-time dump of the cwd, the resolved cli path, and PATH so we can
    // tell whether a stray `serve` binary or a wrong `npx` invocation is
    // shadowing our entrypoint.
    console.error(`Starting Hanzo MCP server v${packageJson.version}...`);
    console.error(`node ${process.version} on ${process.platform}-${process.arch}`);
    console.error(`Loaded ${tools.length} tools`);
    if (process.env.HANZO_MCP_DEBUG === '1') {
      console.error(`[debug] cwd=${process.cwd()}`);
      console.error(`[debug] cli=${process.argv[1]}`);
      console.error(`[debug] argv=${JSON.stringify(process.argv.slice(2))}`);
      const path = process.env.PATH ?? '';
      const head = path.split(process.platform === 'win32' ? ';' : ':').slice(0, 6).join(process.platform === 'win32' ? ';' : ':');
      console.error(`[debug] PATH[0:6]=${head}`);
    }
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
    } else if (options.transport === 'http') {
      await startHttpServer(options, toolConfig);
    } else {
      console.error(`Unknown transport: ${options.transport} (use stdio or http)`);
      process.exit(1);
    }
  });

program
  .command('list-tools')
  .description('List available MCP tools')
  .option('--full-surface', 'Enable full legacy tool surface (multi-word aliases and optional categories)')
  .option('--enable-ui', 'Include UI tools')
  .option('--enable-autogui', 'Include AutoGUI tools')
  .option('--enable-orchestration', 'Include orchestration tools')
  .option('--enable-ui-registry', 'Include UI registry tools')
  .option('--enable-github-ui', 'Include GitHub UI tools')
  .option('--enable-desktop', 'Include desktop/playwright tools')
  .option('--enable-community-cryptuon', 'Include cryptuon community tools')
  .option('--disable-ui', 'Exclude UI tools from listing')
  .option('--disable-autogui', 'Exclude AutoGUI tools from listing')
  .option('--disable-orchestration', 'Exclude orchestration tools from listing')
  .option('--core-only', 'List only the core tools')
  .option('--category <group>', 'List one group: core, optional, code intelligence, tracker, ui, autogui, orchestration, ui registry, github ui, desktop, community, other')
  .action(async (options) => {
    const tools = getConfiguredTools(surface(options));
    const left = new Map(tools.map(t => [t.name, t]));
    // The groups README.md names, then the sets the flags add. A tool in none of
    // them is listed under `other`, so every tool the server offers is printed.
    const sets: Array<[string, Tool[]]> = [
      ['core', coreTools],
      ['optional', optionalTools],
      ['code intelligence', codeIntelTools],
      ['tracker', trackerTools],
      ['ui', uiTools],
      ['autogui', autoguiTools],
      ['orchestration', orchestrationTools],
      ['ui registry', uiRegistryTools],
      ['github ui', githubUITools],
      ['desktop', desktopTools],
      ['community', cryptuonCommunityTools],
    ];
    const groups = sets.map(([group, set]): [string, Tool[]] => [group, set.filter(t => left.delete(t.name))]);
    groups.push(['other', [...left.values()]]);
    const wanted = options.category?.toLowerCase();

    console.log(`\nHanzo MCP Tools (${tools.length} total):\n`);
    for (const [group, members] of groups) {
      if (!members.length || (wanted && !group.includes(wanted))) continue;
      console.log(`${group}:`);
      for (const tool of members) console.log(`  - ${tool.name}: ${tool.description.split('\n')[0]}`);
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
      const configDir = process.platform === 'win32'
        ? path.join(process.env.APPDATA || os.homedir(), 'Claude')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
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
          args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
          env: {}
        };
        
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log(`✓ Claude Desktop configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Claude Desktop installation failed: ${error.message}`);
      }
    };
    
    // Helper function to install for Claude Code. Claude Code reads the servers
    // `claude mcp add` registered, not a file written beside its config.
    const installClaudeCode = async () => {
      console.log('📦 Installing for Claude Code...');
      const args = ['mcp', 'add', '--scope', 'user', 'hanzo', '--', 'npx', '-y', '@hanzo/mcp', 'serve'];
      const run = spawnSync('claude', args, { stdio: 'inherit' });
      if (run.error || run.status !== 0) {
        const why = run.error ? `did not run: ${run.error.message}` : `exited ${run.status}`;
        console.error(`✗ Claude Code: claude ${args.join(' ')} ${why}`);
        return;
      }
      console.log('✓ Claude Code configured for every project (claude mcp list shows hanzo)');
    };
    
    // Helper function to install for Cursor
    const installCursor = async () => {
      console.log('📦 Installing for Cursor IDE...');
      const configDir = path.join(os.homedir(), '.cursor', 'mcp');
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
          args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
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
      const configDir = path.join(os.homedir(), '.vscode', 'mcp');
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
          args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
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
      const configDir = path.join(os.homedir(), '.gemini', 'mcp');
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
          args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
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
      const configDir = path.join(os.homedir(), '.openai', 'codex', 'mcp');
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
          args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
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
      const configDir = path.join(os.homedir(), '.windsurf', 'mcp');
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
          args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
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
      const configDir = path.join(os.homedir(), '.jetbrains', 'mcp');
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
          args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
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

// The tool set the surface flags select. serve and list-tools take the same
// flags, and both read them here.
function surface(options: any): ToolConfig {
  const full = Boolean(options.fullSurface);
  const core = Boolean(options.coreOnly);
  return {
    coreOnly: core,
    enableUI: !core && (full ? !options.disableUi : Boolean(options.enableUi) && !options.disableUi),
    enableAutoGUI: !core && (full ? !options.disableAutogui : Boolean(options.enableAutogui) && !options.disableAutogui),
    enableOrchestration: !core && (full ? !options.disableOrchestration : Boolean(options.enableOrchestration) && !options.disableOrchestration),
    enableUIRegistry: !core && (full || Boolean(options.enableUiRegistry)),
    enableGitHubUI: !core && (full || Boolean(options.enableGithubUi)),
    enableDesktop: !core && Boolean(options.enableDesktop),
    enableCommunityCryptuon: !core && Boolean(options.enableCommunityCryptuon),
    dedupeTools: true,
    enabledCategories: options.enableCategories ? options.enableCategories.split(',') : [],
    disabledTools: options.disableTools ? options.disableTools.split(',') : [],
  };
}

// Register the MCP request handlers shared by every transport.
function registerHandlers(
  server: Server,
  options: any,
  configuredTools: any[],
  toolMap: Map<string, any>,
) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: configuredTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      console.error(`Executing tool: ${tool.name}`);
      return await tool.handler(request.params.arguments || {});
    } catch (error: any) {
      console.error(`Tool error: ${error.message}`);
      return {
        content: [{ type: 'text', text: `Error executing ${tool.name}: ${error.message}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [{
        uri: 'hanzo://system-prompt',
        name: 'System Prompt',
        mimeType: 'text/plain',
        description: 'Hanzo MCP system prompt and context',
      }],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'hanzo://system-prompt') {
      const systemPrompt = await getSystemPrompt(options.project);
      return {
        contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: systemPrompt }],
      };
    }
    return {
      contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'Resource not found' }],
    };
  });
}

// Serve the tools over streamable http. A fresh server and transport per request
// keeps the door stateless — no session header, each POST answered on its own,
// the shape the current protocol revision settled on.
async function startHttpServer(options: any, toolConfig: ToolConfig) {
  const configuredTools = getConfiguredTools(toolConfig);
  const toolMap = new Map<string, any>(configuredTools.map(t => [t.name, t]));
  console.error(`Registering ${configuredTools.length} tools...`);

  const port = parseInt(options.port, 10) || 3000;
  const host = process.env.HOST || '127.0.0.1';

  const httpServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const server = new Server(
      { name: 'hanzo-mcp', version: packageJson.version },
      { capabilities: { tools: {}, resources: {} } },
    );
    registerHandlers(server, options, configuredTools, toolMap);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error: any) {
      console.error(`HTTP request error: ${error.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`Hanzo MCP server (streamable http) on http://${host}:${port}`);
  });

  await new Promise<never>(() => {});
}

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

  registerHandlers(server, options, configuredTools, toolMap);

  // Start the MCP stdio server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Hanzo MCP server started successfully');
}

// Parse command line arguments
program.parse();
