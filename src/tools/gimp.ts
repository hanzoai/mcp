/**
 * GIMP tool -- single tool, action-routed GIMP automation.
 *
 * Connects to the Hanzo GIMP bridge (clean-room BSD-3 plug-in) over a
 * line-oriented JSON TCP socket and drives GIMP through its documented
 * Procedural Database (PDB). Bridge default: 127.0.0.1:9876.
 *
 * Protocol: request {"id","method","params"} -> response {"id","result"}
 * or {"id","error"}. See hanzo/gimp-mcp/PROTOCOL.md.
 */

import { Tool } from '../types/index.js';
import { connect } from 'net';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9876;

/**
 * Send one JSON request to the GIMP bridge and resolve with the result.
 * Opens a short-lived connection, writes one newline-terminated JSON line,
 * reads one newline-terminated JSON reply.
 */
function gimpRequest(
  method: string,
  params: Record<string, any>,
  host: string,
  port: number,
  timeoutMs = 60000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const socket = connect({ host, port });
    let buf = '';
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(() => reject(new Error(`GIMP bridge timed out after ${timeoutMs}ms`))));
    socket.on('error', (err: any) =>
      done(() => reject(new Error(`GIMP bridge connection failed (${host}:${port}): ${err.message}`)))
    );

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line);
        if (msg.error) {
          done(() => reject(new Error(msg.error.message || 'GIMP bridge error')));
        } else {
          done(() => resolve(msg.result));
        }
      } catch (e: any) {
        done(() => reject(new Error(`Invalid response from GIMP bridge: ${e.message}`)));
      }
    });
  });
}

export const gimpTool: Tool = {
  name: 'gimp',
  description:
    'GIMP automation via the clean-room BSD-3 bridge (JSON-over-TCP to the GIMP PDB): version, open, export, pdb_call (generic PDB invocation -- the core power), new_image, image_info, list_procedures, flatten. Requires the Hanzo GIMP bridge plug-in running inside GIMP (default 127.0.0.1:9876).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['version', 'open', 'export', 'pdb_call', 'new_image', 'image_info', 'list_procedures', 'flatten'],
        description: 'GIMP action'
      },
      path: { type: 'string', description: 'File path (open, export)' },
      image_id: { type: 'number', description: 'GIMP image id (export, image_info, flatten)' },
      procedure: { type: 'string', description: 'PDB procedure name (pdb_call), e.g. gimp-image-flatten' },
      args: { type: 'array', items: {}, description: 'Positional PDB args (pdb_call); integer ids accepted for GIMP objects' },
      width: { type: 'number', description: 'Image width (new_image)' },
      height: { type: 'number', description: 'Image height (new_image)' },
      prefix: { type: 'string', description: 'Filter procedures by name prefix (list_procedures)' },
      host: { type: 'string', description: 'GIMP bridge host', default: DEFAULT_HOST },
      port: { type: 'number', description: 'GIMP bridge port', default: DEFAULT_PORT }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const host = args.host || DEFAULT_HOST;
      const port = args.port || DEFAULT_PORT;
      let result: any;

      switch (args.action) {
        case 'version':
          result = await gimpRequest('version', {}, host, port);
          break;

        case 'open':
          if (!args.path) return { content: [{ type: 'text', text: 'path required' }], isError: true };
          result = await gimpRequest('open_image', { path: args.path }, host, port);
          break;

        case 'export':
          if (args.image_id === undefined || args.image_id === null)
            return { content: [{ type: 'text', text: 'image_id required' }], isError: true };
          if (!args.path) return { content: [{ type: 'text', text: 'path required' }], isError: true };
          result = await gimpRequest('export', { image_id: args.image_id, path: args.path }, host, port);
          break;

        case 'pdb_call':
          if (!args.procedure) return { content: [{ type: 'text', text: 'procedure required' }], isError: true };
          result = await gimpRequest('pdb_call', { procedure: args.procedure, args: args.args || [] }, host, port);
          break;

        case 'new_image':
          if (args.width === undefined || args.height === undefined)
            return { content: [{ type: 'text', text: 'width and height required' }], isError: true };
          result = await gimpRequest('new_image', { width: args.width, height: args.height }, host, port);
          break;

        case 'image_info':
          if (args.image_id === undefined || args.image_id === null)
            return { content: [{ type: 'text', text: 'image_id required' }], isError: true };
          result = await gimpRequest('image_info', { image_id: args.image_id }, host, port);
          break;

        case 'list_procedures':
          result = await gimpRequest('list_procedures', args.prefix ? { prefix: args.prefix } : {}, host, port);
          break;

        case 'flatten':
          if (args.image_id === undefined || args.image_id === null)
            return { content: [{ type: 'text', text: 'image_id required' }], isError: true };
          result = await gimpRequest('flatten', { image_id: args.image_id }, host, port);
          break;

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }

      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text: text || 'Done' }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const gimpTools = [gimpTool];
