/**
 * Todo tool — single tool, action-routed task tracking
 * add, list, update, delete, stats, search, batch, archive, move, prioritize, assign, export
 */

import { Tool } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

interface Item { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority: 'high' | 'medium' | 'low'; created: string; updated: string; due?: string; tags?: string[]; project?: string; assignee?: string; parent?: string; notes?: string; }
interface TodoList { items: Item[]; lastId: number; }

const todoPath = () => process.env.TODO_PATH || path.join(os.homedir(), '.hanzo', 'todos.json');
async function load(): Promise<TodoList> { try { return JSON.parse(await fs.readFile(todoPath(), 'utf-8')); } catch { return { items: [], lastId: 0 }; } }
async function save(t: TodoList) { await fs.mkdir(path.dirname(todoPath()), { recursive: true }); await fs.writeFile(todoPath(), JSON.stringify(t, null, 2)); }

export const tasksTool: Tool = {
  name: 'tasks',
  description: 'Task tracking: add, list, update, delete, stats, search, batch, archive, move, prioritize, assign, subtasks, notes, export, import',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'add', 'list', 'update', 'delete', 'stats',
        'search', 'batch', 'archive', 'move',
        'prioritize', 'assign', 'subtasks', 'notes', 'export', 'import'
      ] },
      content: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], default: 'medium' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
      due: { type: 'string', description: 'Due date (ISO or YYYY-MM-DD)' },
      tags: { type: 'array', items: { type: 'string' } },
      project: { type: 'string' },
      assignee: { type: 'string' },
      parent: { type: 'string', description: 'Parent task ID (subtasks)' },
      id: { type: 'string' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Multiple IDs (batch)' },
      query: { type: 'string', description: 'Search query' },
      tag: { type: 'string' },
      limit: { type: 'number', default: 50 },
      text: { type: 'string', description: 'Note text' },
      file: { type: 'string', description: 'File path for export/import' },
      sort: { type: 'string', enum: ['priority', 'due', 'created', 'status'], default: 'priority' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const todos = await load();

      switch (args.action) {
        case 'add': {
          if (!args.content) return { content: [{ type: 'text', text: 'content required' }], isError: true };
          todos.lastId++;
          const now = new Date().toISOString();
          todos.items.push({
            id: String(todos.lastId), content: args.content, status: 'pending',
            priority: (args.priority as Item['priority']) || 'medium', created: now, updated: now,
            due: args.due, tags: args.tags, project: args.project,
            assignee: args.assignee, parent: args.parent
          });
          await save(todos);
          return { content: [{ type: 'text', text: `Added #${todos.lastId}: ${args.content}` }] };
        }

        case 'list': {
          let items = todos.items;
          if (args.status) items = items.filter(t => t.status === args.status);
          if (args.priority) items = items.filter(t => t.priority === args.priority);
          if (args.project) items = items.filter(t => t.project === args.project);
          if (args.tag) items = items.filter(t => t.tags?.includes(args.tag));
          if (args.assignee) items = items.filter(t => t.assignee === args.assignee);
          if (args.parent !== undefined) items = items.filter(t => t.parent === args.parent);

          const po: Record<string, number> = { high: 0, medium: 1, low: 2 };
          const so: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 };
          const sortKey = args.sort || 'priority';
          items.sort((a, b) => {
            if (sortKey === 'due') return (a.due || 'z').localeCompare(b.due || 'z');
            if (sortKey === 'created') return b.created.localeCompare(a.created);
            if (sortKey === 'status') return (so[a.status] - so[b.status]);
            return (so[a.status] - so[b.status]) || (po[a.priority] - po[b.priority]);
          });
          items = items.slice(0, args.limit || 50);
          if (!items.length) return { content: [{ type: 'text', text: 'No todos' }] };
          const out = items.map(t => {
            let line = `#${t.id} [${t.priority}] [${t.status}] ${t.content}`;
            if (t.tags?.length) line += ` [${t.tags.join(',')}]`;
            if (t.project) line += ` (${t.project})`;
            if (t.assignee) line += ` @${t.assignee}`;
            if (t.due) line += ` due:${t.due.split('T')[0]}`;
            if (t.parent) line += ` ↑${t.parent}`;
            return line;
          });
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'update': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const t = todos.items.find(i => i.id === args.id);
          if (!t) return { content: [{ type: 'text', text: `#${args.id} not found` }], isError: true };
          if (args.content !== undefined) t.content = args.content;
          if (args.status !== undefined) t.status = args.status as Item['status'];
          if (args.priority !== undefined) t.priority = args.priority as Item['priority'];
          if (args.due !== undefined) t.due = args.due;
          if (args.tags !== undefined) t.tags = args.tags;
          if (args.project !== undefined) t.project = args.project;
          if (args.assignee !== undefined) t.assignee = args.assignee;
          t.updated = new Date().toISOString();
          await save(todos);
          return { content: [{ type: 'text', text: `Updated #${args.id}` }] };
        }

        case 'delete': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const i = todos.items.findIndex(t => t.id === args.id);
          if (i < 0) return { content: [{ type: 'text', text: `#${args.id} not found` }], isError: true };
          // Also delete subtasks
          const subtasks = todos.items.filter(t => t.parent === args.id);
          todos.items = todos.items.filter(t => t.id !== args.id && t.parent !== args.id);
          await save(todos);
          return { content: [{ type: 'text', text: `Deleted #${args.id}${subtasks.length ? ` and ${subtasks.length} subtasks` : ''}` }] };
        }

        case 'stats': {
          let items = todos.items;
          if (args.project) items = items.filter(t => t.project === args.project);
          const byS: Record<string, number> = {}, byP: Record<string, number> = {};
          let overdue = 0;
          const projects = [...new Set(todos.items.map(t => t.project).filter(Boolean))];
          const assignees = [...new Set(todos.items.map(t => t.assignee).filter(Boolean))];
          for (const t of items) {
            byS[t.status] = (byS[t.status] || 0) + 1;
            byP[t.priority] = (byP[t.priority] || 0) + 1;
            if (t.due && t.status !== 'completed' && t.status !== 'cancelled' && new Date(t.due) < new Date()) overdue++;
          }
          return { content: [{ type: 'text', text: `${items.length} items${overdue ? `, ${overdue} overdue` : ''}\nStatus: ${Object.entries(byS).map(([k, v]) => `${k}:${v}`).join(' ')}\nPriority: ${Object.entries(byP).map(([k, v]) => `${k}:${v}`).join(' ')}\nProjects: ${projects.join(', ') || '(none)'}\nAssignees: ${assignees.join(', ') || '(none)'}` }] };
        }

        case 'search': {
          if (!args.query) return { content: [{ type: 'text', text: 'query required' }], isError: true };
          const q = args.query.toLowerCase();
          let results = todos.items.filter(t => {
            const text = `${t.content} ${t.tags?.join(' ') || ''} ${t.project || ''} ${t.assignee || ''}`.toLowerCase();
            return text.includes(q);
          });
          results = results.slice(0, args.limit || 20);
          if (!results.length) return { content: [{ type: 'text', text: `No results for: ${args.query}` }] };
          const out = results.map(t => `#${t.id} [${t.priority}] [${t.status}] ${t.content}`);
          return { content: [{ type: 'text', text: `Found ${results.length}:\n${out.join('\n')}` }] };
        }

        case 'batch': {
          if (!args.ids?.length || !args.status) return { content: [{ type: 'text', text: 'ids and status required' }], isError: true };
          let count = 0;
          for (const id of args.ids) {
            const t = todos.items.find(i => i.id === id);
            if (t) { t.status = args.status as Item['status']; t.updated = new Date().toISOString(); count++; }
          }
          await save(todos);
          return { content: [{ type: 'text', text: `Updated ${count}/${args.ids.length} items to ${args.status}` }] };
        }

        case 'archive': {
          const completed = todos.items.filter(t => t.status === 'completed' || t.status === 'cancelled');
          if (!completed.length) return { content: [{ type: 'text', text: 'Nothing to archive' }] };
          const archivePath = path.join(path.dirname(todoPath()), 'todos-archive.json');
          let archive: TodoList = { items: [], lastId: 0 };
          try { archive = JSON.parse(await fs.readFile(archivePath, 'utf-8')); } catch {}
          archive.items.push(...completed);
          await fs.writeFile(archivePath, JSON.stringify(archive, null, 2));
          todos.items = todos.items.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
          await save(todos);
          return { content: [{ type: 'text', text: `Archived ${completed.length} items` }] };
        }

        case 'move': {
          if (!args.id || !args.project) return { content: [{ type: 'text', text: 'id and project required' }], isError: true };
          const t = todos.items.find(i => i.id === args.id);
          if (!t) return { content: [{ type: 'text', text: `#${args.id} not found` }], isError: true };
          t.project = args.project;
          t.updated = new Date().toISOString();
          await save(todos);
          return { content: [{ type: 'text', text: `Moved #${args.id} to project: ${args.project}` }] };
        }

        case 'prioritize': {
          if (!args.id || !args.priority) return { content: [{ type: 'text', text: 'id and priority required' }], isError: true };
          const t = todos.items.find(i => i.id === args.id);
          if (!t) return { content: [{ type: 'text', text: `#${args.id} not found` }], isError: true };
          t.priority = args.priority as Item['priority'];
          t.updated = new Date().toISOString();
          await save(todos);
          return { content: [{ type: 'text', text: `#${args.id} priority → ${args.priority}` }] };
        }

        case 'assign': {
          if (!args.id || !args.assignee) return { content: [{ type: 'text', text: 'id and assignee required' }], isError: true };
          const t = todos.items.find(i => i.id === args.id);
          if (!t) return { content: [{ type: 'text', text: `#${args.id} not found` }], isError: true };
          t.assignee = args.assignee;
          t.updated = new Date().toISOString();
          await save(todos);
          return { content: [{ type: 'text', text: `#${args.id} assigned to @${args.assignee}` }] };
        }

        case 'subtasks': {
          if (!args.id) return { content: [{ type: 'text', text: 'parent id required' }], isError: true };
          const parent = todos.items.find(i => i.id === args.id);
          if (!parent) return { content: [{ type: 'text', text: `#${args.id} not found` }], isError: true };
          const children = todos.items.filter(t => t.parent === args.id);
          const out = [`#${args.id}: ${parent.content}`, `Subtasks (${children.length}):`];
          for (const c of children) out.push(`  #${c.id} [${c.priority}] [${c.status}] ${c.content}`);
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'notes': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const t = todos.items.find(i => i.id === args.id);
          if (!t) return { content: [{ type: 'text', text: `#${args.id} not found` }], isError: true };
          if (args.text) {
            t.notes = (t.notes || '') + '\n' + args.text;
            t.updated = new Date().toISOString();
            await save(todos);
            return { content: [{ type: 'text', text: `Added note to #${args.id}` }] };
          }
          return { content: [{ type: 'text', text: `#${args.id} notes:\n${t.notes || '(none)'}` }] };
        }

        case 'export': {
          const filePath = args.file || path.join(os.homedir(), '.hanzo', 'todos-export.json');
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, JSON.stringify(todos.items, null, 2));
          return { content: [{ type: 'text', text: `Exported ${todos.items.length} items to ${filePath}` }] };
        }

        case 'import': {
          if (!args.file) return { content: [{ type: 'text', text: 'file required' }], isError: true };
          const imported: Item[] = JSON.parse(await fs.readFile(args.file, 'utf-8'));
          for (const item of imported) {
            todos.lastId++;
            item.id = String(todos.lastId);
            todos.items.push(item);
          }
          await save(todos);
          return { content: [{ type: 'text', text: `Imported ${imported.length} items from ${args.file}` }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const tasksTools = [tasksTool];
