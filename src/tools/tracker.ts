/**
 * Work items — the Hanzo Cloud /v1/tracker surface as MCP tools.
 *
 * This is how an agent reports on its own work. Hanzo has exactly ONE work-item
 * primitive — the cloud tracker Issue (cloud apps/tracker/contract.go is law) —
 * and these tools are a thin, named projection of it. One tool per job:
 *
 *   tracker_boards  GET   /v1/tracker/projects                    the org's boards
 *   tracker_issues  GET   /v1/tracker/projects/{key}/issues       ?status&kind&source&repo
 *   tracker_create  POST  /v1/tracker/projects/{key}/issues       open a work item
 *   tracker_update  PATCH /v1/tracker/projects/{key}/issues/{num} move / assign / link
 *
 * NOT to be confused with the local `tasks` tool (a private todo file) or with
 * hanzoai/tasks (durable async execution). Those are different planes; this one
 * is the shared board a human can see.
 *
 * LINKING A RUN. An agent's run is a SESSION (`/v1/agents/sessions`). A work item
 * points at one through `extRef`, which the tracker contract defines as "a link
 * INTO another plane", using the anchor `session:<id>`. Pass `session` and these
 * tools write that anchor — there is no second field and no metadata bag.
 *
 * Auth mirrors hanzo-cloud.ts and code-intel.ts EXACTLY: the caller's Hanzo
 * bearer from the environment. The org is minted server-side from that identity —
 * a client NEVER passes an org, and cloud strips one if it tries.
 */

import { Tool } from '../types/index.js';

// Resolved at call time (like code-intel's) so the endpoint is overridable for
// tests and self-hosted gateways without a rebuild.
function apiBase(): string { return process.env.API_URL || 'https://api.hanzo.ai'; }
function token(): string { return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || ''; }

