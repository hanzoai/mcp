/**
 * Work items — the Hanzo Cloud /v1/task surface as MCP tools.
 *
 * The cloud surface these tools were written against, /v1/tracker, was renamed
 * to /v1/task (cloud apps/task); every tracker_* call answered 404 since. The
 * board is now the FORGE: a board is a repository on forge.hanzo.ai, a work item
 * is a forge issue, a column is a label. Cloud resolves the caller's forge
 * account from their Hanzo identity and acts as them (Sudo), so the forge's own
 * ACL and audit apply — no forge credential ever reaches this process.
 *
 *   tracker_boards           GET   /v1/task/projects
 *   tracker_issues           GET   /v1/task/projects/{key}/issues   (or /v1/task/board with no key)
 *   tracker_issue            GET   /v1/task/projects/{key}/issues/{num}
 *   tracker_create           POST  /v1/task/projects/{key}/issues
 *   tracker_update           PATCH /v1/task/projects/{key}/issues/{num}
 *   tracker_close            PATCH …/issues/{num}  {status: done}
 *   tracker_comment          PATCH …/issues/{num}  {comment}
 *   tracker_comments         GET   …/issues/{num}/comments
 *   tracker_labels           GET   /v1/task/projects/{key}/labels          (cloud patch)
 *   tracker_label_create     POST  /v1/task/projects/{key}/labels          (cloud patch)
 *   tracker_label_edit       PATCH /v1/task/projects/{key}/labels/{id}     (cloud patch)
 *   tracker_milestones       GET   /v1/task/projects/{key}/milestones      (cloud patch)
 *   tracker_milestone_create POST  /v1/task/projects/{key}/milestones      (cloud patch)
 *   tracker_milestone_edit   PATCH /v1/task/projects/{key}/milestones/{id} (cloud patch)
 *
 * Board keys are forge repository names and are sent as given (no case
 * folding): `cloud` and `ENG` are both live keys.
 *
 * Auth: the caller's Hanzo bearer (an sk- API key or an IAM access token) from
 * the environment. The org is minted server-side from that identity — a client
 * NEVER passes an org.
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

/** The path of one board. */
function board(key: string): string {
  return `/v1/task/projects/${encodeURIComponent(String(key).trim())}`;
}
function issues(key: string): string { return `${board(key)}/issues`; }
function issue(key: string, num: unknown): string { return `${issues(key)}/${encodeURIComponent(String(num))}`; }

const STATUS = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'];
const PRIORITY = ['none', 'urgent', 'high', 'medium', 'low'];

function compact(o: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

type Args = Record<string, any>;
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: (a: Args) => Promise<unknown>): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
    handler: async (args: Args) => {
      try {
        for (const r of required) if (args[r] === undefined || args[r] === null || args[r] === '') return fail(`${r} required`);
        return ok(await run(args));
      } catch (e: any) {
        return fail(e.message);
      }
    },
  } as Tool;
}

const KEY = { type: 'string', description: 'Board key = forge repository name, e.g. cloud (from tracker_boards)' };
const NUM = { type: 'number', description: 'Issue number in that repository' };

export const trackerBoardsTool = tool('tracker_boards',
  "List the boards in your org. A board is a forge repository; its `key` is what every other tracker tool takes.",
  {}, [], () => track('/v1/task/projects'));

export const trackerIssuesTool = tool('tracker_issues',
  "List work items. With `key`, one board; without it, every board in your org. Filters are passed to cloud, which refuses unknown values rather than returning an empty board.",
  { key: KEY, status: { type: 'string', enum: STATUS }, label: { type: 'string', description: 'Only items carrying this label' }, assignee: { type: 'string' }, q: { type: 'string', description: 'Text search' } },
  [], (a) => track((a.key ? issues(a.key) : '/v1/task/board') + qs({ status: a.status, label: a.label, assignee: a.assignee, q: a.q })));

export const trackerIssueTool = tool('tracker_issue', 'Read one work item, including its description.',
  { key: KEY, number: NUM }, ['key', 'number'], (a) => track(issue(a.key, a.number)));

export const trackerCreateTool = tool('tracker_create',
  'Open a work item (a forge issue) as yourself. Returns it with its identifier.',
  { key: KEY, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: STATUS, description: 'Column (default backlog)' }, priority: { type: 'string', enum: PRIORITY } },
  ['key', 'title'],
  (a) => track(issues(a.key), { method: 'POST', body: JSON.stringify(compact({ title: a.title, description: a.description, status: a.status, priority: a.priority })) }));

