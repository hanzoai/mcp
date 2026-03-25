/**
 * Memory tool — single tool, action-routed persistent store/recall
 * store, recall, list, delete, search, stats, clear, export, import, merge, tag, untag,
 * namespaces, history, update, manage, facts, summarize, help
 */

import { Tool } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

interface Entry { id: string; key: string; value: string; tags: string[]; namespace: string; created: string; updated: string; metadata?: Record<string, any>; ttl?: string; }
interface Fact { id: string; content: string; kb: string; tags: string[]; created: string; }
interface Store { entries: Entry[]; lastId: number; facts: Fact[]; lastFactId: number; }

const storePath = () => process.env.MEMORY_PATH || path.join(os.homedir(), '.hanzo', 'memory.json');
async function load(): Promise<Store> { try { const raw = JSON.parse(await fs.readFile(storePath(), 'utf-8')); return { entries: raw.entries || [], lastId: raw.lastId || 0, facts: raw.facts || [], lastFactId: raw.lastFactId || 0 }; } catch { return { entries: [], lastId: 0, facts: [], lastFactId: 0 }; } }
async function save(s: Store) { await fs.mkdir(path.dirname(storePath()), { recursive: true }); await fs.writeFile(storePath(), JSON.stringify(s, null, 2)); }

function isExpired(e: Entry): boolean {
  if (!e.ttl) return false;
  return new Date(e.ttl) < new Date();
}

const HELP_TEXT = `memory tool — actions:

  store       Store a memory. Params: key, value, tags?, namespace?, metadata?, ttl?, append?
  recall      Recall memories. Params: key?, tag?, namespace?, limit?
  list        List entries. Params: namespace?, tag?, sort?, limit?
  delete      Delete by key or tag. Params: key | tag, namespace?
  search      Full-text search. Params: query, namespace?, tag?, limit?
  stats       Memory statistics. No params.
  clear       Clear entries. Params: namespace? (omit to clear all)
  export      Export to file. Params: file?, namespace?, tag?
  import      Import from file or data. Params: file | data, namespace?, tags?
  merge       Merge entries with same key. Params: key
  tag         Add tag to entry. Params: key, tag, namespace?
  untag       Remove tag from entry. Params: key, tag, namespace?
  namespaces  List all namespaces. No params.
  history     Show history for key. Params: key
  update      Update existing entry (no upsert). Params: key, value?, tags?, metadata?, ttl?, namespace?
  manage      Atomic multi-op. Params: data { create: [{key,value,tags?,namespace?}], update: [{key,value?,tags?,namespace?}], delete: [key1,...] }
  facts       Knowledge base. Params: fact_action (store_fact|recall_facts|delete_fact|list_facts), content?, query?, kb?, tags?, id?
  summarize   Store a summary. Params: content, topic, namespace?, tags?
  help        Show this help. No params.

  Parameter aliases: id -> key, scope -> namespace, content -> value`;