// track() is the ONE request path: Bearer auth, JSON in and out. A non-2xx throws
// `${status}: ${body}` exactly as hanzo-cloud's api(), so cloud's own refusal
// ("unknown status filter", "project not found") reaches the agent verbatim
// instead of being flattened into a generic failure.
async function track(path: string, opts: RequestInit = {}): Promise<unknown> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const r = await fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${t}`, ...(opts.headers || {}) },
  });
  if (!r.ok) { const b = await r.text().catch(() => ''); throw new Error(`${r.status}: ${b.substring(0, 200)}`); }
  const txt = await r.text();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return txt; }
}

function ok(v: unknown) { return { content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] }; }
function fail(m: string) { return { content: [{ type: 'text' as const, text: `Error: ${m}` }], isError: true as const }; }

// qs builds a query string, dropping undefined/empty values.
function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** The path of one board's issues. The key is uppercased as cloud stores it. */
function issues(key: string): string {
  return `/v1/tracker/projects/${encodeURIComponent(String(key).trim().toUpperCase())}/issues`;
}

/** The `extRef` anchor for an agent session — the ONE link format. */
function anchor(session?: string, extRef?: string): string | undefined {
  if (session) return `session:${session}`;
  return extRef || undefined;
}

const STATUS = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
const PRIORITY = ['none', 'urgent', 'high', 'medium', 'low'];
const KIND = ['issue', 'pr', 'epic'];
const SOURCE = ['team', 'git', 'crm', 'helpdesk', 'cms', 'agent'];

// =============================================
// tracker_boards — the org's boards
// =============================================

export const trackerBoardsTool: Tool = {
  name: 'tracker_boards',
  description: "List the work-item boards in your org. Returns [{id,org,key,name,description,createdAt,updatedAt}]. The `key` is what every other tracker tool takes — call this first when you do not know it. A board's issues are identified KEY-1, KEY-2, …",
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    try {
      return ok(await track('/v1/tracker/projects'));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

// =============================================
// tracker_issues — one board's work items
// =============================================

export const trackerIssuesTool: Tool = {
  name: 'tracker_issues',
  description: "List a board's work items. Returns [{id,identifier,projectKey,number,kind,source,repo,extRef,title,description,status,priority,assignee,labels,createdAt,updatedAt}]. Filters are AND-ed and each is a closed set — an unknown value is refused rather than silently returning an empty board. Use source=agent to see only work agents opened; an item's extRef `session:<id>` names the agent session behind it.",
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Board key, e.g. ENG (from tracker_boards)' },
      status: { type: 'string', enum: STATUS, description: 'Board column' },
      kind: { type: 'string', enum: KIND, description: 'What the item is' },
      source: { type: 'string', enum: SOURCE, description: 'Which surface opened it' },
      repo: { type: 'string', description: 'Only items bound to this git repository' },
    },
    required: ['key'],
  },
  handler: async (args) => {
    try {
      if (!args.key) return fail('key required');
      return ok(await track(issues(args.key) + qs({ status: args.status, kind: args.kind, source: args.source, repo: args.repo })));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

// =============================================
// tracker_create — open a work item
// =============================================

export const trackerCreateTool: Tool = {
  name: 'tracker_create',
  description: "Open a work item on a board — this is how you put your work somewhere a human can see it. Returns the created issue including its identifier (KEY-N). `source` defaults to agent, because a work item opened through this tool WAS opened by an agent and the board filters on that. Pass `session` with your agent-session id to link the item to the run doing it; its live status then shows on the board.",
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Board key, e.g. ENG (from tracker_boards)' },
      title: { type: 'string', description: 'One line saying what needs doing' },
      description: { type: 'string', description: 'The detail behind the title' },
      status: { type: 'string', enum: STATUS, description: 'Board column (default backlog)' },
      priority: { type: 'string', enum: PRIORITY, description: 'Default none' },
      assignee: { type: 'string', description: 'Who holds it' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Free-form tags' },
      kind: { type: 'string', enum: KIND, description: 'What it is (default issue)' },
      source: { type: 'string', enum: SOURCE, description: 'Which surface opened it (default agent)' },
      repo: { type: 'string', description: 'Git repository this work belongs to' },
      session: { type: 'string', description: 'Agent-session id to link — stored as extRef `session:<id>`' },
      extRef: { type: 'string', description: 'Raw external anchor, when it is not a session (e.g. a PR branch)' },
    },
    required: ['key', 'title'],
  },
  handler: async (args) => {
    try {
      if (!args.key) return fail('key required');
      if (!args.title) return fail('title required');
      const body: Record<string, unknown> = {
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        assignee: args.assignee,
        labels: args.labels,
        kind: args.kind,
        source: args.source || 'agent',
        repo: args.repo,
        extRef: anchor(args.session, args.extRef),
      };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      return ok(await track(issues(args.key), { method: 'POST', body: JSON.stringify(body) }));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

// =============================================
// tracker_update — move, assign, link
// =============================================

export const trackerUpdateTool: Tool = {
  name: 'tracker_update',
  description: "Update one work item by its board key and number (ENG-14 → key ENG, number 14). Only the fields you pass change. This is how an agent reports progress: move to in_progress when you start and done when you finish. Pass `session` to link (or relink) the item to the agent session doing the work.",
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Board key, e.g. ENG' },
      number: { type: 'number', description: 'Issue number within the board — the 14 of ENG-14' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      status: { type: 'string', enum: STATUS, description: 'Move to this column' },
      priority: { type: 'string', enum: PRIORITY },
      assignee: { type: 'string', description: 'Hand it to someone' },
      labels: { type: 'array', items: { type: 'string' } },
      session: { type: 'string', description: 'Agent-session id to link — stored as extRef `session:<id>`' },
      extRef: { type: 'string', description: 'Raw external anchor, when it is not a session' },
    },
    required: ['key', 'number'],
  },
  handler: async (args) => {
    try {
      if (!args.key) return fail('key required');
      if (args.number === undefined || args.number === null) return fail('number required');
      const body: Record<string, unknown> = {
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        assignee: args.assignee,
        labels: args.labels,
        extRef: anchor(args.session, args.extRef),
      };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      if (Object.keys(body).length === 0) return fail('nothing to update — pass at least one field');
      return ok(await track(`${issues(args.key)}/${encodeURIComponent(String(args.number))}`, { method: 'PATCH', body: JSON.stringify(body) }));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

export const trackerTools: Tool[] = [trackerBoardsTool, trackerIssuesTool, trackerCreateTool, trackerUpdateTool];
