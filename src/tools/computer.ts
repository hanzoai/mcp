/**
 * computer — Native OS desktop GUI & GIMP control (HIP-0300).
 *
 * Mirrors rust/src/tools/computer_tool/ + absorbs gimp (action="gimp").
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Tool, ToolResult } from '../types/index.js';
import { gimpTool } from './gimp.js';

const execFileAsync = promisify(execFile);

const ACTIONS = [
  'screenshot',
  'click',
  'double_click',
  'right_click',
  'move',
  'type',
  'key',
  'press',
  'hotkey',
  'scroll',
  'window',
  'list_windows',
  'focus_window',
  'info',
  'gimp',
] as const;

function envelope(data: unknown, action: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'computer', action } }, null, 2) }],
  };
}

function fail(action: string, code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'computer', action } }, null, 2) }],
    isError: true,
  };
}

export const computerTool: Tool = {
  name: 'computer',
  description:
    'Native OS desktop GUI control & GIMP automation: screenshot, click, move, type, key/press, hotkey, scroll, window/list_windows/focus_window, info, and gimp.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'Desktop GUI or GIMP action',
      },
      x: { type: 'number', description: 'Screen X coordinate (click, move, scroll)' },
      y: { type: 'number', description: 'Screen Y coordinate (click, move, scroll)' },
      text: { type: 'string', description: 'Text to type (type)' },
      key: { type: 'string', description: 'Key name to press (key, press)' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Hotkey combination (hotkey)' },
      amount: { type: 'number', description: 'Scroll delta (scroll)' },
      title: { type: 'string', description: 'Window title substring (focus_window)' },
      path: { type: 'string', description: 'Output file path (screenshot) or image path (gimp)' },
      gimp_action: {
        type: 'string',
        enum: ['version', 'open', 'export', 'pdb_call', 'new_image', 'image_info', 'list_procedures', 'flatten'],
        description: 'GIMP sub-action when action="gimp"',
      },
      image_id: { type: 'number', description: 'GIMP image id (action=gimp)' },
      procedure: { type: 'string', description: 'GIMP PDB procedure (action=gimp)' },
      args: { type: 'array', items: {}, description: 'GIMP PDB positional args (action=gimp)' },
      width: { type: 'number', description: 'Image width (action=gimp new_image)' },
      height: { type: 'number', description: 'Image height (action=gimp new_image)' },
    },
    required: ['action'],
  },
  handler: async (args: any = {}): Promise<ToolResult> => {
    const action = String(args.action || 'info').trim().toLowerCase();

    if (action === 'gimp') {
      const sub = args.gimp_action || args.sub_action || 'version';
      return gimpTool.handler({ ...args, action: sub });
    }

    if (action === 'info') {
      return envelope(
        {
          platform: process.platform,
          arch: process.arch,
          display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || (process.platform === 'darwin' ? 'quartz' : null),
        },
        'info',
      );
    }

    try {
      if (action === 'screenshot') {
        const dir = path.join(os.homedir(), '.hanzo', 'screenshots');
        await fs.mkdir(dir, { recursive: true });
        const outPath = args.path || path.join(dir, `screen-${Date.now()}.png`);
        if (process.platform === 'darwin') {
          await execFileAsync('screencapture', ['-x', outPath]);
        } else {
          await execFileAsync('import', ['-window', 'root', outPath]).catch(async () => {
            await execFileAsync('scrot', [outPath]);
          });
        }
        return envelope({ path: outPath }, 'screenshot');
      }

      if (process.platform === 'linux') {
        switch (action) {
          case 'move':
            await execFileAsync('xdotool', ['mousemove', String(args.x ?? 0), String(args.y ?? 0)]);
            return envelope({ x: args.x, y: args.y }, 'move');
          case 'click':
          case 'double_click':
          case 'right_click': {
            if (args.x !== undefined && args.y !== undefined) {
              await execFileAsync('xdotool', ['mousemove', String(args.x), String(args.y)]);
            }
            const btn = action === 'right_click' ? '3' : '1';
            const cmdArgs = action === 'double_click' ? ['click', '--repeat', '2', btn] : ['click', btn];
            await execFileAsync('xdotool', cmdArgs);
            return envelope({ action, x: args.x, y: args.y }, action);
          }
          case 'type':
            if (!args.text) return fail('type', 'INVALID_ARGS', 'text required');
            await execFileAsync('xdotool', ['type', '--clearmodifiers', '--', String(args.text)]);
            return envelope({ typed: String(args.text).length }, 'type');
          case 'key':
          case 'press':
            if (!args.key) return fail(action, 'INVALID_ARGS', 'key required');
            await execFileAsync('xdotool', ['key', String(args.key)]);
            return envelope({ key: args.key }, action);
          case 'hotkey':
            if (!Array.isArray(args.keys) || !args.keys.length) return fail('hotkey', 'INVALID_ARGS', 'keys required');
            await execFileAsync('xdotool', ['key', args.keys.join('+')]);
            return envelope({ keys: args.keys }, 'hotkey');
          case 'window':
          case 'list_windows': {
            const { stdout } = await execFileAsync('wmctrl', ['-l']).catch(() => ({ stdout: '' }));
            return envelope({ windows: stdout.split('\n').filter(Boolean) }, action);
          }
          case 'focus_window':
            if (!args.title) return fail('focus_window', 'INVALID_ARGS', 'title required');
            await execFileAsync('wmctrl', ['-a', String(args.title)]);
            return envelope({ focused: args.title }, 'focus_window');
        }
      }

      return fail(action, 'UNSUPPORTED', `Desktop action "${action}" requires native hanzo-mcp or X11/macOS automation tools`);
    } catch (e: any) {
      return fail(action, 'EXEC_ERROR', e?.message || String(e));
    }
  },
};

export const computerTools: Tool[] = [computerTool];
