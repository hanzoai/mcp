/**
 * Vector tool — single tool, action-routed semantic search
 * index, search, stats, delete, list_tables, drop_table, reindex, similar
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { Tool } from '../types/index.js';

let lancedb: any = null;
let embedder: any = null;

async function getLanceDB() {
  if (!lancedb) { try { lancedb = await import('@lancedb/lancedb'); } catch { throw new Error('Requires @lancedb/lancedb'); } }
  return lancedb.default || lancedb;
}
async function getEmbedder() {
  if (!embedder) { try { const { pipeline } = await import('@xenova/transformers'); embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); } catch { throw new Error('Requires @xenova/transformers'); } }
  return embedder;
}

const dbs = new Map<string, any>();
async function getDB(p: string) {
  const dp = path.join(p, '.hanzo', 'lancedb');
  if (!dbs.has(dp)) { await fs.mkdir(path.dirname(dp), { recursive: true }); dbs.set(dp, await (await getLanceDB()).connect(dp)); }
  return dbs.get(dp);
}

export const vectorTool: Tool = {
  name: 'vector',
  description: 'Semantic vector search: index content, search by similarity, stats, delete, list tables, reindex, find similar documents',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'index', 'search', 'stats',
        'delete', 'list_tables', 'drop_table',
        'reindex', 'similar'
      ] },
      content: { type: 'string', description: 'Content to index' },
      path: { type: 'string', description: 'File/dir to index' },
      metadata: { type: 'object' },
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', default: 10 },
      table: { type: 'string', description: 'Table name', default: 'documents' },
      id: { type: 'string', description: 'Document ID (delete, similar)' },
      threshold: { type: 'number', description: 'Similarity threshold (0-1)', default: 0.8 },
      projectPath: { type: 'string', description: 'Project root for DB location' },
      recursive: { type: 'boolean', description: 'Recursively index directory', default: true },
      filePattern: { type: 'string', description: 'File glob for indexing (e.g., "*.md")' },
      chunkSize: { type: 'number', description: 'Max chars per chunk for indexing', default: 1000 },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for indexed content' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const pp = args.projectPath || process.cwd();
      const tableName = args.table || 'documents';

      switch (args.action) {
        case 'index': {
          const db = await getDB(pp);
          const model = await getEmbedder();
          const items: Array<{ content: string; path?: string; tags?: string[] }> = [];

          if (args.content) {
            // Chunk large content
            const chunkSize = args.chunkSize || 1000;
            if (args.content.length > chunkSize) {
              const chunks = [];
              for (let i = 0; i < args.content.length; i += chunkSize) {
                chunks.push(args.content.substring(i, i + chunkSize));
              }
              for (const chunk of chunks) items.push({ content: chunk, path: args.path, tags: args.tags });
            } else {
              items.push({ content: args.content, path: args.path, tags: args.tags });
            }
          } else if (args.path) {
            const s = await fs.stat(args.path);
            if (s.isFile()) {
              items.push({ content: await fs.readFile(args.path, 'utf-8'), path: args.path, tags: args.tags });
            } else if (args.recursive !== false) {
              const { glob } = await import('glob');
              const pattern = args.filePattern || '**/*.{ts,js,py,md,txt,rs,go}';
              const files = await glob(path.join(args.path, pattern), { ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'] });
              for (const fp of files) {
                try {
                  const content = await fs.readFile(fp, 'utf-8');
                  if (content.length > 0) items.push({ content, path: fp, tags: args.tags });
                } catch {}
              }
            }
          }

          if (!items.length) return { content: [{ type: 'text', text: 'No content to index' }], isError: true };

          let table;
          try { table = await db.openTable(tableName); }
          catch { table = await db.createTable(tableName, [{ id: 0, content: '', path: '', embedding: [], metadata: {}, tags: [], timestamp: new Date() }]); }

          let indexed = 0;
          for (const item of items) {
            const out = await model(item.content.substring(0, 512), { pooling: 'mean', normalize: true });
            await table.add([{
              id: Date.now() + Math.random(),
              content: item.content,
              path: item.path || '',
              embedding: Array.from(out.data),
              metadata: args.metadata || {},
              tags: item.tags || [],
              timestamp: new Date()
            }]);
            indexed++;
          }
          return { content: [{ type: 'text', text: `Indexed ${indexed} items into '${tableName}'` }] };
        }

        case 'search': {
          if (!args.query) return { content: [{ type: 'text', text: 'query required' }], isError: true };
          const db = await getDB(pp);
          const model = await getEmbedder();
          let table;
          try { table = await db.openTable(tableName); }
          catch { return { content: [{ type: 'text', text: `Table '${tableName}' not found. Use action=index first.` }] }; }
          const out = await model(args.query, { pooling: 'mean', normalize: true });
          const matches = await (await table.search(Array.from(out.data)).limit(args.limit || 10)).toArray();
          if (!matches.length) return { content: [{ type: 'text', text: 'No matches' }] };
          const fmt = matches.map((m: any, i: number) => {
            const score = (1 - (m._distance || 0)).toFixed(3);
            const tags = m.tags?.length ? ` [${m.tags.join(',')}]` : '';
            return `${i + 1}. [${score}] ${m.path || 'content'}${tags}\n   ${m.content.substring(0, 200).replace(/\n/g, ' ')}${m.content.length > 200 ? '...' : ''}`;
          });
          return { content: [{ type: 'text', text: fmt.join('\n\n') }] };
        }

        case 'stats': {
          const db = await getDB(pp);
          try {
            const t = await db.openTable(tableName);
            const count = await t.countRows();
            return { content: [{ type: 'text', text: `Table: ${tableName}\nDocuments: ${count}\nPath: ${path.join(pp, '.hanzo/lancedb')}` }] };
          } catch {
            return { content: [{ type: 'text', text: `Table '${tableName}' not found. Use action=index to add documents.` }] };
          }
        }

        case 'delete': {
          if (!args.id && !args.path) return { content: [{ type: 'text', text: 'id or path required' }], isError: true };
          const db = await getDB(pp);
          const t = await db.openTable(tableName);
          if (args.id) {
            await t.delete(`id = ${args.id}`);
            return { content: [{ type: 'text', text: `Deleted document: ${args.id}` }] };
          }
          await t.delete(`path = '${args.path}'`);
          return { content: [{ type: 'text', text: `Deleted documents with path: ${args.path}` }] };
        }

        case 'list_tables': {
          const db = await getDB(pp);
          const tables = await db.tableNames();
          return { content: [{ type: 'text', text: `Tables:\n${(tables as string[]).map((t: string) => `  ${t}`).join('\n') || '(none)'}` }] };
        }

        case 'drop_table': {
          if (!args.table) return { content: [{ type: 'text', text: 'table required' }], isError: true };
          const db = await getDB(pp);
          await db.dropTable(args.table);
          return { content: [{ type: 'text', text: `Dropped table: ${args.table}` }] };
        }

        case 'reindex': {
          if (!args.path) return { content: [{ type: 'text', text: 'path required' }], isError: true };
          const db = await getDB(pp);
          // Drop and recreate
          try { await db.dropTable(tableName); } catch {}
          // Re-invoke index
          return (await vectorTool.handler({ ...args, action: 'index' }));
        }

        case 'similar': {
          if (!args.id && !args.content) return { content: [{ type: 'text', text: 'id or content required' }], isError: true };
          const db = await getDB(pp);
          const model = await getEmbedder();
          const t = await db.openTable(tableName);

          let queryContent = args.content;
          if (args.id) {
            // Find document by ID and use its content
            const docs = await (await t.search([])).limit(1000).toArray();
            const doc = docs.find((d: any) => String(d.id) === String(args.id));
            if (!doc) return { content: [{ type: 'text', text: `Document ${args.id} not found` }], isError: true };
            queryContent = doc.content;
          }

          const out = await model(queryContent!.substring(0, 512), { pooling: 'mean', normalize: true });
          const matches = await (await t.search(Array.from(out.data)).limit((args.limit || 10) + 1)).toArray();
          // Filter out the source document and by threshold
          const filtered = matches.filter((m: any) => {
            if (args.id && String(m.id) === String(args.id)) return false;
            const sim = 1 - (m._distance || 0);
            return sim >= (args.threshold || 0);
          }).slice(0, args.limit || 10);

          if (!filtered.length) return { content: [{ type: 'text', text: 'No similar documents found' }] };
          const fmt = filtered.map((m: any, i: number) => `${i + 1}. [${(1 - (m._distance || 0)).toFixed(3)}] ${m.path || 'content'}\n   ${m.content.substring(0, 150).replace(/\n/g, ' ')}...`);
          return { content: [{ type: 'text', text: fmt.join('\n\n') }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const vectorTools = [vectorTool];
