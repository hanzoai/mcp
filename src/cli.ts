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
import { glob } from 'glob';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Version from package.json
const packageJson = JSON.parse(
  await fs.readFile(new URL('../package.json', import.meta.url), 'utf-8')
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
  .action(async (options) => {
    console.error(`Starting Hanzo MCP server v${packageJson.version}...`);
    
    if (options.transport === 'stdio') {
      await startStdioServer();
    } else {
      console.error('HTTP transport not yet implemented');
      process.exit(1);
    }
  });

program
  .command('list-tools')
  .description('List available MCP tools')
  .action(async () => {
    console.log('Available tools:');
    console.log('- read_file: Read file contents');
    console.log('- write_file: Write content to a file');
    console.log('- list_files: List files in a directory');
    console.log('- search_files: Search for files by pattern');
    console.log('- run_command: Execute a shell command');
    console.log('- get_file_info: Get file metadata');
  });

async function startStdioServer() {
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

  // Tool: read_file
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'read_file') {
      const { path: filePath } = request.params.arguments as { path: string };
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error reading file: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Tool: write_file
    if (request.params.name === 'write_file') {
      const { path: filePath, content } = request.params.arguments as {
        path: string;
        content: string;
      };
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return {
          content: [
            {
              type: 'text',
              text: `File written successfully: ${filePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error writing file: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Tool: list_files
    if (request.params.name === 'list_files') {
      const { directory } = request.params.arguments as { directory: string };
      try {
        const files = await fs.readdir(directory);
        const fileList = await Promise.all(
          files.map(async (file) => {
            const fullPath = path.join(directory, file);
            const stat = await fs.stat(fullPath);
            return {
              name: file,
              type: stat.isDirectory() ? 'directory' : 'file',
              size: stat.size,
              modified: stat.mtime.toISOString(),
            };
          })
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(fileList, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing files: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Tool: search_files
    if (request.params.name === 'search_files') {
      const { pattern, directory = '.' } = request.params.arguments as {
        pattern: string;
        directory?: string;
      };
      try {
        const files = await glob(pattern, { cwd: directory });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error searching files: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Tool: run_command
    if (request.params.name === 'run_command') {
      const { command, cwd = process.cwd() } = request.params.arguments as {
        command: string;
        cwd?: string;
      };
      try {
        const { stdout, stderr } = await execAsync(command, { cwd });
        return {
          content: [
            {
              type: 'text',
              text: stdout || stderr || 'Command executed successfully',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing command: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Tool: get_file_info
    if (request.params.name === 'get_file_info') {
      const { path: filePath } = request.params.arguments as { path: string };
      try {
        const stat = await fs.stat(filePath);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  path: filePath,
                  type: stat.isDirectory() ? 'directory' : 'file',
                  size: stat.size,
                  created: stat.ctime.toISOString(),
                  modified: stat.mtime.toISOString(),
                  accessed: stat.atime.toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error getting file info: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'read_file',
          description: 'Read the contents of a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file to read',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Write content to a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file to write',
              },
              content: {
                type: 'string',
                description: 'Content to write to the file',
              },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'list_files',
          description: 'List files in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to list files from',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'search_files',
          description: 'Search for files matching a pattern',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: {
                type: 'string',
                description: 'Glob pattern to search for',
              },
              directory: {
                type: 'string',
                description: 'Directory to search in (default: current directory)',
              },
            },
            required: ['pattern'],
          },
        },
        {
          name: 'run_command',
          description: 'Execute a shell command',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Command to execute',
              },
              cwd: {
                type: 'string',
                description: 'Working directory (default: current directory)',
              },
            },
            required: ['command'],
          },
        },
        {
          name: 'get_file_info',
          description: 'Get metadata about a file or directory',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file or directory',
              },
            },
            required: ['path'],
          },
        },
      ],
    };
  });

  // Resources support
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'file:///',
          name: 'Local filesystem',
          description: 'Access to the local filesystem',
          mimeType: 'text/plain',
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri.startsWith('file://')) {
      const filePath = uri.slice(7);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: content,
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to read resource: ${error.message}`);
      }
    }
    throw new Error(`Unsupported resource URI: ${uri}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Hanzo MCP server running on stdio transport');
}

// Parse command line arguments
program.parse();

// Default to serve command if no command specified
if (!process.argv.slice(2).length) {
  program.outputHelp();
}