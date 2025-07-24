/**
 * Search tools for Hanzo MCP
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolResult, SearchResult } from '../types';

const execAsync = promisify(exec);

// Check if ripgrep is available
const hasRipgrep = async (): Promise<boolean> => {
  try {
    await execAsync('which rg');
    return true;
  } catch {
    return false;
  }
};

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search for patterns in files using grep or ripgrep',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The pattern to search for (regex supported)'
      },
      path: {
        type: 'string',
        description: 'The path to search in',
        default: '.'
      },
      filePattern: {
        type: 'string',
        description: 'File pattern to include (e.g., "*.ts")'
      },
      ignoreCase: {
        type: 'boolean',
        description: 'Case insensitive search',
        default: false
      },
      showLineNumbers: {
        type: 'boolean',
        description: 'Show line numbers',
        default: true
      },
      contextLines: {
        type: 'number',
        description: 'Number of context lines to show',
        default: 0
      }
    },
    required: ['pattern']
  },
  handler: async (args) => {
    try {
      const useRipgrep = await hasRipgrep();
      let command: string;
      
      if (useRipgrep) {
        command = 'rg';
        if (args.ignoreCase) command += ' -i';
        if (args.showLineNumbers) command += ' -n';
        if (args.contextLines > 0) command += ` -C ${args.contextLines}`;
        if (args.filePattern) command += ` -g "${args.filePattern}"`;
        command += ` "${args.pattern}" "${args.path || '.'}"`;
      } else {
        command = 'grep -r';
        if (args.ignoreCase) command += ' -i';
        if (args.showLineNumbers) command += ' -n';
        if (args.contextLines > 0) command += ` -C ${args.contextLines}`;
        if (args.filePattern) command += ` --include="${args.filePattern}"`;
        command += ` "${args.pattern}" "${args.path || '.'}"`;
      }
      
      const { stdout } = await execAsync(command);
      
      return {
        content: [{
          type: 'text',
          text: stdout || 'No matches found'
        }]
      };
    } catch (error: any) {
      if (error.code === 1) {
        // No matches found
        return {
          content: [{
            type: 'text',
            text: 'No matches found'
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Error searching: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const findFilesTool: Tool = {
  name: 'find_files',
  description: 'Find files by name pattern',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The file name pattern to search for (glob supported)'
      },
      path: {
        type: 'string',
        description: 'The directory to search in',
        default: '.'
      },
      type: {
        type: 'string',
        description: 'Filter by type: "file" or "directory"'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum directory depth to search'
      }
    },
    required: ['pattern']
  },
  handler: async (args) => {
    try {
      const globPattern = path.join(args.path || '.', '**', args.pattern);
      const files = await glob(globPattern, {
        nodir: args.type === 'file',
        onlyDirectories: args.type === 'directory',
        maxDepth: args.maxDepth
      });
      
      if (files.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No files found matching the pattern'
          }]
        };
      }
      
      return {
        content: [{
          type: 'text',
          text: files.join('\n')
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error finding files: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const searchTool: Tool = {
  name: 'search',
  description: 'Unified search that combines multiple search strategies',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query'
      },
      path: {
        type: 'string',
        description: 'The path to search in',
        default: '.'
      },
      type: {
        type: 'string',
        description: 'Type of search: "all", "code", "text", "filename"',
        default: 'all'
      },
      filePattern: {
        type: 'string',
        description: 'File pattern to include'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results',
        default: 50
      }
    },
    required: ['query']
  },
  handler: async (args) => {
    const results: string[] = [];
    
    try {
      // Search in filenames
      if (args.type === 'all' || args.type === 'filename') {
        const filePattern = `*${args.query}*`;
        const globPattern = path.join(args.path || '.', '**', filePattern);
        const files = await glob(globPattern, { maxDepth: 5 });
        
        if (files.length > 0) {
          results.push('=== Filename Matches ===');
          results.push(...files.slice(0, args.maxResults || 50));
          results.push('');
        }
      }
      
      // Search in file contents
      if (args.type === 'all' || args.type === 'code' || args.type === 'text') {
        const useRipgrep = await hasRipgrep();
        let command: string;
        
        if (useRipgrep) {
          command = `rg -n --max-count ${args.maxResults || 50}`;
          if (args.filePattern) command += ` -g "${args.filePattern}"`;
          command += ` "${args.query}" "${args.path || '.'}"`;
        } else {
          command = `grep -r -n`;
          if (args.filePattern) command += ` --include="${args.filePattern}"`;
          command += ` "${args.query}" "${args.path || '.'}" | head -${args.maxResults || 50}`;
        }
        
        try {
          const { stdout } = await execAsync(command);
          if (stdout) {
            results.push('=== Content Matches ===');
            results.push(stdout.trim());
          }
        } catch (error: any) {
          if (error.code !== 1) { // 1 means no matches, which is ok
            throw error;
          }
        }
      }
      
      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No matches found'
          }]
        };
      }
      
      return {
        content: [{
          type: 'text',
          text: results.join('\n')
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error searching: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

// Export all search tools
export const searchTools = [
  grepTool,
  findFilesTool,
  searchTool
];