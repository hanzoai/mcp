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
  getConfiguredTools, ToolConfig, coreTools, optionalTools, codeIntelTools, trackerTools, kaiTools, uiTools,
  autoguiTools, orchestrationTools, uiRegistryTools, githubUITools, desktopTools, cryptuonCommunityTools,
  legacyToolAliasMap,
} from './tools/index.js';
import { Tool, listed } from './types/index.js';
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
  .allowUnknownOption();

program
  .command('serve', { isDefault: true })
  .description('Start the MCP server')
  .allowUnknownOption()
  .option('-t, --transport <type>', 'Transport type (stdio, http, sse, streamable-http)', 'stdio')
  .option('-p, --port <port>', 'Port for HTTP transport', '3000')
  .option('--project <path>', 'Project path for context', process.cwd())
  .option('--allow-path <path...>', 'Allowed paths for client operations')
  .option('--project-dir <path...>', 'Filesystem root the server may operate under; the native hanzo-mcp spelling, which `hanzo dev` passes')
  .option('--beta-safe', 'Offer only the safe validated beta tools (core + tool resolution, next action, command guard, loop breaker)')
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
    if (options.projectDir?.length) {
      options.allowPath = [...(options.allowPath ?? []), ...options.projectDir];
      options.project = options.projectDir[0];
    }
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
    
    const transportMode = String(options.transport || 'stdio').toLowerCase();
    if (transportMode === 'stdio') {
      await startStdioServer(options, toolConfig);
    } else if (
      transportMode === 'http' ||
      transportMode === 'sse' ||
      transportMode === 'streamable-http'
    ) {
      await startHttpServer(options, toolConfig);
    } else {
      console.error(`Unknown transport: ${options.transport} (use stdio, http, sse, or streamable-http)`);
      process.exit(1);
    }
  });

program
  .command('list-tools')
  .description('List available MCP tools')
  .option('--beta-safe', 'List only the safe validated beta tools')
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
  .option('--category <group>', 'List one group: core, optional, code intelligence, tracker, kai, ui, autogui, orchestration, ui registry, github ui, desktop, community, other')
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
      ['kai', kaiTools],
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

function resolveHomeDir(): string {
  return process.env.HANZO_MCP_HOME || process.env.HOME || os.homedir();
}

function resolveAppDataDir(): string {
  const home = resolveHomeDir();
  if (process.env.HANZO_MCP_HOME) {
    return path.join(home, 'AppData', 'Roaming');
  }
  return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
}

