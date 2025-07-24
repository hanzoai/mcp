/**
 * Shell and command execution tools for Hanzo MCP
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { Tool, ToolResult } from '../types';

const execAsync = promisify(exec);

// Store background processes
const backgroundProcesses = new Map<string, any>();

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a bash command',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute'
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds',
        default: 30000
      },
      env: {
        type: 'object',
        description: 'Environment variables'
      }
    },
    required: ['command']
  },
  handler: async (args) => {
    try {
      const options: any = {
        cwd: args.cwd,
        timeout: args.timeout || 30000,
        env: { ...process.env, ...args.env },
        maxBuffer: 10 * 1024 * 1024 // 10MB
      };
      
      const { stdout, stderr } = await execAsync(args.command, options);
      
      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += '\n[stderr]\n' + stderr;
      
      return {
        content: [{
          type: 'text',
          text: output || 'Command completed with no output'
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error executing command: ${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`
        }],
        isError: true
      };
    }
  }
};

export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Execute a shell command (alias for bash)',
  inputSchema: bashTool.inputSchema,
  handler: bashTool.handler
};

export const runBackgroundTool: Tool = {
  name: 'run_background',
  description: 'Run a command in the background',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to run in background'
      },
      id: {
        type: 'string',
        description: 'Unique ID for this background process'
      },
      cwd: {
        type: 'string',
        description: 'Working directory'
      }
    },
    required: ['command', 'id']
  },
  handler: async (args) => {
    try {
      if (backgroundProcesses.has(args.id)) {
        return {
          content: [{
            type: 'text',
            text: `Process with ID ${args.id} already exists`
          }],
          isError: true
        };
      }
      
      const [cmd, ...cmdArgs] = args.command.split(' ');
      const proc = spawn(cmd, cmdArgs, {
        cwd: args.cwd,
        detached: true,
        stdio: 'pipe'
      });
      
      backgroundProcesses.set(args.id, {
        process: proc,
        output: [],
        error: []
      });
      
      const procData = backgroundProcesses.get(args.id);
      
      proc.stdout?.on('data', (data) => {
        procData.output.push(data.toString());
      });
      
      proc.stderr?.on('data', (data) => {
        procData.error.push(data.toString());
      });
      
      proc.on('exit', (code) => {
        procData.exitCode = code;
      });
      
      return {
        content: [{
          type: 'text',
          text: `Background process started with ID: ${args.id}, PID: ${proc.pid}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error starting background process: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const listProcessesTool: Tool = {
  name: 'list_processes',
  description: 'List running background processes',
  inputSchema: {
    type: 'object',
    properties: {}
  },
  handler: async () => {
    const processes = [];
    
    for (const [id, data] of backgroundProcesses.entries()) {
      processes.push({
        id,
        pid: data.process.pid,
        running: data.exitCode === undefined,
        exitCode: data.exitCode
      });
    }
    
    if (processes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No background processes running'
        }]
      };
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(processes, null, 2)
      }]
    };
  }
};

export const getProcessOutputTool: Tool = {
  name: 'get_process_output',
  description: 'Get output from a background process',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The process ID'
      },
      tail: {
        type: 'number',
        description: 'Number of lines to show from the end',
        default: 50
      }
    },
    required: ['id']
  },
  handler: async (args) => {
    const procData = backgroundProcesses.get(args.id);
    
    if (!procData) {
      return {
        content: [{
          type: 'text',
          text: `No process found with ID: ${args.id}`
        }],
        isError: true
      };
    }
    
    const output = procData.output.slice(-(args.tail || 50)).join('');
    const error = procData.error.slice(-(args.tail || 50)).join('');
    
    let result = '';
    if (output) result += 'Output:\n' + output;
    if (error) result += '\nError:\n' + error;
    if (!output && !error) result = 'No output yet';
    
    return {
      content: [{
        type: 'text',
        text: result
      }]
    };
  }
};

export const killProcessTool: Tool = {
  name: 'kill_process',
  description: 'Kill a background process',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The process ID to kill'
      }
    },
    required: ['id']
  },
  handler: async (args) => {
    const procData = backgroundProcesses.get(args.id);
    
    if (!procData) {
      return {
        content: [{
          type: 'text',
          text: `No process found with ID: ${args.id}`
        }],
        isError: true
      };
    }
    
    try {
      procData.process.kill();
      backgroundProcesses.delete(args.id);
      
      return {
        content: [{
          type: 'text',
          text: `Process ${args.id} killed`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error killing process: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

// Export all shell tools
export const shellTools = [
  bashTool,
  runCommandTool,
  runBackgroundTool,
  listProcessesTool,
  getProcessOutputTool,
  killProcessTool
];