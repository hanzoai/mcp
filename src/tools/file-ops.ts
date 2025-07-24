/**
 * File operation tools for Hanzo MCP
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { Tool, ToolResult, FileInfo } from '../types';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read'
      },
      encoding: {
        type: 'string',
        description: 'The encoding to use (default: utf8)',
        default: 'utf8'
      }
    },
    required: ['path']
  },
  handler: async (args) => {
    try {
      const content = await fs.readFile(args.path, args.encoding || 'utf8');
      return {
        content: [{
          type: 'text',
          text: content.toString()
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error reading file: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      },
      encoding: {
        type: 'string',
        description: 'The encoding to use (default: utf8)',
        default: 'utf8'
      }
    },
    required: ['path', 'content']
  },
  handler: async (args) => {
    try {
      await fs.mkdir(path.dirname(args.path), { recursive: true });
      await fs.writeFile(args.path, args.content, args.encoding || 'utf8');
      return {
        content: [{
          type: 'text',
          text: `File written successfully: ${args.path}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error writing file: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List files in a directory',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to list',
        default: '.'
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to list files recursively',
        default: false
      },
      pattern: {
        type: 'string',
        description: 'Glob pattern to filter files'
      }
    }
  },
  handler: async (args) => {
    try {
      const dirPath = args.path || '.';
      
      if (args.pattern) {
        const files = await glob(args.pattern, {
          cwd: dirPath,
          nodir: false
        });
        return {
          content: [{
            type: 'text',
            text: files.join('\n')
          }]
        };
      }
      
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const files = entries.map(entry => {
        const prefix = entry.isDirectory() ? '[DIR] ' : '';
        return prefix + entry.name;
      });
      
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
          text: `Error listing files: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getFileInfoTool: Tool = {
  name: 'get_file_info',
  description: 'Get metadata about a file or directory',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to get info for'
      }
    },
    required: ['path']
  },
  handler: async (args) => {
    try {
      const stats = await fs.stat(args.path);
      const info: FileInfo = {
        path: args.path,
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        lastModified: stats.mtime,
        permissions: stats.mode.toString(8)
      };
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(info, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error getting file info: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const directoryTreeTool: Tool = {
  name: 'directory_tree',
  description: 'Display a tree view of directory structure',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The directory path to display',
        default: '.'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth to traverse',
        default: 3
      },
      showHidden: {
        type: 'boolean',
        description: 'Whether to show hidden files',
        default: false
      }
    }
  },
  handler: async (args) => {
    const buildTree = async (dir: string, prefix = '', depth = 0): Promise<string> => {
      if (depth > (args.maxDepth || 3)) return '';
      
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const filtered = args.showHidden 
          ? entries 
          : entries.filter(e => !e.name.startsWith('.'));
        
        let tree = '';
        for (let i = 0; i < filtered.length; i++) {
          const entry = filtered[i];
          const isLast = i === filtered.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const extension = isLast ? '    ' : '│   ';
          
          tree += prefix + connector + entry.name + '\n';
          
          if (entry.isDirectory()) {
            const subPath = path.join(dir, entry.name);
            tree += await buildTree(subPath, prefix + extension, depth + 1);
          }
        }
        return tree;
      } catch (error) {
        return prefix + '└── [Error reading directory]\n';
      }
    };
    
    try {
      const tree = await buildTree(args.path || '.');
      return {
        content: [{
          type: 'text',
          text: (args.path || '.') + '\n' + tree
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error building tree: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

// Export all file operation tools
export const fileTools = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  getFileInfoTool,
  directoryTreeTool
];