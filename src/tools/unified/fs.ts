/**
 * fs — the filesystem on one axis (HIP-0300), with python-sdk
 * `hanzo_tools.fs.FsTool`'s contract: the same actions, the same parameters
 * (`uri`, `path` accepted for it), the same answers in the unified
 * `{ok, data, error, meta}` envelope.
 *
 * Every file answer carries its content hash (`sha256:<hex>`), and
 * `apply_patch` — the one way to edit an existing file — takes that hash as its
 * precondition, so an edit made against a stale read is refused. `write` only
 * creates.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { minimatch } from 'minimatch';
import { Tool, ToolResult } from '../../types/index.js';

const ACTIONS: Record<string, string> = {
  read: 'Read file contents (returns hash)',
  write: 'Create new files only',
  stat: 'File metadata including hash',
  list: 'Directory listing',
  apply_patch: 'Edit with base_hash precondition',
  patch: 'Apply Rust-style patch format (Rust parity)',
  search_text: 'Text search',
  mv: 'Move or rename file/directory',
  mkdir: 'Create directory',
  rm: 'Remove (requires confirm=true)',
};

const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function contentHash(b: string | Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
}

const fileUri = (p: string) => 'file://' + path.resolve(p);

class Refused extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function envelope(action: string, data: unknown, image?: { data: string; mimeType: string }): ToolResult {
  const text = JSON.stringify({ ok: true, data, error: null, meta: { tool: 'fs', action } }, null, 2);
  return { content: [{ type: 'text', text }, ...(image ? [{ type: 'image' as const, ...image }] : [])] };
}

function fail(action: string, code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'fs', action } }, null, 2) }],
    isError: true,
  };
}

/** An absolute path from `uri`, `file://` stripped. */
function need(uri: unknown): string {
  if (typeof uri !== 'string' || !uri) throw new Refused('INVALID_PARAMS', 'Path is required');
  const p = uri.startsWith('file://') ? uri.slice(7) : uri;
  if (!path.isAbsolute(p)) throw new Refused('INVALID_PARAMS', 'Path must be absolute');
  return p;
}

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

async function read(a: any) {
  const p = need(a.uri);
  const st = await fs.stat(p).catch(() => { throw new Refused('NOT_FOUND', `File not found: ${p}`); });
  if (!st.isFile()) throw new Refused('INVALID_PARAMS', `Not a file: ${p}`);
  const raw = await fs.readFile(p);
  const mime = IMAGES[path.extname(p).toLowerCase()];
  // An image is pixels, not text: it goes back as an MCP image block.
  if (mime) return envelope('read', { uri: fileUri(p), hash: contentHash(raw), mime, size: raw.length }, { data: raw.toString('base64'), mimeType: mime });
  const lines = raw.toString('utf8').split(/(?<=\n)/).filter((l, i, all) => l !== '' || i < all.length - 1);
  const offset = a.offset ?? 0, limit = a.limit ?? 2000;
  const text = lines.slice(offset, offset + limit).map((l, i) => {
    let s = l.replace(/\r?\n$/, '');
    if (s.length > 2000) s = s.slice(0, 2000) + '...';
    return `${String(offset + i + 1).padStart(6)}│${s}`;
  }).join('\n');
  return envelope('read', { uri: fileUri(p), text, hash: contentHash(raw), total_lines: lines.length, offset, limit });
}

async function write(a: any) {
  const p = need(a.uri);
  if (typeof a.content !== 'string') throw new Refused('INVALID_PARAMS', 'content required');
  if (await exists(p)) throw new Refused('CONFLICT', `File already exists: ${p}. Use apply_patch to edit.`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, a.content, 'utf8');
  return envelope('write', { uri: fileUri(p), hash: contentHash(a.content), size: Buffer.byteLength(a.content) });
}

async function stat(a: any) {
  const p = need(a.uri);
  const st = await fs.stat(p).catch(() => { throw new Refused('NOT_FOUND', `File not found: ${p}`); });
  return envelope('stat', {
    uri: fileUri(p), size: st.size, hash: st.isFile() ? contentHash(await fs.readFile(p)) : null,
    mtime: st.mtime.toISOString(), is_file: st.isFile(), is_dir: st.isDirectory(),
  });
}