export const memoryTool: Tool = {
  name: 'memory',
  description: 'Persistent key-value memory with search, tags, namespaces, TTL, facts KB: store, recall, list, delete, search, stats, clear, export, import, merge, tag, untag, namespaces, history, update, manage, facts, summarize, help',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'store', 'recall', 'list', 'delete',
        'search', 'stats', 'clear',
        'export', 'import', 'merge',
        'tag', 'untag', 'namespaces', 'history',
        'update', 'manage', 'facts', 'summarize', 'help'
      ], description: 'Memory action' },
      key: { type: 'string', description: 'Memory key' },
      id: { type: 'string', description: 'Alias for key' },
      value: { type: 'string', description: 'Content to store' },
      content: { type: 'string', description: 'Alias for value (also used for facts and summarize)' },
      query: { type: 'string', description: 'Search query (full-text across keys, values, tags)' },
      tag: { type: 'string', description: 'Filter/assign tag' },
      tags: { type: 'array', items: { type: 'string' } },
      namespace: { type: 'string', default: 'default' },
      scope: { type: 'string', description: 'Alias for namespace' },
      metadata: { type: 'object' },
      ttl: { type: 'string', description: 'Expiry ISO date (auto-delete after)' },
      limit: { type: 'number', default: 50 },
      file: { type: 'string', description: 'File path for export/import' },
      data: { type: 'object', description: 'Key-value map for bulk import, or manage operations object' },
      append: { type: 'boolean', description: 'Append to existing value', default: false },
      sort: { type: 'string', enum: ['key', 'created', 'updated', 'namespace'], default: 'updated' },
      fact_action: { type: 'string', enum: ['store_fact', 'recall_facts', 'delete_fact', 'list_facts'], description: 'Sub-action for facts' },
      kb: { type: 'string', description: 'Knowledge base name for facts', default: 'default' },
      topic: { type: 'string', description: 'Topic for summarize action' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      // Parameter aliases
      if (args.id && !args.key) args.key = args.id;
      if (args.scope && !args.namespace) args.namespace = args.scope;
      if (args.content && !args.value) args.value = args.content;

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
          return { content: [{ type: 'text', text: `Memory Stats:\n  Entries: ${store.entries.length}\n  Facts: ${store.facts.length}\n  Size: ${(totalSize / 1024).toFixed(1)}KB\n  Namespaces: ${namespaces.join(', ')}\n  Tags: ${tags.join(', ')}\n  By namespace: ${Object.entries(byNs).map(([k, v]) => `${k}:${v}`).join(' ')}` }] };
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

        case 'update': {
          if (!args.key) return { content: [{ type: 'text', text: 'key required' }], isError: true };
          const entry = store.entries.find(e => e.key === args.key && e.namespace === ns);
          if (!entry) return { content: [{ type: 'text', text: `Not found: ${args.key} in namespace ${ns}. Use store to create.` }], isError: true };
          const now = new Date().toISOString();
          if (args.value) entry.value = args.value;
          if (args.tags) entry.tags = args.tags;
          if (args.metadata) entry.metadata = { ...entry.metadata, ...args.metadata };
          if (args.ttl) entry.ttl = args.ttl;
          entry.updated = now;
          await save(store);
          return { content: [{ type: 'text', text: `Updated: ${args.key} (${entry.value.length} chars)` }] };
        }

        case 'manage': {
          if (!args.data) return { content: [{ type: 'text', text: 'data required with create/update/delete arrays' }], isError: true };
          const ops = args.data as { create?: Array<{ key: string; value: string; tags?: string[]; namespace?: string }>; update?: Array<{ key: string; value?: string; tags?: string[]; namespace?: string }>; delete?: string[] };
          const now = new Date().toISOString();
          const summary: string[] = [];

          // Creates
          if (ops.create?.length) {
            for (const c of ops.create) {
              const cns = c.namespace || ns;
              store.lastId++;
              store.entries.push({ id: String(store.lastId), key: c.key, value: c.value, tags: c.tags || [], namespace: cns, created: now, updated: now });
            }
            summary.push(`created ${ops.create.length}`);
          }

          // Updates
          if (ops.update?.length) {
            let updated = 0;
            for (const u of ops.update) {
              const uns = u.namespace || ns;
              const entry = store.entries.find(e => e.key === u.key && e.namespace === uns);
              if (entry) {
                if (u.value) entry.value = u.value;
                if (u.tags) entry.tags = u.tags;
                entry.updated = now;
                updated++;
              }
            }
            summary.push(`updated ${updated}`);
          }

          // Deletes
          if (ops.delete?.length) {
            const keys = new Set(ops.delete);
            const before = store.entries.length;
            store.entries = store.entries.filter(e => !keys.has(e.key));
            summary.push(`deleted ${before - store.entries.length}`);
          }

          await save(store);
          return { content: [{ type: 'text', text: `Manage: ${summary.join(', ')}` }] };
        }

        case 'facts': {
          const factAction = args.fact_action;
          if (!factAction) return { content: [{ type: 'text', text: 'fact_action required (store_fact, recall_facts, delete_fact, list_facts)' }], isError: true };
          const kbName = args.kb || 'default';

          switch (factAction) {
            case 'store_fact': {
              if (!args.value) return { content: [{ type: 'text', text: 'value/content required for store_fact' }], isError: true };
              store.lastFactId++;
              const fact: Fact = { id: String(store.lastFactId), content: args.value, kb: kbName, tags: args.tags || [], created: new Date().toISOString() };
              store.facts.push(fact);
              await save(store);
              return { content: [{ type: 'text', text: `Stored fact #${fact.id} in kb '${kbName}' (${fact.content.length} chars)` }] };
            }

            case 'recall_facts': {
              let facts = store.facts.filter(f => f.kb === kbName);
              if (args.query) {
                const q = args.query.toLowerCase();
                const terms = q.split(/\s+/);
                facts = facts.filter(f => {
                  const text = `${f.content} ${f.tags.join(' ')} ${f.kb}`.toLowerCase();
                  return terms.every((t: string) => text.includes(t));
                });
              }
              if (args.tag) facts = facts.filter(f => f.tags.includes(args.tag));
              facts = facts.slice(0, args.limit || 20);
              if (!facts.length) return { content: [{ type: 'text', text: `No facts found in kb '${kbName}'` }] };
              const out = facts.map(f => `#${f.id} [${f.kb}]${f.tags.length ? ` [${f.tags.join(',')}]` : ''} (${f.created.split('T')[0]}):\n  ${f.content.substring(0, 300)}${f.content.length > 300 ? '...' : ''}`);
              return { content: [{ type: 'text', text: `Found ${facts.length} facts:\n\n${out.join('\n\n')}` }] };
            }

            case 'delete_fact': {
              if (!args.key) return { content: [{ type: 'text', text: 'id/key required to delete fact' }], isError: true };
              const idx = store.facts.findIndex(f => f.id === args.key && f.kb === kbName);
              if (idx < 0) return { content: [{ type: 'text', text: `Fact not found: #${args.key} in kb '${kbName}'` }], isError: true };
              store.facts.splice(idx, 1);
              await save(store);
              return { content: [{ type: 'text', text: `Deleted fact #${args.key} from kb '${kbName}'` }] };
            }

            case 'list_facts': {
              let facts = store.facts;
              if (args.kb) facts = facts.filter(f => f.kb === kbName);
              if (args.tag) facts = facts.filter(f => f.tags.includes(args.tag));
              const kbs = [...new Set(store.facts.map(f => f.kb))];
              const limited = facts.slice(0, args.limit || 50);
              const out = [`${store.facts.length} facts, knowledge bases: [${kbs.join(', ')}]`, ''];
              for (const f of limited) out.push(`  #${f.id} [${f.kb}]${f.tags.length ? ` [${f.tags.join(',')}]` : ''} ${f.content.length}ch`);
              return { content: [{ type: 'text', text: out.join('\n') }] };
            }

            default:
              return { content: [{ type: 'text', text: `Unknown fact_action: ${factAction}` }], isError: true };
          }
        }

        case 'summarize': {
          if (!args.value && !args.content) return { content: [{ type: 'text', text: 'content/value required' }], isError: true };
          if (!args.topic) return { content: [{ type: 'text', text: 'topic required' }], isError: true };
          const summaryContent = args.value || args.content;
          const now = new Date().toISOString();
          const ts = now.replace(/[:.]/g, '-');
          const summaryKey = `summary-${args.topic}-${ts}`;
          const summaryTags = ['summary', args.topic, ...(args.tags || [])];
          store.lastId++;
          store.entries.push({ id: String(store.lastId), key: summaryKey, value: summaryContent, tags: summaryTags, namespace: ns, created: now, updated: now });
          await save(store);
          return { content: [{ type: 'text', text: `Summary stored: ${summaryKey} (${summaryContent.length} chars)` }] };
        }

        case 'help': {
          return { content: [{ type: 'text', text: HELP_TEXT }] };
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
