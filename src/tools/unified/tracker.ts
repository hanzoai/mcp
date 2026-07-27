/**
 * tracker — Hanzo work Tracker (HIP-0300)
 *
 * One tool for the issue-tracking axis: projects + issues (Linear-style),
 * with atomic per-agent claim/release/heartbeat leasing so many agents can
 * work a shared backlog without double-claiming an issue. Remote — talks to
 * the live cloud tracker service (api.hanzo.ai/v1/tracker), NOT the local
 * file-based `tasks`/`plan` tools.
 */

import { Tool } from '../../types/index.js';

const TRACKER_URL = process.env.TRACKER_URL || process.env.API_URL || 'https://api.hanzo.ai';
const enc = encodeURIComponent;

function token(): string {
  return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || '';
}

async function api(method: string, path: string, body?: any): Promise<any> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${TRACKER_URL}${path}`, opts);
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    const err: any = new Error(`${r.status}: ${b.substring(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  if (r.status === 204) return null;
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'tracker', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'tracker' } }, null, 2) }], isError: true as const };
}

// issueBody extracts the createIssueReq/updateIssueReq wire fields from any
// source object (top-level args, or one element of a batch `issues` array).
function issueBody(o: any) {
  return {
    kind: o.kind, source: o.source, title: o.title, description: o.description,
    status: o.status, priority: o.priority, assignee: o.assignee, labels: o.labels,
    repo: o.repo, extRef: o.extRef,
  };
}

const issueItemSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['issue', 'pr', 'epic'] },
    source: { type: 'string', enum: ['team', 'git', 'crm', 'helpdesk', 'cms', 'agent'] },
    title: { type: 'string' },
    description: { type: 'string' },
    status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'done', 'canceled'] },
    priority: { type: 'string', enum: ['none', 'urgent', 'high', 'medium', 'low'] },
    assignee: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
    repo: { type: 'string' },
    extRef: { type: 'string' },
  },
  required: ['title'],
};

