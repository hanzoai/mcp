/**
 * exec — Unified process execution tool (HIP-0300)
 *
 * One tool for the Execution axis.
 * Actions: exec, ps, kill, logs
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../types/index.js';

const execAsync = promisify(exec);

const processes = new Map<string, { process: any; stdout: string[]; stderr: string[]; exitCode?: number; started: string; command: string }>();
let procCounter = 0;

function envelope(data: any, action: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'exec', action } }, null, 2) }]
  };
}

function fail(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'exec' } }, null, 2) }],
    isError: true
  };
}

export const execTool: Tool = {
  name: 'exec',
  description: 'Process execution: exec, ps, kill, logs',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['exec', 'ps', 'kill', 'logs'], description: 'Process action' },
      command: { type: 'string', description: 'Command to execute' },
      cwd: { type: 'string', description: 'Working directory' },
      env: { type: 'object', description: 'Environment variables' },
      timeout: { type: 'number', description: 'Timeout in ms', default: 30000 },
      background: { type: 'boolean', description: 'Run in background', default: false },
      proc_id: { type: 'string', description: 'Process ID for ps/kill/logs' },
      signal: { type: 'string', description: 'Signal for kill', default: 'SIGTERM' },
      tail: { type: 'number', description: 'Lines from end for logs', default: 50 },
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'exec': {
          if (!args.command) return fail('INVALID_PARAMS', 'command required');

          if (args.background) {
            procCounter++;
            const id = args.proc_id || `proc_${procCounter}`;
            if (processes.has(id)) return fail('CONFLICT', `Process ${id} already exists`);

            const [cmd, ...cmdArgs] = args.command.split(' ');
            const proc = spawn(cmd, cmdArgs, { cwd: args.cwd, detached: true, stdio: 'pipe', env: { ...process.env, ...args.env } });

            const entry = { process: proc, stdout: [] as string[], stderr: [] as string[], exitCode: undefined as number | undefined, started: new Date().toISOString(), command: args.command };
            processes.set(id, entry);

            proc.stdout?.on('data', (d: Buffer) => entry.stdout.push(d.toString()));
            proc.stderr?.on('data', (d: Buffer) => entry.stderr.push(d.toString()));
            proc.on('exit', (code: number | null) => { entry.exitCode = code ?? -1; });

            return envelope({ proc_id: id, pid: proc.pid, background: true }, 'exec');
          }

          const { stdout, stderr } = await execAsync(args.command, {
            cwd: args.cwd,
            timeout: args.timeout || 30000,
            env: { ...process.env, ...args.env },
            maxBuffer: 10 * 1024 * 1024
          });

          return envelope({
            stdout: stdout || '',
            stderr: stderr || '',
            exit_code: 0,
          }, 'exec');
        }

        case 'ps': {
          const list = [];
          for (const [id, data] of processes.entries()) {
            if (args.proc_id && id !== args.proc_id) continue;
            list.push({
              proc_id: id,
              pid: data.process.pid,
              command: data.command,
              running: data.exitCode === undefined,
              exit_code: data.exitCode,
              started: data.started,
            });
          }
          return envelope({ processes: list, count: list.length }, 'ps');
        }

        case 'kill': {
          if (!args.proc_id) return fail('INVALID_PARAMS', 'proc_id required');
          const entry = processes.get(args.proc_id);
          if (!entry) return fail('NOT_FOUND', `No process: ${args.proc_id}`);

          try {
            const sig = args.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
            entry.process.kill(sig);
            processes.delete(args.proc_id);
            return envelope({ proc_id: args.proc_id, killed: true, signal: sig }, 'kill');
          } catch (e: any) {
            return fail('ERROR', e.message);
          }
        }

        case 'logs': {
          if (!args.proc_id) return fail('INVALID_PARAMS', 'proc_id required');
          const entry = processes.get(args.proc_id);
          if (!entry) return fail('NOT_FOUND', `No process: ${args.proc_id}`);

          const tail = args.tail || 50;
          return envelope({
            proc_id: args.proc_id,
            stdout: entry.stdout.slice(-tail).join(''),
            stderr: entry.stderr.slice(-tail).join(''),
            running: entry.exitCode === undefined,
            exit_code: entry.exitCode,
          }, 'logs');
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', `${error.message}\n${error.stdout || ''}${error.stderr || ''}`);
    }
  }
};
