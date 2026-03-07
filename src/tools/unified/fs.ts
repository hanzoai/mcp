/**
 * fs — Unified filesystem tool (HIP-0300)
 *
 * One tool for the Bytes + Paths axis.
 * Actions: read, write, stat, list, mkdir, rm, mv, apply_patch, search_text
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import { Tool } from '../../types/index.js';

const execAsync = promisify(exec);

function contentHash(content: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function envelope(data: any, action: string, paging?: any) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'fs', action, paging: paging || { cursor: null, more: false } } }, null, 2) }]
  };
}

function fail(code: string, message: string, details?: any) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message, ...details }, meta: { tool: 'fs' } }, null, 2) }],
    isError: true
  };
}

export const fsTool: Tool = {
  name: 'fs',
  description: 'Filesystem operations: read, write, stat, list, mkdir, rm, mv, apply_patch, search_text',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'stat', 'list', 'mkdir', 'rm', 'mv', 'apply_patch', 'search_text'], description: 'Filesystem action' },
      uri: { type: 'string', description: 'File or directory path' },
      content: { type: 'string', description: 'Content for write' },
      encoding: { type: 'string', default: 'utf8' },
      depth: { type: 'number', description: 'List depth', default: 1 },
      pattern: { type: 'string', description: 'Glob pattern for list or search' },
      show_hidden: { type: 'boolean', default: false },
      patch: { type: 'string', description: 'Patch content (old_text for simple replace)' },
      new_text: { type: 'string', description: 'Replacement text for apply_patch' },
      base_hash: { type: 'string', description: 'Content hash precondition for apply_patch' },
      edits: { type: 'array', description: 'Array of {old_text, new_text} for multi-edit patch', items: { type: 'object' } },
      confirm: { type: 'boolean', description: 'Required for rm', default: false },
      destination: { type: 'string', description: 'Destination for mv' },
      overwrite: { type: 'boolean', default: false },
      query: { type: 'string', description: 'Search pattern for search_text' },
      ignore_case: { type: 'boolean', default: false },
      context_lines: { type: 'number', default: 0 },
      max_results: { type: 'number', default: 50 },
      offset: { type: 'number', description: 'Line offset for read' },
      limit: { type: 'number', description: 'Line limit for read' },
      recursive: { type: 'boolean', default: false },
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const uri = args.uri || args.path || '.';

      switch (args.action) {
        case 'read': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri required');
          const raw = await fs.readFile(uri, (args.encoding || 'utf8') as BufferEncoding);
          const text = raw.toString();
          const hash = contentHash(text);
          const lines = text.split('\n');
          let content = text;
          if (args.offset || args.limit) {
            const start = args.offset || 0;
            const end = args.limit ? start + args.limit : lines.length;
            content = lines.slice(start, end).join('\n');
          }
          return envelope({ uri, content, hash, lines: lines.length, size: Buffer.byteLength(text) }, 'read');
        }

        case 'write': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri required');
          if (args.content === undefined) return fail('INVALID_PARAMS', 'content required');
          if (!args.overwrite) {
            try { await fs.access(uri); return fail('CONFLICT', 'File exists. Use overwrite: true or apply_patch to edit.'); } catch {}
          }
          await fs.mkdir(path.dirname(uri), { recursive: true });
          await fs.writeFile(uri, args.content, (args.encoding || 'utf8') as BufferEncoding);
          const hash = contentHash(args.content);
          return envelope({ uri, hash, size: Buffer.byteLength(args.content) }, 'write');
        }

        case 'stat': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri required');
          const stats = await fs.stat(uri);
          let hash: string | undefined;
          if (stats.isFile()) { hash = contentHash(await fs.readFile(uri, 'utf8')); }
          return envelope({
            uri, size: stats.size, hash,
            is_file: stats.isFile(), is_dir: stats.isDirectory(),
            mtime: stats.mtime.toISOString(), mode: stats.mode.toString(8)
          }, 'stat');
        }

        case 'list': {
          const depth = args.depth || 1;
          if (args.pattern) {
            const globPattern = path.join(uri, args.pattern);
            const files = await glob(globPattern, { ignore: ['**/node_modules/**', '**/.git/**'] });
            return envelope({ uri, entries: files, count: files.length }, 'list');
          }
          if (depth === 1) {
            const entries = await fs.readdir(uri, { withFileTypes: true });
            const filtered = args.show_hidden ? entries : entries.filter(e => !e.name.startsWith('.'));
            const items = filtered.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
            return envelope({ uri, entries: items, count: items.length }, 'list');
          }
          // Tree view for depth > 1
          const buildTree = async (dir: string, prefix = '', d = 0): Promise<string> => {
            if (d >= depth) return '';
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const filtered = args.show_hidden ? entries : entries.filter(e => !e.name.startsWith('.'));
            let tree = '';
            for (let i = 0; i < filtered.length; i++) {
              const e = filtered[i];
              const last = i === filtered.length - 1;
              tree += prefix + (last ? '└── ' : '├── ') + e.name + '\n';
              if (e.isDirectory()) tree += await buildTree(path.join(dir, e.name), prefix + (last ? '    ' : '│   '), d + 1);
            }
            return tree;
          };
          const tree = uri + '\n' + await buildTree(uri);
          return envelope({ uri, tree, depth }, 'list');
        }

        case 'mkdir': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri required');
          await fs.mkdir(uri, { recursive: true });
          return envelope({ uri }, 'mkdir');
        }

        case 'rm': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri required');
          if (!args.confirm) return fail('CONFIRM_REQUIRED', 'rm requires confirm: true');
          const stats = await fs.stat(uri);
          if (stats.isDirectory()) {
            await fs.rm(uri, { recursive: args.recursive !== false, force: true });
          } else {
            await fs.unlink(uri);
          }
          return envelope({ uri, removed: true }, 'rm');
        }

        case 'mv': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri required');
          if (!args.destination) return fail('INVALID_PARAMS', 'destination required');
          if (!args.overwrite) {
            try { await fs.access(args.destination); return fail('CONFLICT', 'Destination exists. Use overwrite: true.'); } catch {}
          }
          await fs.mkdir(path.dirname(args.destination), { recursive: true });
          await fs.rename(uri, args.destination);
          return envelope({ from: uri, to: args.destination }, 'mv');
        }

        case 'apply_patch': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri required');
          let content = await fs.readFile(uri, 'utf8');
          const currentHash = contentHash(content);

          // base_hash precondition
          if (args.base_hash && args.base_hash !== currentHash) {
            return fail('CONFLICT', 'base_hash mismatch — file changed since read', { expected: args.base_hash, actual: currentHash });
          }

          // Multi-edit mode
          if (args.edits && Array.isArray(args.edits)) {
            const results: string[] = [];
            for (const edit of args.edits) {
              if (!content.includes(edit.old_text || edit.oldText)) {
                results.push(`MISS: "${(edit.old_text || edit.oldText || '').substring(0, 40)}..."`);
                continue;
              }
              content = content.replace(edit.old_text || edit.oldText, edit.new_text || edit.newText);
              results.push(`OK: replaced ${(edit.old_text || edit.oldText || '').substring(0, 30)}...`);
            }
            await fs.writeFile(uri, content, 'utf8');
            return envelope({ uri, hash: contentHash(content), edits: results }, 'apply_patch');
          }

          // Single edit mode
          const oldText = args.patch || args.old_text || args.oldText;
          const newText = args.new_text || args.newText;
          if (!oldText || newText === undefined) return fail('INVALID_PARAMS', 'patch (old_text) and new_text required, or edits array');

          if (!content.includes(oldText)) return fail('NOT_FOUND', 'patch text not found in file');
          const count = content.split(oldText).length - 1;
          if (count > 1) return fail('AMBIGUOUS', `patch text found ${count} times — include more context`);

          content = content.replace(oldText, newText);
          await fs.writeFile(uri, content, 'utf8');
          return envelope({ uri, hash: contentHash(content) }, 'apply_patch');
        }

        case 'search_text': {
          const query = args.query || args.pattern;
          if (!query) return fail('INVALID_PARAMS', 'query required');
          let hasRg = false;
          try { await execAsync('which rg'); hasRg = true; } catch {}

          let cmd: string;
          if (hasRg) {
            cmd = `rg -n --max-count ${args.max_results || 50}`;
            if (args.ignore_case) cmd += ' -i';
            if (args.context_lines) cmd += ` -C ${args.context_lines}`;
            if (args.pattern && args.pattern !== query) cmd += ` -g "${args.pattern}"`;
            cmd += ` "${query}" "${uri}"`;
          } else {
            cmd = `grep -rn`;
            if (args.ignore_case) cmd += ' -i';
            if (args.context_lines) cmd += ` -C ${args.context_lines}`;
            cmd += ` "${query}" "${uri}" | head -${args.max_results || 50}`;
          }

          try {
            const { stdout } = await execAsync(cmd);
            const lines = stdout.trim().split('\n').filter(Boolean);
            return envelope({ query, matches: lines, count: lines.length, backend: hasRg ? 'ripgrep' : 'grep' }, 'search_text');
          } catch (e: any) {
            if (e.code === 1) return envelope({ query, matches: [], count: 0, backend: hasRg ? 'ripgrep' : 'grep' }, 'search_text');
            throw e;
          }
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`, { available: ['read', 'write', 'stat', 'list', 'mkdir', 'rm', 'mv', 'apply_patch', 'search_text'] });
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') return fail('NOT_FOUND', `Not found: ${args.uri || args.path}`);
      if (error.code === 'EACCES') return fail('PERMISSION_DENIED', error.message);
      return fail('ERROR', error.message);
    }
  }
};