export const trackerTool: Tool = {
  name: 'tracker',
  description: 'Hanzo Tracker — projects & issues (Linear-style) with atomic agent claim/release/heartbeat leasing. Actions: list_projects, create_project, get_project, update_project, delete_project, list_issues, create_issue (batchable via issues[]), get_issue, update_issue, delete_issue, claim, release, heartbeat, who_owns, in_progress',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'list_projects', 'create_project', 'get_project', 'update_project', 'delete_project',
        'list_issues', 'create_issue', 'get_issue', 'update_issue', 'delete_issue',
        'claim', 'release', 'heartbeat', 'who_owns', 'in_progress'
      ], description: 'Tracker action' },
      key: { type: 'string', description: 'Project key, e.g. "ZMCP" (^[A-Z][A-Z0-9]{1,7}$; server derives/uppercases it if omitted on create)' },
      name: { type: 'string', description: 'Project name (create_project, update_project)' },
      description: { type: 'string', description: 'Project or issue description' },
      num: { type: 'number', description: 'Issue number, e.g. 42 for ZMCP-42 (get_issue, update_issue, delete_issue, claim, release, heartbeat, who_owns)' },
      kind: { type: 'string', enum: ['issue', 'pr', 'epic'], description: 'Work-item shape, default issue (create_issue, list_issues filter)' },
      source: { type: 'string', enum: ['team', 'git', 'crm', 'helpdesk', 'cms', 'agent'], description: 'Opening surface, default team (create_issue, list_issues filter)' },
      title: { type: 'string', description: 'Issue title (create_issue, update_issue)' },
      status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'done', 'canceled'], description: 'Issue status (create_issue, update_issue, list_issues filter)' },
      priority: { type: 'string', enum: ['none', 'urgent', 'high', 'medium', 'low'], description: 'Issue priority (create_issue, update_issue)' },
      assignee: { type: 'string', description: 'Assignee (create_issue, update_issue)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels (create_issue, update_issue)' },
      repo: { type: 'string', description: 'Git repo binding (create_issue, update_issue, list_issues filter)' },
      extRef: { type: 'string', description: 'External anchor / link into another plane (create_issue, update_issue)' },
      issues: { type: 'array', items: issueItemSchema, description: 'Batch-create multiple issues in one call instead of the single title/kind/... fields (create_issue)' },
      claim: { type: 'string', enum: ['unclaimed', 'mine'], description: 'Ownership filter for list_issues/in_progress — pair "mine" with agent' },
      agent: { type: 'string', description: 'Agent identity — required for claim, release, heartbeat; also a list_issues/in_progress filter alongside claim="mine"' },
      ttlSeconds: { type: 'number', description: 'Claim lease TTL in seconds (claim, heartbeat); server default applies if omitted' },
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'list_projects':
          return envelope(await api('GET', '/v1/tracker/projects'), 'list_projects');

        case 'create_project': {
          if (!args.name) return fail('INVALID_PARAMS', 'name required');
          const body: any = { name: args.name };
          if (args.key) body.key = args.key;
          if (args.description !== undefined) body.description = args.description;
          return envelope(await api('POST', '/v1/tracker/projects', body), 'create_project');
        }

        case 'get_project': {
          if (!args.key) return fail('INVALID_PARAMS', 'key required');
          return envelope(await api('GET', `/v1/tracker/projects/${enc(args.key)}`), 'get_project');
        }

        case 'update_project': {
          if (!args.key) return fail('INVALID_PARAMS', 'key required');
          const body: any = {};
          if (args.name !== undefined) body.name = args.name;
          if (args.description !== undefined) body.description = args.description;
          return envelope(await api('PATCH', `/v1/tracker/projects/${enc(args.key)}`, body), 'update_project');
        }

        case 'delete_project': {
          if (!args.key) return fail('INVALID_PARAMS', 'key required');
          await api('DELETE', `/v1/tracker/projects/${enc(args.key)}`);
          return envelope({ key: args.key, deleted: true }, 'delete_project');
        }

        case 'list_issues':
        case 'in_progress': {
          if (!args.key) return fail('INVALID_PARAMS', 'key required');
          const qs = new URLSearchParams();
          const status = args.action === 'in_progress' ? 'in_progress' : args.status;
          if (status) qs.set('status', status);
          if (args.kind) qs.set('kind', args.kind);
          if (args.source) qs.set('source', args.source);
          if (args.repo) qs.set('repo', args.repo);
          if (args.claim) qs.set('claim', args.claim);
          if (args.agent) qs.set('agent', args.agent);
          const q = qs.toString();
          return envelope(await api('GET', `/v1/tracker/projects/${enc(args.key)}/issues${q ? `?${q}` : ''}`), args.action);
        }

        case 'create_issue': {
          if (!args.key) return fail('INVALID_PARAMS', 'key required');
          if (Array.isArray(args.issues)) {
            if (!args.issues.length) return fail('INVALID_PARAMS', 'issues array is empty');
            for (const it of args.issues) if (!it.title) return fail('INVALID_PARAMS', 'each issue requires title');
            const out: any[] = [];
            for (const it of args.issues) out.push(await api('POST', `/v1/tracker/projects/${enc(args.key)}/issues`, issueBody(it)));
            return envelope(out, 'create_issue');
          }
          if (!args.title) return fail('INVALID_PARAMS', 'title required (or pass issues[] for batch)');
          return envelope(await api('POST', `/v1/tracker/projects/${enc(args.key)}/issues`, issueBody(args)), 'create_issue');
        }

        case 'get_issue':
        case 'who_owns': {
          if (!args.key || !args.num) return fail('INVALID_PARAMS', 'key and num required');
          return envelope(await api('GET', `/v1/tracker/projects/${enc(args.key)}/issues/${args.num}`), args.action);
        }

        case 'update_issue': {
          if (!args.key || !args.num) return fail('INVALID_PARAMS', 'key and num required');
          const body: any = {};
          if (args.title !== undefined) body.title = args.title;
          if (args.description !== undefined) body.description = args.description;
          if (args.status !== undefined) body.status = args.status;
          if (args.priority !== undefined) body.priority = args.priority;
          if (args.assignee !== undefined) body.assignee = args.assignee;
          if (args.labels !== undefined) body.labels = args.labels;
          return envelope(await api('PATCH', `/v1/tracker/projects/${enc(args.key)}/issues/${args.num}`, body), 'update_issue');
        }

        case 'delete_issue': {
          if (!args.key || !args.num) return fail('INVALID_PARAMS', 'key and num required');
          await api('DELETE', `/v1/tracker/projects/${enc(args.key)}/issues/${args.num}`);
          return envelope({ key: args.key, num: args.num, deleted: true }, 'delete_issue');
        }

        case 'claim': {
          if (!args.key || !args.num || !args.agent) return fail('INVALID_PARAMS', 'key, num, agent required');
          const body: any = { agent: args.agent };
          if (args.ttlSeconds) body.ttlSeconds = args.ttlSeconds;
          try {
            const issue = await api('POST', `/v1/tracker/projects/${enc(args.key)}/issues/${args.num}/claim`, body);
            return envelope({ claimed: true, held: false, issue }, 'claim');
          } catch (e: any) {
            if (e.status === 409) return envelope({ claimed: false, held: true }, 'claim');
            throw e;
          }
        }

        case 'release': {
          if (!args.key || !args.num || !args.agent) return fail('INVALID_PARAMS', 'key, num, agent required');
          await api('POST', `/v1/tracker/projects/${enc(args.key)}/issues/${args.num}/release`, { agent: args.agent });
          return envelope({ released: true }, 'release');
        }

        case 'heartbeat': {
          if (!args.key || !args.num || !args.agent) return fail('INVALID_PARAMS', 'key, num, agent required');
          const body: any = { agent: args.agent };
          if (args.ttlSeconds) body.ttlSeconds = args.ttlSeconds;
          try {
            await api('POST', `/v1/tracker/projects/${enc(args.key)}/issues/${args.num}/heartbeat`, body);
            return envelope({ extended: true, held: false }, 'heartbeat');
          } catch (e: any) {
            if (e.status === 409) return envelope({ extended: false, held: true }, 'heartbeat');
            throw e;
          }
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