async function list(a: any) {
  const p = need(a.uri);
  const st = await fs.stat(p).catch(() => { throw new Refused('NOT_FOUND', `Directory not found: ${p}`); });
  if (!st.isDirectory()) throw new Refused('INVALID_PARAMS', `Not a directory: ${p}`);
  const depth = Math.max(1, a.depth ?? 1), limit = a.limit ?? 100, start = Number(a.cursor ?? 0) || 0;
  const entries: unknown[] = [];
  let total = 0;
  // Sorted within each directory, each entry before its children; an entry
  // the pattern refuses is skipped with everything under it.
  const walk = async (dir: string, level: number) => {
    let names: string[];
    try { names = (await fs.readdir(dir)).sort(); } catch { return; }
    for (const name of names) {
      if (a.pattern && !minimatch(name, a.pattern, { dot: true })) continue;
      const full = path.join(dir, name);
      const s = await fs.stat(full).catch(() => null);
      total++;
      if (total > start && entries.length < limit) {
        entries.push({ name: path.relative(p, full), uri: fileUri(full), is_dir: !!s?.isDirectory(), size: s?.isFile() ? s.size : null });
      }
      if (s?.isDirectory() && level < depth) await walk(full, level + 1);
    }
  };
  await walk(p, 1);
  const more = total > start + entries.length;
  return envelope('list', { uri: fileUri(p), entries, paging: { cursor: more ? String(start + entries.length) : null, more, total } });
}

async function applyPatch(a: any) {
  const p = need(a.uri);
  if (typeof a.old_text !== 'string' || typeof a.new_text !== 'string') throw new Refused('INVALID_PARAMS', 'old_text and new_text required');
  if (!a.base_hash) throw new Refused('INVALID_PARAMS', 'base_hash required: read the file first');
  const content = await fs.readFile(p, 'utf8').catch(() => { throw new Refused('NOT_FOUND', `File not found: ${p}`); });
  const current = contentHash(content);
  if (current !== a.base_hash) {
    throw new Refused('CONFLICT', `File has changed since last read (base_hash mismatch): expected ${a.base_hash}, actual ${current}`);
  }
  const count = content.split(a.old_text).length - 1;
  if (count === 0) throw new Refused('NOT_FOUND', 'old_text not found in file');
  if (count > 1) throw new Refused('INVALID_PARAMS', `old_text found ${count} times. Make it more specific.`);
  const next = content.replace(a.old_text, () => a.new_text);
  await fs.writeFile(p, next, 'utf8');
  return envelope('apply_patch', { uri: fileUri(p), hash: contentHash(next), previous_hash: current });
}

interface PatchFile { op: 'add' | 'update' | 'delete'; path: string; hunks: { old: string[]; new: string[] }[]; content: string }

/** Parse `*** Begin Patch` / `*** Add|Update|Delete File:` / `@@` / `-old` `+new`. */
export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchFile['hunks'][number] | null = null;
  const close = () => { if (file) { if (hunk) file.hunks.push(hunk); files.push(file); } file = null; hunk = null; };
  for (const line of text.trim().split('\n')) {
    if (line.trim() === '*** Begin Patch' || line.trim() === '*** End Patch') continue;
    const m = /^\*\*\* (Add|Update|Delete) File:(.*)$/.exec(line);
    if (m) {
      close();
      file = { op: m[1].toLowerCase() as PatchFile['op'], path: m[2].trim(), hunks: [], content: '' };
      continue;
    }
    const f = file as PatchFile | null;
    if (!f) continue;
    if (line.startsWith('@@')) {
      if (hunk) f.hunks.push(hunk);
      hunk = { old: [], new: [] };
    } else if (f.op === 'add') {
      f.content += (line.startsWith('+') ? line.slice(1) : line) + '\n';
    } else if (hunk) {
      if (line.startsWith('-')) hunk.old.push(line.slice(1));
      else if (line.startsWith('+')) hunk.new.push(line.slice(1));
      else if (line.startsWith(' ')) { hunk.old.push(line.slice(1)); hunk.new.push(line.slice(1)); }
    }
  }
  close();
  return files;
}

