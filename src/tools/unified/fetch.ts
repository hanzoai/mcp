/**
 * fetch — Unified network tool (HIP-0300)
 *
 * One tool for the HTTP/API axis.
 * Actions: request, download, open
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../types/index.js';

const execAsync = promisify(exec);

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'fetch', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'fetch' } }, null, 2) }], isError: true };
}

export const fetchTool: Tool = {
  name: 'fetch',
  description: 'Network operations: request, download, open',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['request', 'download', 'open'], description: 'Network action' },
      url: { type: 'string', description: 'URL' },
      method: { type: 'string', description: 'HTTP method', default: 'GET' },
      headers: { type: 'object', description: 'HTTP headers' },
      body: { type: 'string', description: 'Request body' },
      output: { type: 'string', description: 'Output file for download' },
      timeout: { type: 'number', default: 30000 },
    },
    required: ['action', 'url']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'request': {
          const opts: RequestInit = {
            method: args.method || 'GET',
            headers: args.headers || {},
            signal: AbortSignal.timeout(args.timeout || 30000),
          };
          if (args.body) opts.body = args.body;
          const resp = await fetch(args.url, opts);
          const contentType = resp.headers.get('content-type') || '';
          let data: any;
          if (contentType.includes('json')) {
            data = await resp.json();
          } else {
            data = await resp.text();
          }
          return envelope({
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            body: typeof data === 'string' ? data.substring(0, 50000) : data,
          }, 'request');
        }

        case 'download': {
          if (!args.output) return fail('INVALID_PARAMS', 'output path required');
          const resp = await fetch(args.url, { signal: AbortSignal.timeout(args.timeout || 60000) });
          if (!resp.ok) return fail('HTTP_ERROR', `${resp.status} ${resp.statusText}`);
          const buffer = Buffer.from(await resp.arrayBuffer());
          await fs.mkdir(path.dirname(args.output), { recursive: true });
          await fs.writeFile(args.output, buffer);
          return envelope({ url: args.url, output: args.output, size: buffer.length, status: resp.status }, 'download');
        }

        case 'open': {
          const platform = process.platform;
          const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
          await execAsync(`${cmd} "${args.url}"`);
          return envelope({ url: args.url, opened: true }, 'open');
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
