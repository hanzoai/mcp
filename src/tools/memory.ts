/**
 * Memory tool — single tool, action-routed persistent store/recall.
 * store, recall, list, delete, search, stats, clear, export, import, merge, tag, untag,
 * namespaces, history, update, manage, facts, summarize, help
 *
 * Storage is decomplected behind `MemoryBackend` (src/memory). This tool is
 * presentation + routing only: it maps each action to one backend operation
 * and formats output. The backend is chosen by HANZO_MEMORY_BACKEND
 * (local default | cloud | sync) — the action surface here is identical
 * regardless of backend.
 */

import { Tool } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { selectBackend } from '../memory/index.js';
import { Entry } from '../memory/types.js';

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

  Parameter aliases: id -> key, scope -> namespace, content -> value
  Backend: HANZO_MEMORY_BACKEND=local (default) | cloud | sync`;

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const });

function recallLine(e: Entry): string {
  return `[${e.namespace}] ${e.key}${e.tags.length ? ` [${e.tags.join(', ')}]` : ''} (${e.updated.split('T')[0]}):\n  ${e.value.substring(0, 300)}${e.value.length > 300 ? '...' : ''}`;
}

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

      if (args.action === 'help') return ok(HELP_TEXT);

      const backend = await selectBackend();

      switch (args.action) {
        case 'store': {
          if (!args.key || !args.value) return err('key and value required');
          const { entry, created } = await backend.store({ key: args.key, value: args.value, namespace: ns, tags: args.tags, metadata: args.metadata, ttl: args.ttl, append: args.append });
          return created
            ? ok(`Stored: ${args.key} (${args.value.length} chars)`)
            : ok(`Updated: ${args.key} (${entry.value.length} chars)`);
        }

        case 'recall': {
          const r = await backend.recall({ namespace: ns, scoped: !!args.namespace, key: args.key, tag: args.tag, limit: args.limit || 10 });
          if (!r.length) return ok('No memories found');
          return ok(r.map(recallLine).join('\n\n'));
        }

        case 'list': {
          const { entries, total, namespaces } = await backend.list({ namespace: args.namespace ? ns : undefined, tag: args.tag, sort: args.sort, limit: args.limit || 50 });
          const out = [`${total} entries, namespaces: [${namespaces.join(', ')}]`, ''];
          for (const e of entries) out.push(`  ${e.key}${e.tags.length ? ` [${e.tags.join(',')}]` : ''} (${e.namespace}) ${e.value.length}ch`);
          return ok(out.join('\n'));
        }

        case 'delete': {
          if (!args.key && !args.tag) return err('key or tag required');
          const count = await backend.remove({ namespace: ns, key: args.key, tag: args.tag });
          if (args.key && count === 0) return err(`Not found: ${args.key}`);
          return ok(`Deleted ${count} entries`);
        }

        case 'search': {
          if (!args.query) return err('query required');
          const results = await backend.search({ query: args.query, namespace: args.namespace ? ns : undefined, tag: args.tag, limit: args.limit || 20 });
          if (!results.length) return ok(`No results for: ${args.query}`);
          const out = results.map(e => `[${e.namespace}] ${e.key}${e.tags.length ? ` [${e.tags.join(',')}]` : ''}:\n  ${e.value.substring(0, 200)}${e.value.length > 200 ? '...' : ''}`);
          return ok(`Found ${results.length}:\n\n${out.join('\n\n')}`);
        }

        case 'stats': {
          const s = await backend.stats();
          return ok(`Memory Stats:\n  Entries: ${s.entries}\n  Facts: ${s.facts}\n  Size: ${(s.sizeBytes / 1024).toFixed(1)}KB\n  Namespaces: ${s.namespaces.join(', ')}\n  Tags: ${s.tags.join(', ')}\n  By namespace: ${Object.entries(s.byNamespace).map(([k, v]) => `${k}:${v}`).join(' ')}`);
        }

        case 'clear': {
          const count = await backend.clear(args.namespace ? ns : undefined);
          return ok(`Cleared ${count} entries${args.namespace ? ` from namespace: ${ns}` : ''}`);
        }

        case 'export': {
          const filePath = args.file || path.join(os.homedir(), '.hanzo', 'memory-export.json');
          const entries = await backend.exportEntries(args.namespace ? ns : undefined, args.tag);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, JSON.stringify(entries, null, 2));
          return ok(`Exported ${entries.length} entries to ${filePath}`);
        }

        case 'import': {
          if (args.data) {
            const entries: Partial<Entry>[] = Object.entries(args.data).map(([k, v]) => ({ key: k, value: String(v) }));
            await backend.importEntries(entries, ns, args.tags);
            return ok(`Imported ${Object.keys(args.data).length} entries`);
          }
          if (!args.file) return err('file or data required');
          const imported: Partial<Entry>[] = JSON.parse(await fs.readFile(args.file, 'utf-8'));
          const n = await backend.importEntries(imported, ns);
          return ok(`Imported ${n} entries from ${args.file}`);
        }

        case 'merge': {
          if (!args.key) return err('key required');
          const { merged } = await backend.merge(args.key);
          if (merged < 2) return ok(`Only ${merged} entries with key '${args.key}', nothing to merge`);
          return ok(`Merged ${merged} entries into key '${args.key}'`);
        }

        case 'tag': {
          if (!args.key || !args.tag) return err('key and tag required');
          const entry = await backend.setTag(args.key, ns, args.tag, true);
          if (!entry) return err(`Not found: ${args.key}`);
          return ok(`Tagged ${args.key} with '${args.tag}'`);
        }

        case 'untag': {
          if (!args.key || !args.tag) return err('key and tag required');
          const entry = await backend.setTag(args.key, ns, args.tag, false);
          if (!entry) return err(`Not found: ${args.key}`);
          return ok(`Removed tag '${args.tag}' from ${args.key}`);
        }

        case 'namespaces': {
          const counts = await backend.namespaces();
          const names = Object.keys(counts);
          return ok(`Namespaces (${names.length}):\n${names.map(n => `  ${n}: ${counts[n]} entries`).join('\n')}`);
        }

        case 'history': {
          if (!args.key) return err('key required');
          const entries = await backend.history(args.key);
          if (!entries.length) return ok(`No history for: ${args.key}`);
          return ok(entries.map(e => `[${e.namespace}] ${e.updated}: ${e.value.substring(0, 100)}${e.value.length > 100 ? '...' : ''}`).join('\n'));
        }

        case 'update': {
          if (!args.key) return err('key required');
          const entry = await backend.update({ key: args.key, namespace: ns, value: args.value, tags: args.tags, metadata: args.metadata, ttl: args.ttl });
          if (!entry) return err(`Not found: ${args.key} in namespace ${ns}. Use store to create.`);
          return ok(`Updated: ${args.key} (${entry.value.length} chars)`);
        }

        case 'manage': {
          if (!args.data) return err('data required with create/update/delete arrays');
          const ops = args.data as { create?: Array<{ key: string; value: string; tags?: string[]; namespace?: string }>; update?: Array<{ key: string; value?: string; tags?: string[]; namespace?: string }>; delete?: string[] };
          const res = await backend.bulk({ namespace: ns, create: ops.create, update: ops.update, delete: ops.delete });
          const summary: string[] = [];
          if (ops.create?.length) summary.push(`created ${res.created}`);
          if (ops.update?.length) summary.push(`updated ${res.updated}`);
          if (ops.delete?.length) summary.push(`deleted ${res.deleted}`);
          return ok(`Manage: ${summary.join(', ')}`);
        }

        case 'facts': {
          const factAction = args.fact_action;
          if (!factAction) return err('fact_action required (store_fact, recall_facts, delete_fact, list_facts)');
          const kbName = args.kb || 'default';

          switch (factAction) {
            case 'store_fact': {
              if (!args.value) return err('value/content required for store_fact');
              const fact = await backend.addFact({ content: args.value, kb: kbName, tags: args.tags });
              return ok(`Stored fact #${fact.id} in kb '${kbName}' (${fact.content.length} chars)`);
            }
            case 'recall_facts': {
              const facts = await backend.recallFacts({ kb: kbName, query: args.query, tag: args.tag, limit: args.limit || 20 });
              if (!facts.length) return ok(`No facts found in kb '${kbName}'`);
              const out = facts.map(f => `#${f.id} [${f.kb}]${f.tags.length ? ` [${f.tags.join(',')}]` : ''} (${f.created.split('T')[0]}):\n  ${f.content.substring(0, 300)}${f.content.length > 300 ? '...' : ''}`);
              return ok(`Found ${facts.length} facts:\n\n${out.join('\n\n')}`);
            }
            case 'delete_fact': {
              if (!args.key) return err('id/key required to delete fact');
              const deleted = await backend.removeFact(args.key, kbName);
              if (!deleted) return err(`Fact not found: #${args.key} in kb '${kbName}'`);
              return ok(`Deleted fact #${args.key} from kb '${kbName}'`);
            }
            case 'list_facts': {
              const { facts, total, kbs } = await backend.listFacts({ kb: args.kb ? kbName : undefined, tag: args.tag, limit: args.limit || 50 });
              const out = [`${total} facts, knowledge bases: [${kbs.join(', ')}]`, ''];
              for (const f of facts) out.push(`  #${f.id} [${f.kb}]${f.tags.length ? ` [${f.tags.join(',')}]` : ''} ${f.content.length}ch`);
              return ok(out.join('\n'));
            }
            default:
              return err(`Unknown fact_action: ${factAction}`);
          }
        }

        case 'summarize': {
          if (!args.value && !args.content) return err('content/value required');
          if (!args.topic) return err('topic required');
          const summaryContent = args.value || args.content;
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const summaryKey = `summary-${args.topic}-${ts}`;
          const summaryTags = ['summary', args.topic, ...(args.tags || [])];
          await backend.store({ key: summaryKey, value: summaryContent, namespace: ns, tags: summaryTags });
          return ok(`Summary stored: ${summaryKey} (${summaryContent.length} chars)`);
        }

        default:
          return err(`Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return err(`Error: ${error.message}`);
    }
  }
};

export const memoryTools = [memoryTool];
