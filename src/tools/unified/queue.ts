/**
 * queue — Hanzo Tasks durable job queue (HIP-0300, REMOTE)
 *
 * One tool for the durable-execution axis: enqueue/list/get/cancel
 * standalone activities on the live Hanzo Tasks engine (tasks-api.hanzo.ai),
 * plus a bounded tail of the live SSE event stream. Named `queue` — not
 * `tasks` — to stay clear of the local, file-based `tasks` todo-list tool:
 * this one is remote and durable, that one is local and ephemeral.
 */

import { Tool } from '../../types/index.js';

const TASKS_URL = process.env.TASKS_URL || process.env.TASKS_API_URL || 'https://tasks-api.hanzo.ai';
const enc = encodeURIComponent;

function token(): string {
  return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || '';
}

async function api(method: string, path: string, body?: any): Promise<any> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${TASKS_URL}${path}`, opts);
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

// tailEvents opens the SSE stream and collects a bounded batch — up to
// `limit` events or `timeoutMs`, whichever comes first — then aborts. There
// is no "give me the last N" REST endpoint on the wire; this is the
// poll-shaped read the /v1/tasks/events SSE stream supports.
async function tailEvents(limit: number, timeoutMs: number): Promise<any[]> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events: any[] = [];
  try {
    const r = await fetch(`${TASKS_URL}/v1/tasks/events`, {
      headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'text/event-stream' },
      signal: ac.signal,
    });
    if (!r.ok || !r.body) {
      const b = await r.text().catch(() => '');
      throw new Error(`${r.status}: ${b.substring(0, 200)}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (events.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1 && events.length < limit) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
        if (data) { try { events.push(JSON.parse(data)); } catch { events.push(data); } }
      }
    }
    await reader.cancel().catch(() => {});
  } catch (e: any) {
    if (e.name !== 'AbortError') throw e;
    // AbortError from the timeout is expected — return whatever we collected.
  } finally {
    clearTimeout(timer);
  }
  return events;
}

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'queue', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'queue' } }, null, 2) }], isError: true as const };
}

export const queueTool: Tool = {
  name: 'queue',
  description: 'Hanzo Tasks durable job queue (remote, tasks-api.hanzo.ai) — enqueue, list, get, cancel activities; events tails the live SSE stream. Distinct from the local `tasks` todo-list tool.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['enqueue', 'list', 'get', 'cancel', 'events'], description: 'Queue action' },
      namespace: { type: 'string', default: 'default', description: 'Tasks namespace (org-scoped tenant boundary)' },
      taskQueue: { type: 'string', description: 'Worker task queue name (enqueue)' },
      activityType: { type: 'string', description: 'Activity type name a worker registers for (enqueue)' },
      input: { description: 'JSON payload passed to the activity (enqueue)' },
      activityId: { type: 'string', description: 'Client-supplied activity id (enqueue optional; required for get/cancel)' },
      runId: { type: 'string', description: 'Run id (enqueue optional; required for get/cancel — both are returned by enqueue)' },
      retryPolicy: {
        type: 'object', description: 'Retry policy (enqueue)',
        properties: {
          initialInterval: { type: 'string' }, backoffCoefficient: { type: 'number' },
          maximumInterval: { type: 'string' }, maximumAttempts: { type: 'number' },
          nonRetryableErrorTypes: { type: 'array', items: { type: 'string' } },
        },
      },
      scheduleToCloseTimeout: { type: 'string', description: 'Duration string e.g. "5m" (enqueue)' },
      scheduleToStartTimeout: { type: 'string', description: 'Duration string e.g. "30s" (enqueue)' },
      startToCloseTimeout: { type: 'string', description: 'Duration string e.g. "2m" (enqueue)' },
      heartbeatTimeout: { type: 'string', description: 'Duration string e.g. "10s" (enqueue)' },
      identity: { type: 'string', description: 'Caller identity string (enqueue, cancel) — distinct from the IAM bearer token' },
      requestId: { type: 'string', description: 'Idempotency key (enqueue)' },
      reason: { type: 'string', description: 'Cancellation reason (cancel)' },
      cursor: { type: 'string', description: 'Pagination cursor (list)' },
      pageSize: { type: 'number', description: 'Page size (list); server default applies if omitted' },
      limit: { type: 'number', default: 20, description: 'Max events to collect (events)' },
      timeoutMs: { type: 'number', default: 3000, description: 'Max time to wait collecting events before returning the batch (events)' },
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const ns = args.namespace || 'default';
      switch (args.action) {
        case 'enqueue': {
          if (!args.taskQueue || !args.activityType) return fail('INVALID_PARAMS', 'taskQueue and activityType required');
          const body: any = { activityType: { name: args.activityType }, taskQueue: args.taskQueue };
          if (args.activityId) body.activityId = args.activityId;
          if (args.runId) body.runId = args.runId;
          if (args.input !== undefined) body.input = args.input;
          if (args.retryPolicy) body.retryPolicy = args.retryPolicy;
          if (args.scheduleToCloseTimeout) body.scheduleToCloseTimeout = args.scheduleToCloseTimeout;
          if (args.scheduleToStartTimeout) body.scheduleToStartTimeout = args.scheduleToStartTimeout;
          if (args.startToCloseTimeout) body.startToCloseTimeout = args.startToCloseTimeout;
          if (args.heartbeatTimeout) body.heartbeatTimeout = args.heartbeatTimeout;
          if (args.identity) body.identity = args.identity;
          if (args.requestId) body.requestId = args.requestId;
          return envelope(await api('POST', `/v1/tasks/namespaces/${enc(ns)}/activities`, body), 'enqueue');
        }

        case 'list': {
          const qs = new URLSearchParams();
          if (args.cursor) qs.set('cursor', args.cursor);
          if (args.pageSize) qs.set('pageSize', String(args.pageSize));
          const q = qs.toString();
          return envelope(await api('GET', `/v1/tasks/namespaces/${enc(ns)}/activities${q ? `?${q}` : ''}`), 'list');
        }

        case 'get': {
          if (!args.activityId || !args.runId) return fail('INVALID_PARAMS', 'activityId and runId required');
          return envelope(await api('GET', `/v1/tasks/namespaces/${enc(ns)}/activities/${enc(args.activityId)}/${enc(args.runId)}`), 'get');
        }

        case 'cancel': {
          if (!args.activityId || !args.runId) return fail('INVALID_PARAMS', 'activityId and runId required');
          const body: any = {};
          if (args.reason) body.reason = args.reason;
          if (args.identity) body.identity = args.identity;
          return envelope(await api('POST', `/v1/tasks/namespaces/${enc(ns)}/activities/${enc(args.activityId)}/${enc(args.runId)}/cancel`, body), 'cancel');
        }

        case 'events': {
          const events = await tailEvents(args.limit || 20, args.timeoutMs || 3000);
          return envelope({ events, count: events.length }, 'events');
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