async function patch(a: any) {
  if (typeof a.input !== 'string' || !a.input.trim()) throw new Refused('INVALID_PARAMS', 'Patch input is required');
  const files = parsePatch(a.input);
  if (!files.length) throw new Refused('INVALID_PARAMS', 'No file operations found in patch');
  const results: Record<string, unknown>[] = [];
  for (const f of files) {
    const p = path.resolve(f.path);
    try {
      if (f.op === 'add') {
        if (await exists(p)) throw new Error(`File already exists: ${p}`);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, f.content, 'utf8');
        results.push({ op: 'add', path: p, hash: contentHash(f.content), success: true });
      } else if (f.op === 'update') {
        let content = await fs.readFile(p, 'utf8').catch(() => { throw new Error(`File not found: ${p}`); });
        for (const h of f.hunks) {
          const [o, n] = [h.old.join('\n'), h.new.join('\n')];
          if (o && content.includes(o)) content = content.replace(o, () => n);
          else if (!o && n) content += '\n' + n;
        }
        await fs.writeFile(p, content, 'utf8');
        results.push({ op: 'update', path: p, hash: contentHash(content), hunks_applied: f.hunks.length, success: true });
      } else if (!(await exists(p))) {
        results.push({ op: 'delete', path: p, success: true, message: 'File already deleted' });
      } else {
        await fs.unlink(p);
        results.push({ op: 'delete', path: p, success: true });
      }
    } catch (e: any) {
      results.push({ op: f.op, path: p, success: false, error: e.message });
    }
  }
  return envelope('patch', { results, total: results.length, success: results.every((r) => r.success) });
}

/** ripgrep's matches, or null when rg is not installed. No shell: the pattern is an argument. */
function rg(pattern: string, root: string, glob: string | undefined, limit: number): Promise<unknown[] | null> {
  const args = ['--json', '-n', '--max-count', String(limit * 2), ...(glob ? ['--glob', glob] : []), '--', pattern, root];
  return new Promise((resolve) => {
    execFile('rg', args, { maxBuffer: 64 << 20 }, (err: any, stdout) => {
      if (err?.code === 'ENOENT') return resolve(null);
      const out: unknown[] = [];
      for (const line of stdout.split('\n')) {
        if (out.length >= limit) break;
        try {
          const v = JSON.parse(line);
          if (v.type === 'match') out.push({ uri: fileUri(v.data.path.text), line: v.data.line_number, text: String(v.data.lines.text ?? '').trim() });
        } catch { /* not a JSON line */ }
      }
      resolve(out);
    });
  });
}

/** The same search in-process: a regex over every file under `root`. */
async function scan(pattern: string, root: string, glob: string | undefined, limit: number): Promise<unknown[]> {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (e: any) { throw new Refused('INVALID_PARAMS', `Invalid regex: ${e.message}`); }
  const out: unknown[] = [];
  const visit = async (p: string): Promise<void> => {
    if (out.length >= limit) return;
    const s = await fs.stat(p).catch(() => null);
    if (s?.isDirectory()) {
      for (const n of (await fs.readdir(p).catch(() => [] as string[])).sort()) await visit(path.join(p, n));
      return;
    }
    if (!s?.isFile() || (glob && !minimatch(path.basename(p), glob, { dot: true }))) return;
    const text = await fs.readFile(p, 'utf8').catch(() => '');
    text.split('\n').forEach((l, i) => {
      if (out.length < limit && re.test(l)) out.push({ uri: fileUri(p), line: i + 1, text: l.trim().slice(0, 200) });
    });
  };
  await visit(root);
  return out;
}

async function searchText(a: any) {
  if (!a.pattern) throw new Refused('INVALID_PARAMS', 'pattern required');
  const root = a.uri ? need(a.uri) : '.';
  const limit = a.limit ?? 50, start = Number(a.cursor ?? 0) || 0;
  const matches = (await rg(a.pattern, root, a.glob, limit)) ?? (await scan(a.pattern, root, a.glob, limit));
  const more = matches.length >= limit;
  return envelope('search_text', { pattern: a.pattern, matches, paging: { cursor: more ? String(start + matches.length) : null, more } });
}

