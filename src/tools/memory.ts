/**
 * Memory tool — single tool, action-routed persistent store/recall
 * store, recall, list, delete, search, stats, clear, export, import, merge, tag, untag
 */

import { Tool } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

interface Entry { id: string; key: string; value: string; tags: string[]; namespace: string; created: string; updated: string; metadata?: Record<string, any>; ttl?: string; }
interface Store { entries: Entry[]; lastId: number; }

const storePath = () => process.env.MEMORY_PATH || path.join(os.homedir(), '.hanzo', 'memory.json');
async function load(): Promise<Store> { try { return JSON.parse(await fs.readFile(storePath(), 'utf-8')); } catch { return { entries: [], lastId: 0 }; } }
async function save(s: Store) { await fs.mkdir(path.dirname(storePath()), { recursive: true }); await fs.writeFile(storePath(), JSON.stringify(s, null, 2)); }

function isExpired(e: Entry): boolean {
  if (!e.ttl) return false;
  return new Date(e.ttl) < new Date();
}

export const memoryTool: Tool = {
  name: 'memory',
  description: 'Persistent key-value memory with search, tags, namespaces, TTL: store, recall, list, delete, search, stats, clear, export, import, merge, tag, untag, namespaces, history',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'store', 'recall', 'list', 'delete',
        'search', 'stats', 'clear',
        'export', 'import', 'merge',
        'tag', 'untag', 'namespaces', 'history'
      ], description: 'Memory action' },
      key: { type: 'string', description: 'Memory key' },
      value: { type: 'string', description: 'Content to store' },
      query: { type: 'string', description: 'Search query (full-text across keys, values, tags)' },
      tag: { type: 'string', description: 'Filter/assign tag' },
      tags: { type: 'array', items: { type: 'string' } },
      namespace: { type: 'string', default: 'default' },
      metadata: { type: 'object' },
      ttl: { type: 'string', description: 'Expiry ISO date (auto-delete after)' },
      limit: { type: 'number', default: 50 },
      file: { type: 'string', description: 'File path for export/import' },
      data: { type: 'object', description: 'Key-value map for bulk import' },
      append: { type: 'boolean', description: 'Append to existing value', default: false },
      sort: { type: 'string', enum: ['key', 'created', 'updated', 'namespace'], default: 'updated' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const ns = args.namespace || 'default';
      const store = await load();
      // Clean expired entries
      store.entries = store.entries.filter(e => !isExpired(e));

      switch (args.action) {
        case 'store': {
          if (!args.key || !args.value) return { content: [{ type: 'text', text: 'key and value required' }], isError: true };
          const now = new Date().toISOString();
          const idx = store.entries.findIndex(e => e.key === args.key && e.namespace === ns);
          if (idx >= 0) {
            const e = store.entries[idx];
            e.value = args.append ? e.value + '\n' + args.value : args.value;
            e.updated = now;
            if (args.tags) e.tags = args.tags;
            if (args.metadata) e.metadata = { ...e.metadata, ...args.metadata };
            if (args.ttl) e.ttl = args.ttl;
            await save(store);
            return { content: [{ type: 'text', text: `Updated: ${args.key} (${e.value.length} chars)` }] };
          }
          store.lastId++;
          store.entries.push({ id: String(store.lastId), key: args.key, value: args.value, tags: args.tags || [], namespace: ns, created: now, updated: now, metadata: args.metadata, ttl: args.ttl });
          await save(store);
          return { content: [{ type: 'text', text: `Stored: ${args.key} (${args.value.length} chars)` }] };
        }

        case 'recall': {
          let r = store.entries.filter(e => e.namespace === ns || !args.namespace);
          if (args.key) r = r.filter(e => e.key === args.key);
          if (args.tag) r = r.filter(e => e.tags.includes(args.tag));
          r = r.slice(0, args.limit || 10);
          if (!r.length) return { content: [{ type: 'text', text: 'No memories found' }] };
          const out = r.map(e => `[${e.namespace}] ${e.key}${e.tags.length ? ` [${e.tags.join(', ')}]` : ''} (${e.updated.split('T')[0]}):\n  ${e.value.substring(0, 300)}${e.value.length > 300 ? '...' : ''}`);
          return { content: [{ type: 'text', text: out.join('\n\n') }] };
        }

        case 'list': {
          let entries = store.entries;
          if (args.namespace) entries = entries.filter(e => e.namespace === ns);
          if (args.tag) entries = entries.filter(e => e.tags.includes(args.tag));
          // Sort
          const sortKey = args.sort || 'updated';
          entries.sort((a, b) => {
            if (sortKey === 'key') return a.key.localeCompare(b.key);
            if (sortKey === 'namespace') return a.namespace.localeCompare(b.namespace);
            return (b[sortKey as 'created' | 'updated'] || '').localeCompare(a[sortKey as 'created' | 'updated'] || '');
          });
          const limited = entries.slice(0, args.limit || 50);
          const namespaces = [...new Set(store.entries.map(e => e.namespace))];
          const out = [`${store.entries.length} entries, namespaces: [${namespaces.join(', ')}]`, ''];
          for (const e of limited) out.push(`  ${e.key}${e.tags.length ? ` [${e.tags.join(',')}]` : ''} (${e.namespace}) ${e.value.length}ch`);
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'delete': {
          if (!args.key && !args.tag) return { content: [{ type: 'text', text: 'key or tag required' }], isError: true };
          let count = 0;
          if (args.key) {
            const i = store.entries.findIndex(e => e.key === args.key && e.namespace === ns);
            if (i < 0) return { content: [{ type: 'text', text: `Not found: ${args.key}` }], isError: true };
            store.entries.splice(i, 1);
            count = 1;
          } else if (args.tag) {
            const before = store.entries.length;
            store.entries = store.entries.filter((e: Entry) => !e.tags.includes(args.tag));
            count = before - store.entries.length;
          }
          await save(store);
          return { content: [{ type: 'text', text: `Deleted ${count} entries` }] };
        }

        case 'search': {
          if (!args.query) return { content: [{ type: 'text', text: 'query required' }], isError: true };
          const q = args.query.toLowerCase();
          const terms = q.split(/\s+/);
          let results = store.entries.filter(e => {
            const text = `${e.key} ${e.value} ${e.tags.join(' ')} ${e.namespace}`.toLowerCase();
            return terms.every((t: string) => text.includes(t));
          });
          if (args.namespace) results = results.filter(e => e.namespace === ns);
          if (args.tag) results = results.filter(e => e.tags.includes(args.tag));
          results = results.slice(0, args.limit || 20);
          if (!results.length) return { content: [{ type: 'text', text: `No results for: ${args.query}` }] };
          const out = results.map(e => `[${e.namespace}] ${e.key}${e.tags.length ? ` [${e.tags.join(',')}]` : ''}:\n  ${e.value.substring(0, 200)}${e.value.length > 200 ? '...' : ''}`);
          return { content: [{ type: 'text', text: `Found ${results.length}:\n\n${out.join('\n\n')}` }] };
        }

        case 'stats': {
          const namespaces = [...new Set(store.entries.map(e => e.namespace))];
          const tags = [...new Set(store.entries.flatMap(e => e.tags))];
          const totalSize = store.entries.reduce((s, e) => s + e.value.length, 0);
          const byNs: Record<string, number> = {};
          for (const e of store.entries) byNs[e.namespace] = (byNs[e.namespace] || 0) + 1;
          return { content: [{ type: 'text', text: `Memory Stats:\n  Entries: ${store.entries.length}\n  Size: ${(totalSize / 1024).toFixed(1)}KB\n  Namespaces: ${namespaces.join(', ')}\n  Tags: ${tags.join(', ')}\n  By namespace: ${Object.entries(byNs).map(([k, v]) => `${k}:${v}`).join(' ')}` }] };
        }

        case 'clear': {
          const before = store.entries.length;
          if (args.namespace) {
            store.entries = store.entries.filter(e => e.namespace !== ns);
          } else {
            store.entries = [];
          }
          await save(store);
          return { content: [{ type: 'text', text: `Cleared ${before - store.entries.length} entries${args.namespace ? ` from namespace: ${ns}` : ''}` }] };
        }

        case 'export': {
          const filePath = args.file || path.join(os.homedir(), '.hanzo', 'memory-export.json');
          let entries = store.entries;
          if (args.namespace) entries = entries.filter(e => e.namespace === ns);
          if (args.tag) entries = entries.filter(e => e.tags.includes(args.tag));
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, JSON.stringify(entries, null, 2));
          return { content: [{ type: 'text', text: `Exported ${entries.length} entries to ${filePath}` }] };
        }

        case 'import': {
          if (args.data) {
            // Bulk import from key-value map
            const now = new Date().toISOString();
            for (const [k, v] of Object.entries(args.data)) {
              store.lastId++;
              store.entries.push({ id: String(store.lastId), key: k, value: String(v), tags: args.tags || [], namespace: ns, created: now, updated: now });
            }
            await save(store);
            return { content: [{ type: 'text', text: `Imported ${Object.keys(args.data).length} entries` }] };
          }
          if (!args.file) return { content: [{ type: 'text', text: 'file or data required' }], isError: true };
          const imported: Entry[] = JSON.parse(await fs.readFile(args.file, 'utf-8'));
          for (const e of imported) {
            store.lastId++;
            e.id = String(store.lastId);
            store.entries.push(e);
          }
          await save(store);
          return { content: [{ type: 'text', text: `Imported ${imported.length} entries from ${args.file}` }] };
        }

        case 'merge': {
          if (!args.key) return { content: [{ type: 'text', text: 'key required' }], isError: true };
          const entries = store.entries.filter(e => e.key === args.key);
          if (entries.length < 2) return { content: [{ type: 'text', text: `Only ${entries.length} entries with key '${args.key}', nothing to merge` }] };
          const merged = entries.map(e => e.value).join('\n---\n');
          const allTags = [...new Set(entries.flatMap(e => e.tags))];
          const keep = entries[0];
          keep.value = merged;
          keep.tags = allTags;
          keep.updated = new Date().toISOString();
          store.entries = store.entries.filter(e => e.key !== args.key || e.id === keep.id);
          await save(store);
          return { content: [{ type: 'text', text: `Merged ${entries.length} entries into key '${args.key}'` }] };
        }

        case 'tag': {
          if (!args.key || !args.tag) return { content: [{ type: 'text', text: 'key and tag required' }], isError: true };
          const entry = store.entries.find(e => e.key === args.key && e.namespace === ns);
          if (!entry) return { content: [{ type: 'text', text: `Not found: ${args.key}` }], isError: true };
          if (!entry.tags.includes(args.tag)) entry.tags.push(args.tag);
          entry.updated = new Date().toISOString();
          await save(store);
          return { content: [{ type: 'text', text: `Tagged ${args.key} with '${args.tag}'` }] };
        }

        case 'untag': {
          if (!args.key || !args.tag) return { content: [{ type: 'text', text: 'key and tag required' }], isError: true };
          const entry = store.entries.find(e => e.key === args.key && e.namespace === ns);
          if (!entry) return { content: [{ type: 'text', text: `Not found: ${args.key}` }], isError: true };
          entry.tags = entry.tags.filter(t => t !== args.tag);
          entry.updated = new Date().toISOString();
          await save(store);
          return { content: [{ type: 'text', text: `Removed tag '${args.tag}' from ${args.key}` }] };
        }

        case 'namespaces': {
          const nss = [...new Set(store.entries.map(e => e.namespace))];
          const counts: Record<string, number> = {};
          for (const e of store.entries) counts[e.namespace] = (counts[e.namespace] || 0) + 1;
          return { content: [{ type: 'text', text: `Namespaces (${nss.length}):\n${nss.map(n => `  ${n}: ${counts[n]} entries`).join('\n')}` }] };
        }

        case 'history': {
          if (!args.key) return { content: [{ type: 'text', text: 'key required' }], isError: true };
          const entries = store.entries.filter(e => e.key === args.key);
          if (!entries.length) return { content: [{ type: 'text', text: `No history for: ${args.key}` }] };
          return { content: [{ type: 'text', text: entries.map(e => `[${e.namespace}] ${e.updated}: ${e.value.substring(0, 100)}${e.value.length > 100 ? '...' : ''}`).join('\n') }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const memoryTools = [memoryTool];