function resolveXdgConfigDir(): string {
  const home = resolveHomeDir();
  if (process.env.HANZO_MCP_HOME) {
    return path.join(home, '.config');
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function resolveClaudeDesktopConfigFile(): string {
  if (process.platform === 'win32') {
    return path.join(resolveAppDataDir(), 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(resolveHomeDir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(resolveXdgConfigDir(), 'Claude', 'claude_desktop_config.json');
}

function resolveVSCodeMcpConfigFile(): string {
  if (process.platform === 'win32') {
    return path.join(resolveAppDataDir(), 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return path.join(resolveHomeDir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return path.join(resolveXdgConfigDir(), 'Code', 'User', 'mcp.json');
}

function hasCommand(bin: string): boolean {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(locator, [bin], { stdio: 'ignore' }).status === 0;
}

function buildMcpEntry(serveArgs: string[], env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    command: 'npx',
    args: ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', ...serveArgs],
    env,
  };
}

async function upsertJsonMcpConfig(
  configFile: string,
  rootKey: 'mcpServers' | 'servers',
  serverName: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  let config: Record<string, any> = {};
  try {
    const configContent = await fs.readFile(configFile, 'utf-8');
    const parsed = JSON.parse(configContent);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed;
    }
  } catch {
    // Config doesn't exist yet or isn't valid JSON
  }

  if (!config[rootKey] || typeof config[rootKey] !== 'object' || Array.isArray(config[rootKey])) {
    config[rootKey] = {};
  }

  config[rootKey][serverName] = entry;
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

async function upsertCodexTomlConfig(
  configFile: string,
  serverName: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(configFile, 'utf-8');
  } catch {
    // Config doesn't exist yet
  }

  const kept: string[] = [];
  let skippingSection = false;
  const headerExact = `[mcp_servers.${serverName}]`;
  const headerSubPrefix = `[mcp_servers.${serverName}.`;

  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      skippingSection = trimmed === headerExact || trimmed.startsWith(headerSubPrefix);
    }
    if (!skippingSection) {
      kept.push(line);
    }
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }

  const block = [
    headerExact,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map(a => JSON.stringify(a)).join(', ')}]`,
  ];
  if (env && Object.keys(env).length > 0) {
    block.push('', `[mcp_servers.${serverName}.env]`);
    for (const [k, v] of Object.entries(env)) {
      block.push(`${k} = ${JSON.stringify(v)}`);
    }
  }

  const nextContent = kept.length > 0
    ? `${kept.join('\n')}\n\n${block.join('\n')}\n`
    : `${block.join('\n')}\n`;
  await fs.writeFile(configFile, nextContent, 'utf-8');
}

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
    const homeDir = resolveHomeDir();
    const standardEntry = buildMcpEntry(['serve']);

    const configureJsonTarget = async (
      label: string,
      configFile: string,
      rootKey: 'mcpServers' | 'servers',
      entry: Record<string, unknown> = standardEntry,
      note?: string,
    ) => {
      console.log(`📦 Installing for ${label}...`);
      try {
        await upsertJsonMcpConfig(configFile, rootKey, 'hanzo-mcp', entry);
        console.log(`✓ ${label} configured: ${configFile}`);
        if (note) {
          console.log(`  ${note}`);
        }
      } catch (error: any) {
        console.error(`✗ ${label} installation failed: ${error.message}`);
      }
    };

    const installClaudeDesktop = () =>
      configureJsonTarget('Claude Desktop', resolveClaudeDesktopConfigFile(), 'mcpServers');

    // Helper function to install for Claude Code. Claude Code reads the servers
    // `claude mcp add` registered, not a file written beside its config.
    const installClaudeCode = async () => {
      console.log('📦 Installing for Claude Code...');
      const args = ['mcp', 'add', '--scope', 'user', 'hanzo', '--', 'npx', '-y', '@hanzo/mcp', 'serve'];
      const run = spawnSync('claude', args, { stdio: 'inherit', shell: process.platform === 'win32' });
      if (run.error || run.status !== 0) {
        const why = run.error ? `did not run: ${run.error.message}` : `exited ${run.status}`;
        console.error(`✗ Claude Code: claude ${args.join(' ')} ${why}`);
        return;
      }
      console.log('✓ Claude Code configured for every project (claude mcp list shows hanzo)');
    };

    const installCursor = () =>
      configureJsonTarget('Cursor IDE', path.join(homeDir, '.cursor', 'mcp.json'), 'mcpServers');

    const installVSCode = () =>
      configureJsonTarget(
        'VS Code',
        resolveVSCodeMcpConfigFile(),
        'servers',
        buildMcpEntry(['serve'], {}, { type: 'stdio' }),
      );

    const installGemini = () =>
      configureJsonTarget('Google Gemini', path.join(homeDir, '.gemini', 'settings.json'), 'mcpServers');

    const installCodex = async () => {
      console.log('📦 Installing for OpenAI Codex...');
      const codexArgs = ['mcp', 'add', 'hanzo', '--', 'npx', '-y', '@hanzo/mcp', 'serve'];
      if (hasCommand('codex')) {
        const run = spawnSync('codex', codexArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
        if (!run.error && run.status === 0) {
          console.log('✓ Codex configured via codex mcp add');
          return;
        }
      }
      const configFile = path.join(homeDir, '.codex', 'config.toml');
      try {
        await upsertCodexTomlConfig(
          configFile,
          'hanzo',
          'npx',
          ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', 'serve'],
        );
        console.log(`✓ Codex configured: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Codex installation failed: ${error.message}`);
      }
    };

    const installWindsurf = () =>
      configureJsonTarget(
        'Windsurf IDE',
        path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
        'mcpServers',
      );

    const installJetBrains = () =>
      configureJsonTarget(
        'JetBrains IDEs',
        path.join(homeDir, '.jetbrains', 'mcp', 'servers.json'),
        'servers',
        standardEntry,
        '(Works with IntelliJ IDEA, WebStorm, PyCharm, etc.)',
      );
    
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

program
  .command('link')
  .description('Link Hanzo MCP server into coding agents (Claude Code, Cursor, Codex)')
  .option('--beta-safe', 'Link with safe-only beta capabilities (recommended)', true)
  .option('--full', 'Link with all tools instead of beta-safe')
  .option('--claude-code', 'Link for Claude Code')
  .option('--cursor', 'Link for Cursor IDE')
  .option('--codex', 'Link for OpenAI Codex')
  .option('--claude-desktop', 'Link for Claude Desktop')
  .option('--all', 'Link for all supported applications')
  .action(async (options) => {
    const isSafe = !options.full;
    const serveArgs = isSafe ? ['serve', '--beta-safe'] : ['serve'];
    const homeDir = resolveHomeDir();
    const linkedEnv = { LOCAL_KAI_URL: 'http://127.0.0.1:18977' };

    const linkClaudeCode = async () => {
      console.log('📦 Linking for Claude Code...');
      // Remove existing registration if present so flags can be cleanly updated
      spawnSync('claude', ['mcp', 'remove', 'hanzo', '-s', 'user'], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      const args = [
        'mcp', 'add', '--scope', 'user', 'hanzo',
        '-e', 'LOCAL_KAI_URL=http://127.0.0.1:18977',
        '--', 'npx', '-y', '@hanzo/mcp', ...serveArgs
      ];
      const run = spawnSync('claude', args, { stdio: 'inherit', shell: process.platform === 'win32' });
      if (run.error || run.status !== 0) {
        const why = run.error ? `did not run: ${run.error.message}` : `exited ${run.status}`;
        console.error(`✗ Claude Code: claude ${args.join(' ')} ${why}`);
        return;
      }
      console.log(`✓ Claude Code linked with ${isSafe ? 'safe beta tools (resolution, actions, loop breaker, command guard)' : 'all tools'}`);
    };

    const linkCursor = async () => {
      console.log('📦 Linking for Cursor IDE...');
      const configFile = path.join(homeDir, '.cursor', 'mcp.json');
      try {
        await upsertJsonMcpConfig(configFile, 'mcpServers', 'hanzo-mcp', buildMcpEntry(serveArgs, linkedEnv));
        console.log(`✓ Cursor IDE linked: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Cursor linking failed: ${error.message}`);
      }
    };

    const linkCodex = async () => {
      console.log('📦 Linking for OpenAI Codex...');
      const codexArgs = ['mcp', 'add', 'hanzo', '--', 'npx', '-y', '@hanzo/mcp', ...serveArgs];
      if (hasCommand('codex')) {
        const run = spawnSync('codex', codexArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
        if (!run.error && run.status === 0) {
          console.log('✓ OpenAI Codex linked via codex mcp add');
          return;
        }
      }
      const configFile = path.join(homeDir, '.codex', 'config.toml');
      try {
        await upsertCodexTomlConfig(
          configFile,
          'hanzo',
          'npx',
          ['-y', '--package=@hanzo/mcp', 'hanzo-mcp', ...serveArgs],
          linkedEnv,
        );
        console.log(`✓ OpenAI Codex linked: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Codex linking failed: ${error.message}`);
      }
    };

    const linkClaudeDesktop = async () => {
      console.log('📦 Linking for Claude Desktop...');
      const configFile = resolveClaudeDesktopConfigFile();
      try {
        await upsertJsonMcpConfig(configFile, 'mcpServers', 'hanzo-mcp', buildMcpEntry(serveArgs));
        console.log(`✓ Claude Desktop linked: ${configFile}`);
      } catch (error: any) {
        console.error(`✗ Claude Desktop linking failed: ${error.message}`);
      }
    };

    const targets: Array<{ name: string; run: () => Promise<void> }> = [];
    if (options.all) {
      targets.push(
        { name: 'Claude Code', run: linkClaudeCode },
        { name: 'Cursor IDE', run: linkCursor },
        { name: 'OpenAI Codex', run: linkCodex },
        { name: 'Claude Desktop', run: linkClaudeDesktop }
      );
    } else {
      if (options.claudeCode) targets.push({ name: 'Claude Code', run: linkClaudeCode });
      if (options.cursor) targets.push({ name: 'Cursor IDE', run: linkCursor });
      if (options.codex) targets.push({ name: 'OpenAI Codex', run: linkCodex });
      if (options.claudeDesktop) targets.push({ name: 'Claude Desktop', run: linkClaudeDesktop });
    }

    if (targets.length === 0) {
      // Auto-detect installed agents and directories
      const hasClaude = hasCommand('claude');
      let hasCursor = false;
      try { await fs.access(path.join(homeDir, '.cursor')); hasCursor = true; } catch {}
      let hasCodex = hasCommand('codex');
      if (!hasCodex) {
        try { await fs.access(path.join(homeDir, '.codex')); hasCodex = true; } catch {}
      }

      if (hasClaude) targets.push({ name: 'Claude Code', run: linkClaudeCode });
      if (hasCursor) targets.push({ name: 'Cursor IDE', run: linkCursor });
      if (hasCodex) targets.push({ name: 'OpenAI Codex', run: linkCodex });

      if (targets.length === 0) {
        targets.push({ name: 'Claude Code', run: linkClaudeCode });
      }
    }

    console.log(`\n🔗 Linking Hanzo MCP v${packageJson.version} (${isSafe ? 'Beta Safe Mode' : 'Full Surface'})...\n`);
    for (const { run } of targets) {
      await run();
    }
    console.log('\n✅ Linking complete! Coding agents now have Hanzo native acceleration.');
  });

// The tool set the surface flags select. serve and list-tools take the same
// flags, and both read them here.
function surface(options: any): ToolConfig {
  const full = Boolean(options.fullSurface);
  const core = Boolean(options.coreOnly);
  const betaSafe = Boolean(options.betaSafe);
  return {
    coreOnly: core,
    betaSafe: betaSafe,
    enableUI: !core && !betaSafe && (full ? !options.disableUi : Boolean(options.enableUi) && !options.disableUi),
    enableAutoGUI: !core && !betaSafe && (full ? !options.disableAutogui : Boolean(options.enableAutogui) && !options.disableAutogui),
    enableOrchestration: !core && !betaSafe && (full ? !options.disableOrchestration : Boolean(options.enableOrchestration) && !options.disableOrchestration),
    enableUIRegistry: !core && !betaSafe && (full || Boolean(options.enableUiRegistry)),
    enableGitHubUI: !core && !betaSafe && (full || Boolean(options.enableGithubUi)),
    enableDesktop: !core && !betaSafe && Boolean(options.enableDesktop),
    enableCommunityCryptuon: !core && !betaSafe && Boolean(options.enableCommunityCryptuon),
    dedupeTools: true,
    enabledCategories: options.enableCategories ? options.enableCategories.split(',') : [],
    disabledTools: options.disableTools ? options.disableTools.split(',') : [],
  };
}

// Register the MCP request handlers shared by every transport.
function registerHandlers(
  server: Server,
  options: any,
  toolConfig: ToolConfig,
  configuredTools: any[],
  toolMap: Map<string, any>,
  pendingResponses?: Set<Promise<unknown>>,
) {
  const track = <T>(promise: Promise<T>): Promise<T> => {
    if (!pendingResponses) {
      return promise;
    }
    pendingResponses.add(promise);
    return promise.finally(() => {
      pendingResponses.delete(promise);
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => track(Promise.resolve({
    tools: configuredTools.map(listed),
  })));

  server.setRequestHandler(CallToolRequestSchema, async (request) => track((async () => {
    const name = request.params.name;
    const allowAliases = !toolConfig.coreOnly && !toolConfig.betaSafe && !(toolConfig.disabledTools || []).includes(name);
    const tool = toolMap.get(name) || (allowAliases ? legacyToolAliasMap.get(name) : undefined);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
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
  })()));

  server.setRequestHandler(ListResourcesRequestSchema, async () => track(Promise.resolve({
    resources: [{
      uri: 'hanzo://system-prompt',
      name: 'System Prompt',
      mimeType: 'text/plain',
      description: 'Hanzo MCP system prompt and context',
    }],
  })));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => track((async () => {
    if (request.params.uri === 'hanzo://system-prompt') {
      const systemPrompt = await getSystemPrompt(options.project);
      return {
        contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: systemPrompt }],
      };
    }
    return {
      contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'Resource not found' }],
    };
  })()));
}

function ensureAcceptHeader(req: http.IncomingMessage): boolean {
  const rawAccept = String(req.headers.accept ?? '').toLowerCase();
  const wantsJsonOnly = rawAccept.includes('application/json') && !rawAccept.includes('text/event-stream');
  if (rawAccept.includes('application/json') && rawAccept.includes('text/event-stream')) {
    return false;
  }
  const normalized = 'application/json, text/event-stream';
  req.headers.accept = normalized;
  if (Array.isArray(req.rawHeaders)) {
    const filtered: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (String(req.rawHeaders[i] ?? '').toLowerCase() !== 'accept') {
        filtered.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
      }
    }
    filtered.push('Accept', normalized);
    req.rawHeaders = filtered;
  }
  return wantsJsonOnly;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization',
};

// Serve the tools over streamable http. A fresh server and transport per request
// keeps the door stateless — no session header, each POST answered on its own,
// the shape the current protocol revision settled on.
async function startHttpServer(options: any, toolConfig: ToolConfig) {
  const configuredTools = getConfiguredTools(toolConfig);
  const toolMap = new Map<string, any>(configuredTools.map(t => [t.name, t]));
  console.error(`Registering ${configuredTools.length} tools...`);

  const parsedPort = Number.parseInt(String(options.port ?? ''), 10);
  const port = Number.isNaN(parsedPort) ? 3000 : parsedPort;
  const host = process.env.HOST || '127.0.0.1';

  const httpServer = http.createServer(async (req, res) => {
    for (const [header, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(header, value);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'POST, GET, DELETE, OPTIONS' }).end();
      return;
    }

    const reqPath = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          name: 'hanzo-mcp',
          version: packageJson.version,
          transport: 'streamable-http',
        }),
      );
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, OPTIONS' }).end();
      return;
    }

    const enableJsonResponse = ensureAcceptHeader(req);
    const server = new Server(
      { name: 'hanzo-mcp', version: packageJson.version },
      { capabilities: { tools: {}, resources: {} } },
    );
    registerHandlers(server, options, toolConfig, configuredTools, toolMap);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse,
    });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error: any) {
      console.error(`HTTP request error: ${error.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      console.error(`Hanzo MCP server (streamable http) on http://${host}:${boundPort}`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      httpServer.close(() => resolve());
      httpServer.closeAllConnections?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
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
  const pendingResponses = new Set<Promise<unknown>>();

  // Register all tools
  console.error(`Registering ${configuredTools.length} tools...`);

  registerHandlers(server, options, toolConfig, configuredTools, toolMap, pendingResponses);

  // Start the MCP stdio server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      if (pendingResponses.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingResponses]),
          new Promise<void>(resolve => setTimeout(resolve, 2000)),
        ]);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => {
        if (process.stdout.writableEnded) {
          resolve();
          return;
        }
        process.stdout.write('', () => resolve());
      });
      await server.close();
    } catch {
      // Transport may already be closed
    }
    process.exit(0);
  };

  process.stdin.once('end', () => { void shutdown(); });
  process.stdin.once('close', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  console.error('Hanzo MCP server started successfully');
}

// Parse command line arguments
program.parse();
