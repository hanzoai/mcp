/**
 * Plan tool — single tool, action-routed task decomposition
 * create, show, update, list, next, archive, add_step, remove_step, estimate, visualize, clone, cancel
 */

import { Tool } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

interface Step { id: string; description: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped'; dependencies: string[]; output?: string; tools?: string[]; estimate?: string; assignee?: string; }
interface Plan { id: string; name: string; goal: string; steps: Step[]; created: string; updated: string; status: 'draft' | 'active' | 'completed' | 'cancelled' | 'archived'; tags?: string[]; notes?: string; }
interface PlanStore { plans: Plan[]; lastId: number; }

const planPath = () => process.env.PLAN_PATH || path.join(os.homedir(), '.hanzo', 'plans.json');
async function loadPlans(): Promise<PlanStore> { try { return JSON.parse(await fs.readFile(planPath(), 'utf-8')); } catch { return { plans: [], lastId: 0 }; } }
async function savePlans(s: PlanStore) { await fs.mkdir(path.dirname(planPath()), { recursive: true }); await fs.writeFile(planPath(), JSON.stringify(s, null, 2)); }

export const planTool: Tool = {
  name: 'plan',
  description: 'Execution plans with DAG dependencies: create, show, update, list, next, archive, add_step, remove_step, estimate, visualize, clone, cancel, notes, progress',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'create', 'show', 'update', 'list', 'next',
        'archive', 'add_step', 'remove_step',
        'estimate', 'visualize', 'clone', 'cancel',
        'notes', 'progress'
      ], description: 'Plan action' },
      name: { type: 'string' }, goal: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, estimate: { type: 'string' }, assignee: { type: 'string' } }, required: ['description'] } },
      id: { type: 'string', description: 'Plan ID (or "latest")' },
      stepId: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'skipped'] },
      output: { type: 'string', description: 'Step result' },
      filter: { type: 'string', enum: ['all', 'active', 'completed', 'draft', 'cancelled', 'archived'], default: 'all' },
      limit: { type: 'number', default: 20 },
      description: { type: 'string', description: 'Step description (add_step)' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'Step dependencies (add_step)' },
      after: { type: 'string', description: 'Insert after step ID (add_step)' },
      text: { type: 'string', description: 'Notes text' },
      tags: { type: 'array', items: { type: 'string' } }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const store = await loadPlans();
      const icons: Record<string, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]', blocked: '[!]', skipped: '[-]' };

      function findPlan(id: string): Plan | undefined {
        if (id === 'latest') return store.plans.filter(p => p.status === 'active').pop() || store.plans[store.plans.length - 1];
        return store.plans.find(p => p.id === id);
      }

      switch (args.action) {
        case 'create': {
          if (!args.name || !args.goal || !args.steps?.length) return { content: [{ type: 'text', text: 'name, goal, steps required' }], isError: true };
          store.lastId++;
          const pid = String(store.lastId);
          const now = new Date().toISOString();
          const steps: Step[] = args.steps.map((s: any, i: number) => ({
            id: `${pid}.${i + 1}`, description: s.description, status: 'pending' as const,
            dependencies: s.dependencies || [], tools: s.tools, estimate: s.estimate, assignee: s.assignee
          }));
          store.plans.push({ id: pid, name: args.name, goal: args.goal, steps, created: now, updated: now, status: 'active', tags: args.tags });
          await savePlans(store);
          const out = [`Plan #${pid}: ${args.name}`, `Goal: ${args.goal}`, `Steps: ${steps.length}`, ''];
          for (const s of steps) {
            const deps = s.dependencies.length ? ` (after: ${s.dependencies.join(', ')})` : '';
            const est = s.estimate ? ` [${s.estimate}]` : '';
            out.push(`  ${s.id}. ${s.description}${deps}${est}`);
          }
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'show': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          const done = plan.steps.filter(s => s.status === 'completed').length;
          const out = [`Plan #${plan.id}: ${plan.name} [${plan.status}]`, `Goal: ${plan.goal}`, `Progress: ${done}/${plan.steps.length} (${Math.round(done / plan.steps.length * 100)}%)`, ''];
          if (plan.tags?.length) out.push(`Tags: ${plan.tags.join(', ')}`);
          if (plan.notes) out.push(`Notes: ${plan.notes.substring(0, 200)}`);
          out.push('');
          for (const s of plan.steps) {
            const deps = s.dependencies.length ? ` ← ${s.dependencies.join(',')}` : '';
            const est = s.estimate ? ` [${s.estimate}]` : '';
            const assignee = s.assignee ? ` @${s.assignee}` : '';
            out.push(`  ${icons[s.status] || '[ ]'} ${s.id}. ${s.description}${deps}${est}${assignee}`);
            if (s.output) out.push(`       → ${s.output.substring(0, 120)}`);
          }
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'update': {
          if (!args.id || !args.stepId || !args.status) return { content: [{ type: 'text', text: 'id, stepId, status required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          const step = plan.steps.find(s => s.id === args.stepId);
          if (!step) return { content: [{ type: 'text', text: `Step '${args.stepId}' not found` }], isError: true };
          step.status = args.status as Step['status'];
          if (args.output) step.output = args.output;
          plan.updated = new Date().toISOString();
          if (plan.steps.every(s => s.status === 'completed' || s.status === 'skipped')) plan.status = 'completed';
          await savePlans(store);
          const done = plan.steps.filter(s => s.status === 'completed').length;
          const next = plan.steps.find(s => s.status === 'pending' && s.dependencies.every(d => plan.steps.find(x => x.id === d)?.status === 'completed'));
          let text = `Updated ${args.stepId}: ${args.status} (${done}/${plan.steps.length})`;
          if (next) text += `\nNext: ${next.id}. ${next.description}`;
          if (plan.status === 'completed') text += '\nPlan completed!';
          return { content: [{ type: 'text', text }] };
        }

        case 'list': {
          let plans = store.plans;
          if (args.filter && args.filter !== 'all') plans = plans.filter(p => p.status === args.filter);
          plans = plans.slice(-(args.limit || 20));
          if (!plans.length) return { content: [{ type: 'text', text: 'No plans' }] };
          const out = plans.map(p => {
            const done = p.steps.filter(s => s.status === 'completed').length;
            return `#${p.id} [${p.status}] ${p.name} — ${done}/${p.steps.length} ${p.tags?.length ? `[${p.tags.join(',')}]` : ''}`;
          });
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'next': {
          const plan = findPlan(args.id || 'latest');
          if (!plan) return { content: [{ type: 'text', text: 'No active plan' }], isError: true };
          const doneIds = new Set(plan.steps.filter(s => s.status === 'completed').map(s => s.id));
          const actionable = plan.steps.filter(s => s.status === 'pending' && s.dependencies.every(d => doneIds.has(d)));
          if (!actionable.length) {
            const blocked = plan.steps.filter(s => s.status === 'blocked');
            const inProgress = plan.steps.filter(s => s.status === 'in_progress');
            return { content: [{ type: 'text', text: `No actionable steps. In progress: ${inProgress.length}, Blocked: ${blocked.length}` }] };
          }
          const out = actionable.map(s => {
            const est = s.estimate ? ` [${s.estimate}]` : '';
            const tools = s.tools?.length ? ` (tools: ${s.tools.join(', ')})` : '';
            return `${s.id}. ${s.description}${est}${tools}`;
          });
          return { content: [{ type: 'text', text: `Next steps:\n${out.join('\n')}` }] };
        }

        case 'archive': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          plan.status = 'archived';
          plan.updated = new Date().toISOString();
          await savePlans(store);
          return { content: [{ type: 'text', text: `Archived plan #${plan.id}: ${plan.name}` }] };
        }

        case 'add_step': {
          if (!args.id || !args.description) return { content: [{ type: 'text', text: 'id and description required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          const maxStep = Math.max(...plan.steps.map(s => parseInt(s.id.split('.')[1]) || 0));
          const newStep: Step = {
            id: `${plan.id}.${maxStep + 1}`,
            description: args.description,
            status: 'pending',
            dependencies: args.dependencies || [],
            estimate: args.text
          };
          if (args.after) {
            const idx = plan.steps.findIndex(s => s.id === args.after);
            if (idx >= 0) plan.steps.splice(idx + 1, 0, newStep);
            else plan.steps.push(newStep);
          } else {
            plan.steps.push(newStep);
          }
          plan.updated = new Date().toISOString();
          await savePlans(store);
          return { content: [{ type: 'text', text: `Added step ${newStep.id}: ${args.description}` }] };
        }

        case 'remove_step': {
          if (!args.id || !args.stepId) return { content: [{ type: 'text', text: 'id and stepId required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          const idx = plan.steps.findIndex(s => s.id === args.stepId);
          if (idx < 0) return { content: [{ type: 'text', text: `Step '${args.stepId}' not found` }], isError: true };
          // Remove dependencies on this step
          for (const s of plan.steps) s.dependencies = s.dependencies.filter(d => d !== args.stepId);
          plan.steps.splice(idx, 1);
          plan.updated = new Date().toISOString();
          await savePlans(store);
          return { content: [{ type: 'text', text: `Removed step ${args.stepId}` }] };
        }

        case 'estimate': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          const estimated = plan.steps.filter(s => s.estimate);
          const pending = plan.steps.filter(s => s.status === 'pending' || s.status === 'in_progress');
          return { content: [{ type: 'text', text: `Plan #${plan.id}: ${plan.name}\n  Total steps: ${plan.steps.length}\n  Estimated: ${estimated.length}/${plan.steps.length}\n  Remaining: ${pending.length}\n  Estimates: ${estimated.map(s => `${s.id}: ${s.estimate}`).join(', ')}` }] };
        }

        case 'visualize': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const maybePlan = findPlan(args.id);
          if (!maybePlan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          const plan = maybePlan;
          // Text-based DAG visualization
          const lines = [`Plan #${plan.id}: ${plan.name}\n`];
          const levels = new Map<string, number>();
          // Topological sort for levels
          function getLevel(stepId: string): number {
            if (levels.has(stepId)) return levels.get(stepId)!;
            const step = plan.steps.find(s => s.id === stepId);
            if (!step || !step.dependencies.length) { levels.set(stepId, 0); return 0; }
            const maxDep = Math.max(...step.dependencies.map(d => getLevel(d)));
            levels.set(stepId, maxDep + 1);
            return maxDep + 1;
          }
          for (const s of plan.steps) getLevel(s.id);
          const maxLevel = Math.max(...[...levels.values()], 0);
          for (let l = 0; l <= maxLevel; l++) {
            const atLevel = plan.steps.filter(s => levels.get(s.id) === l);
            if (atLevel.length) {
              lines.push(`Level ${l}:`);
              for (const s of atLevel) {
                const arrow = s.dependencies.length ? ` ← [${s.dependencies.join(',')}]` : '';
                lines.push(`  ${icons[s.status]} ${s.id}. ${s.description}${arrow}`);
              }
            }
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        case 'clone': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          store.lastId++;
          const newId = String(store.lastId);
          const now = new Date().toISOString();
          const newSteps = plan.steps.map((s, i) => ({
            ...s, id: `${newId}.${i + 1}`, status: 'pending' as const, output: undefined
          }));
          store.plans.push({
            id: newId, name: args.name || `${plan.name} (copy)`, goal: plan.goal,
            steps: newSteps, created: now, updated: now, status: 'draft', tags: plan.tags
          });
          await savePlans(store);
          return { content: [{ type: 'text', text: `Cloned plan #${plan.id} → #${newId}` }] };
        }

        case 'cancel': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          plan.status = 'cancelled';
          plan.updated = new Date().toISOString();
          await savePlans(store);
          return { content: [{ type: 'text', text: `Cancelled plan #${plan.id}: ${plan.name}` }] };
        }

        case 'notes': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          if (args.text) {
            plan.notes = (plan.notes || '') + '\n' + args.text;
            plan.updated = new Date().toISOString();
            await savePlans(store);
            return { content: [{ type: 'text', text: `Added note to plan #${plan.id}` }] };
          }
          return { content: [{ type: 'text', text: plan.notes || '(no notes)' }] };
        }

        case 'progress': {
          if (!args.id) return { content: [{ type: 'text', text: 'id required' }], isError: true };
          const plan = findPlan(args.id);
          if (!plan) return { content: [{ type: 'text', text: `Plan '${args.id}' not found` }], isError: true };
          const byStatus: Record<string, number> = {};
          for (const s of plan.steps) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
          const done = byStatus.completed || 0;
          const total = plan.steps.length;
          const bar = '█'.repeat(Math.round(done / total * 20)) + '░'.repeat(20 - Math.round(done / total * 20));
          return { content: [{ type: 'text', text: `Plan #${plan.id}: ${plan.name}\n${bar} ${Math.round(done / total * 100)}%\n${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(' | ')}` }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const planTools = [planTool];