async function mv(a: any) {
  const src = need(a.uri), dst = need(a.destination);
  if (!(await exists(src))) throw new Refused('NOT_FOUND', `Source not found: ${src}`);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  return envelope('mv', { source: fileUri(src), destination: fileUri(dst), moved: true });
}

async function mkdir(a: any) {
  const p = need(a.uri);
  const st = await fs.stat(p).catch(() => null);
  if (st?.isDirectory()) return envelope('mkdir', { uri: fileUri(p), created: false });
  if (st) throw new Refused('CONFLICT', `Path exists and is not a directory: ${p}`);
  await fs.mkdir(p, { recursive: true });
  return envelope('mkdir', { uri: fileUri(p), created: true });
}

async function rm(a: any) {
  if (a.confirm !== true) throw new Refused('INVALID_PARAMS', 'rm requires confirm=true for safety');
  const p = need(a.uri);
  if (!(await exists(p))) throw new Refused('NOT_FOUND', `Path not found: ${p}`);
  await fs.rm(p, { recursive: true, force: true });
  return envelope('rm', { uri: fileUri(p), removed: true });
}

const HANDLERS: Record<string, (a: any) => Promise<ToolResult>> = {
  read, write, stat, list, apply_patch: applyPatch, patch, search_text: searchText, mv, mkdir, rm,
};

export const fsTool: Tool = {
  name: 'fs',
  description: `Unified filesystem tool (HIP-0300).

Actions:
- read: Read file contents (returns hash)
- write: Create new files only
- stat: File metadata including hash
- list: Directory listing
- apply_patch: Edit with base_hash precondition
- patch: Apply Rust-style patch format (Rust parity)
- search_text: Text search
- mkdir: Create directory
- rm: Remove (requires confirm=true)

IMPORTANT: apply_patch is the ONLY way to edit existing files.
patch supports Rust grammar format: *** Begin Patch / *** Update File: / @@ / -old +new`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...Object.keys(ACTIONS), 'help'], default: 'help' },
      uri: { type: 'string', description: 'Absolute path or file:// URI (path is accepted too)' },
      content: { type: 'string', description: "write: the new file's content" },
      offset: { type: 'number', description: 'read: first line, 0-based', default: 0 },
      limit: { type: 'number', description: 'read: lines (2000); list: entries (100); search_text: matches (50)' },
      cursor: { type: 'string', description: 'list/search_text: the page after this cursor' },
      depth: { type: 'number', description: 'list: levels', default: 1 },
      pattern: { type: 'string', description: 'list: name glob; search_text: regex' },
      glob: { type: 'string', description: 'search_text: file glob' },
      old_text: { type: 'string', description: 'apply_patch: the unique text to replace' },
      new_text: { type: 'string', description: 'apply_patch: its replacement' },
      base_hash: { type: 'string', description: 'apply_patch: the hash read returned' },
      input: { type: 'string', description: 'patch: *** Begin Patch … *** End Patch' },
      destination: { type: 'string', description: 'mv: where to' },
      confirm: { type: 'boolean', description: 'rm: required', default: false },
    },
    required: ['action'],
  },
  handler: async (args: any) => {
    const action: string = args.action || 'help';
    const a = { ...args, uri: args.uri ?? args.path };
    if (action === 'help') {
      return envelope('help', { tool: 'fs', actions: Object.entries(ACTIONS).map(([name, description]) => ({ name, description })) });
    }
    const run = HANDLERS[action];
    if (!run) return fail(action, 'INVALID_PARAMS', `Unknown action '${action}'. Available: ${Object.keys(ACTIONS).join(', ')}`);
    try {
      return await run(a);
    } catch (e: any) {
      if (e instanceof Refused) return fail(action, e.code, e.message);
      if (e.code === 'ENOENT') return fail(action, 'NOT_FOUND', e.message);
      return fail(action, 'INTERNAL_ERROR', e.message);
    }
  },
};