export const trackerUpdateTool = tool('tracker_update',
  'Edit a work item. Only the fields you pass change. `assignee: ""` unassigns; `status: done` also closes it; `comment` is posted after the other changes.',
  { key: KEY, number: NUM, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: STATUS }, priority: { type: 'string', enum: PRIORITY }, assignee: { type: 'string' }, comment: { type: 'string' } },
  ['key', 'number'],
  async (a) => {
    const body = compact({ title: a.title, description: a.description, status: a.status, priority: a.priority, assignee: a.assignee, comment: a.comment });
    if (Object.keys(body).length === 0) throw new Error('nothing to update — pass at least one field');
    return track(issue(a.key, a.number), { method: 'PATCH', body: JSON.stringify(body) });
  });

export const trackerCloseTool = tool('tracker_close', 'Close a work item (moves it to done). Optional closing comment.',
  { key: KEY, number: NUM, comment: { type: 'string' } }, ['key', 'number'],
  (a) => track(issue(a.key, a.number), { method: 'PATCH', body: JSON.stringify(compact({ status: 'done', comment: a.comment })) }));

export const trackerCommentTool = tool('tracker_comment', 'Comment on a work item as yourself.',
  { key: KEY, number: NUM, body: { type: 'string' } }, ['key', 'number', 'body'],
  (a) => track(issue(a.key, a.number), { method: 'PATCH', body: JSON.stringify({ comment: a.body }) }));

export const trackerCommentsTool = tool('tracker_comments', "Read a work item's comments.",
  { key: KEY, number: NUM }, ['key', 'number'], (a) => track(`${issue(a.key, a.number)}/comments`));

const LABEL = { name: { type: 'string' }, color: { type: 'string', description: 'Hex, e.g. #ee0701' }, description: { type: 'string' } };
export const trackerLabelsTool = tool('tracker_labels', "List a board's labels.", { key: KEY }, ['key'], (a) => track(`${board(a.key)}/labels`));
export const trackerLabelCreateTool = tool('tracker_label_create', 'Create a label on a board.', { key: KEY, ...LABEL }, ['key', 'name', 'color'],
  (a) => track(`${board(a.key)}/labels`, { method: 'POST', body: JSON.stringify(compact({ name: a.name, color: a.color, description: a.description })) }));
export const trackerLabelEditTool = tool('tracker_label_edit', 'Edit a label. Only the fields you pass change.', { key: KEY, id: { type: 'number' }, ...LABEL }, ['key', 'id'],
  (a) => track(`${board(a.key)}/labels/${encodeURIComponent(String(a.id))}`, { method: 'PATCH', body: JSON.stringify(compact({ name: a.name, color: a.color, description: a.description })) }));

const MILESTONE = { title: { type: 'string' }, description: { type: 'string' }, due: { type: 'string', description: 'RFC 3339 due date' }, state: { type: 'string', enum: ['open', 'closed'] } };
export const trackerMilestonesTool = tool('tracker_milestones', "List a board's milestones.", { key: KEY, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['key'],
  (a) => track(`${board(a.key)}/milestones` + qs({ state: a.state })));
export const trackerMilestoneCreateTool = tool('tracker_milestone_create', 'Create a milestone on a board.', { key: KEY, ...MILESTONE }, ['key', 'title'],
  (a) => track(`${board(a.key)}/milestones`, { method: 'POST', body: JSON.stringify(compact({ title: a.title, description: a.description, due: a.due })) }));
export const trackerMilestoneEditTool = tool('tracker_milestone_edit', 'Edit or close a milestone. Only the fields you pass change.', { key: KEY, id: { type: 'number' }, ...MILESTONE }, ['key', 'id'],
  (a) => track(`${board(a.key)}/milestones/${encodeURIComponent(String(a.id))}`, { method: 'PATCH', body: JSON.stringify(compact({ title: a.title, description: a.description, due: a.due, state: a.state })) }));

export const trackerTools: Tool[] = [
  trackerBoardsTool, trackerIssuesTool, trackerIssueTool, trackerCreateTool, trackerUpdateTool,
  trackerCloseTool, trackerCommentTool, trackerCommentsTool,
  trackerLabelsTool, trackerLabelCreateTool, trackerLabelEditTool,
  trackerMilestonesTool, trackerMilestoneCreateTool, trackerMilestoneEditTool,
];
