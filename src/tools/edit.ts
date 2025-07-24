/**
 * File editing tools for Hanzo MCP
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolResult } from '../types';

interface Edit {
  oldText: string;
  newText: string;
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Replace text in a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to edit'
      },
      oldText: {
        type: 'string',
        description: 'The exact text to replace'
      },
      newText: {
        type: 'string',
        description: 'The new text to insert'
      }
    },
    required: ['path', 'oldText', 'newText']
  },
  handler: async (args) => {
    try {
      const content = await fs.readFile(args.path, 'utf8');
      
      if (!content.includes(args.oldText)) {
        return {
          content: [{
            type: 'text',
            text: 'Error: oldText not found in file. Make sure it matches exactly, including whitespace.'
          }],
          isError: true
        };
      }
      
      // Count occurrences
      const occurrences = content.split(args.oldText).length - 1;
      if (occurrences > 1) {
        return {
          content: [{
            type: 'text',
            text: `Error: oldText found ${occurrences} times. Please make it unique by including more context.`
          }],
          isError: true
        };
      }
      
      const newContent = content.replace(args.oldText, args.newText);
      await fs.writeFile(args.path, newContent, 'utf8');
      
      return {
        content: [{
          type: 'text',
          text: `Successfully replaced text in ${args.path}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error editing file: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const multiEditTool: Tool = {
  name: 'multi_edit',
  description: 'Make multiple edits to a file in one operation',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The file path to edit'
      },
      edits: {
        type: 'array',
        description: 'Array of edit operations',
        items: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: 'The exact text to replace'
            },
            newText: {
              type: 'string',
              description: 'The new text to insert'
            }
          },
          required: ['oldText', 'newText']
        }
      }
    },
    required: ['path', 'edits']
  },
  handler: async (args) => {
    try {
      let content = await fs.readFile(args.path, 'utf8');
      const results = [];
      
      for (const edit of args.edits) {
        if (!content.includes(edit.oldText)) {
          results.push(`❌ oldText not found: "${edit.oldText.substring(0, 50)}..."`);
          continue;
        }
        
        const occurrences = content.split(edit.oldText).length - 1;
        if (occurrences > 1) {
          results.push(`❌ oldText found ${occurrences} times: "${edit.oldText.substring(0, 50)}..."`);
          continue;
        }
        
        content = content.replace(edit.oldText, edit.newText);
        results.push(`✓ Replaced: "${edit.oldText.substring(0, 30)}..." → "${edit.newText.substring(0, 30)}..."`);
      }
      
      await fs.writeFile(args.path, content, 'utf8');
      
      return {
        content: [{
          type: 'text',
          text: `Edits completed in ${args.path}:\n${results.join('\n')}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error in multi-edit: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const createFileTool: Tool = {
  name: 'create_file',
  description: 'Create a new file with content',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path for the new file'
      },
      content: {
        type: 'string',
        description: 'The content for the new file'
      },
      overwrite: {
        type: 'boolean',
        description: 'Whether to overwrite if file exists',
        default: false
      }
    },
    required: ['path', 'content']
  },
  handler: async (args) => {
    try {
      // Check if file exists
      try {
        await fs.access(args.path);
        if (!args.overwrite) {
          return {
            content: [{
              type: 'text',
              text: `Error: File already exists. Use overwrite: true to replace it.`
            }],
            isError: true
          };
        }
      } catch {
        // File doesn't exist, which is what we want
      }
      
      // Create directory if needed
      const dir = path.dirname(args.path);
      await fs.mkdir(dir, { recursive: true });
      
      // Write file
      await fs.writeFile(args.path, args.content, 'utf8');
      
      return {
        content: [{
          type: 'text',
          text: `File created: ${args.path}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error creating file: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const deleteFileTool: Tool = {
  name: 'delete_file',
  description: 'Delete a file or empty directory',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to delete'
      },
      recursive: {
        type: 'boolean',
        description: 'Delete directories recursively',
        default: false
      }
    },
    required: ['path']
  },
  handler: async (args) => {
    try {
      const stats = await fs.stat(args.path);
      
      if (stats.isDirectory()) {
        if (args.recursive) {
          await fs.rm(args.path, { recursive: true, force: true });
        } else {
          await fs.rmdir(args.path);
        }
      } else {
        await fs.unlink(args.path);
      }
      
      return {
        content: [{
          type: 'text',
          text: `Deleted: ${args.path}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error deleting: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const moveFileTool: Tool = {
  name: 'move_file',
  description: 'Move or rename a file or directory',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'The source path'
      },
      destination: {
        type: 'string',
        description: 'The destination path'
      },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite destination if it exists',
        default: false
      }
    },
    required: ['source', 'destination']
  },
  handler: async (args) => {
    try {
      // Check if destination exists
      try {
        await fs.access(args.destination);
        if (!args.overwrite) {
          return {
            content: [{
              type: 'text',
              text: `Error: Destination already exists. Use overwrite: true to replace it.`
            }],
            isError: true
          };
        }
      } catch {
        // Destination doesn't exist, which is fine
      }
      
      // Create destination directory if needed
      const destDir = path.dirname(args.destination);
      await fs.mkdir(destDir, { recursive: true });
      
      // Move file
      await fs.rename(args.source, args.destination);
      
      return {
        content: [{
          type: 'text',
          text: `Moved: ${args.source} → ${args.destination}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error moving file: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

// Export all edit tools
export const editTools = [
  editFileTool,
  multiEditTool,
  createFileTool,
  deleteFileTool,
  moveFileTool
];