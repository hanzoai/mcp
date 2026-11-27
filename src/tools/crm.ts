/**
 * crm — Native Hanzo Cloud CRM MCP tool (HIP-0300).
 *
 * Mirrors `rust/src/tools/crm_tool.rs` 1-to-1:
 *   objects      GET    /v1/crm/objects
 *   search       GET    /v1/crm/search?q=...&objects=...&limit=...
 *   list         GET    /v1/crm/records/{object}          (404 -> /v1/base/collections/{object}/records)
 *   get          GET    /v1/crm/records/{object}/{id}     (404 -> /v1/base/collections/{object}/records/{id})
 *   create       POST   /v1/crm/records/{object}          (404 -> /v1/base/collections/{object}/records)
 *   update       PATCH  /v1/crm/records/{object}/{id}     (404 -> /v1/base/collections/{object}/records/{id})
 *   delete       DELETE /v1/crm/records/{object}/{id}     (404 -> /v1/base/collections/{object}/records/{id})
 *   merge        POST   /v1/crm/records/{object}/merge
 *   move_stage   POST   /v1/crm/deals/{id}/stage
 *   log_activity POST   /v1/crm/timeline
 *   analytics    GET    /v1/crm/analytics
 *   ai_assist    POST   /v1/crm/ai/assist
 *   send_email   POST   /v1/marketing/mail
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Tool, ToolResult } from '../types/index.js';
import { applyHanzoOrgHeader, resolveHanzoApiBase, resolveHanzoToken } from './hanzo-auth.js';
import { refusal } from './refusal.js';

export const CRM_OBJECTS = [
  'people',
  'companies',
  'opportunities',
  'tasks',
  'notes',
  'activities',
  'lists',
  'list_members',
  'candidates',
  'views',
  'segments',
  'attachments',
  'applications',
] as const;

export type CrmObject = (typeof CRM_OBJECTS)[number];

const CRM_OBJECT_SET = new Set<string>(CRM_OBJECTS);

export const CRM_ACTIONS = [
  'objects',
  'search',
  'list',
  'get',
  'create',
  'update',
  'delete',
  'merge',
  'move_stage',
  'log_activity',
  'analytics',
  'ai_assist',
  'send_email',
] as const;

export type CrmAction = (typeof CRM_ACTIONS)[number];

const CRM_ACTION_SET = new Set<string>(CRM_ACTIONS);
const AI_ASSIST_MODES = ['ask', 'enrich', 'draft_email', 'summarize'] as const;
const AI_ASSIST_MODE_SET = new Set<string>(AI_ASSIST_MODES);
const ANALYTICS_PIPELINES = new Set(['sales', 'fundraising']);
const ORG_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveCrmObject(raw: unknown): CrmObject {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'deals') return 'opportunities';
  if (CRM_OBJECT_SET.has(s)) return s as CrmObject;
  throw new Error(
    `invalid CRM object ${JSON.stringify(raw)}; allowed: people, companies, opportunities (alias: deals), tasks, notes, activities, lists, list_members, candidates, views, segments, attachments, applications`,
  );
}

function normalizeDirection(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s) return undefined;
  if (s === 'in' || s === 'inbound') return 'in';
  if (s === 'out' || s === 'outbound') return 'out';
  throw new Error(`invalid direction ${JSON.stringify(raw)}; allowed: in (inbound), out (outbound)`);
}

function validateRecordId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) throw new Error('id required');
  if (
    id.length > 256 ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('?') ||
    id.includes('#') ||
    id.includes('..') ||
    /\s/.test(id)
  ) {
    throw new Error(`invalid record id ${JSON.stringify(raw)}`);
  }
  return id;
}

function resolveOrg(raw: unknown): string | undefined {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate) return undefined;
  if (!ORG_RE.test(candidate)) {
    throw new Error(`invalid org slug ${JSON.stringify(raw)}: use letters, digits, '.', '_', or '-'`);
  }
  return candidate;
}

function tokenFromCredentialsFile(): string {
  if (process.env.JEST_WORKER_ID && process.env.HANZO_AUTH_CLI !== '1') return '';
  const home = os.homedir();
  const candidates = [
    path.join(home, '.hanzo', 'credentials.json'),
    path.join(home, '.hanzo', 'config.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pick = (obj: any): string => {
        if (!obj || typeof obj !== 'object') return '';
        for (const k of ['token', 'access_token', 'accessToken', 'apiKey', 'api_key']) {
          if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
        }
        return '';
      };
      const direct = pick(parsed);
      if (direct) return direct;
      if (typeof parsed?.active === 'string') {
        for (const container of ['profiles', 'identities', 'accounts']) {
          const nested = pick(parsed?.[container]?.[parsed.active]);
          if (nested) return nested;
        }
      }
    } catch {
      // Ignore unreadable or invalid local credential files.
    }
  }
  return '';
}

function resolveCrmToken(): string {
  const t = resolveHanzoToken();
  if (t) return t;
  return tokenFromCredentialsFile();
}

function okEnvelope(action: string, data: unknown, extraMeta?: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { ok: true, data, error: null, meta: { tool: 'crm', action, ...(extraMeta || {}) } },
          null,
          2,
        ),
      },
    ],
  };
}

function errEnvelope(action: string, code: string, message: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { ok: false, data: null, error: { code, message }, meta: { tool: 'crm', action } },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}

function plainObject(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function parseObjectsList(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let items: string[];
  if (typeof raw === 'string') {
    items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(raw)) {
    items = raw.map((x) => {
      if (typeof x !== 'string') throw new Error('objects array entries must be strings');
      return x.trim();
    }).filter(Boolean);
  } else {
    throw new Error('objects must be a comma-separated string or array of object names');
  }
  if (!items.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const obj = resolveCrmObject(item);
    if (!seen.has(obj)) {
      seen.add(obj);
      out.push(obj);
    }
  }
  return out.join(',');
}

interface HttpReply {
  status: number;
  body: unknown;
  text: string;
}

async function sendRequest(
  method: string,
  reqPath: string,
  token: string,
  org?: string,
  body?: unknown,
): Promise<HttpReply> {
  const headers = applyHanzoOrgHeader({
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  });
  if (org) headers['X-Org-Id'] = org;

  const res = await fetch(`${resolveHanzoApiBase()}${reqPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { status: res.status, body: text };
    }
  }
  return { status: res.status, body: parsed, text };
}

function extractErrorMessage(body: unknown, text: string): string {
  if (body && typeof body === 'object') {
    const b = body as any;
    for (const c of [b?.error?.message, b?.message, b?.msg, b?.error]) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
  }
  const t = text.trim();
  return t ? t.slice(0, 240) : 'request failed';
}

function finalizeReply(
  action: string,
  reply: HttpReply,
  emptyOk?: unknown,
  extraMeta?: Record<string, unknown>,
): ToolResult {
  const ref = refusal(reply.status, reply.text);
  if (ref) return ref.result;
  if (reply.status >= 200 && reply.status < 300) {
    const data = reply.body === null ? (emptyOk ?? null) : reply.body;
    return okEnvelope(action, data, extraMeta);
  }
  return errEnvelope(action, 'UPSTREAM', `${reply.status}: ${extractErrorMessage(reply.body, reply.text)}`);
}

async function callWithBaseFallback(
  action: string,
  method: string,
  crmPath: string,
  basePath: string,
  token: string,
  org?: string,
  crmBody?: unknown,
  baseBody?: unknown,
  emptyOk?: unknown,
): Promise<ToolResult> {
  const primary = await sendRequest(method, crmPath, token, org, crmBody);
  if (primary.status === 404) {
    const fb = await sendRequest(method, basePath, token, org, baseBody);
    return finalizeReply(action, fb, emptyOk, { fallback: 'base' });
  }
  return finalizeReply(action, primary, emptyOk);
}

export const crmTool: Tool = {
  name: 'crm',
  description:
    'Hanzo Cloud CRM (/v1/crm) with graceful Base fallback (/v1/base/collections/{object}/records): ' +
    'objects, search, list, get, create, update, delete, merge, move_stage, log_activity, analytics, ai_assist, send_email. ' +
    'Valid objects: people, companies, opportunities (alias: deals), tasks, notes, activities, lists, list_members, candidates, views, segments, attachments, applications.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CRM_ACTIONS],
        description:
          'CRM action: objects | search | list | get | create | update | delete | merge | move_stage | log_activity | analytics | ai_assist | send_email',
      },
      org: {
        type: 'string',
        description: 'Optional organization slug sent as X-Org-Id header (overrides HANZO_ORG)',
      },
      object: {
        type: 'string',
        enum: [
          'people',
          'companies',
          'opportunities',
          'deals',
          'tasks',
          'notes',
          'activities',
          'lists',
          'list_members',
          'candidates',
          'views',
          'segments',
          'attachments',
          'applications',
        ],
        description: 'CRM object collection (`deals` normalizes to `opportunities`)',
      },
      id: { type: 'string', description: 'Record ID (get, update, delete, move_stage, ai_assist)' },
      record_id: { type: 'string', description: 'Alias for id (ai_assist, get, update, delete)' },
      data: { type: 'object', description: 'Record fields payload (create, update) or activity metadata (log_activity)' },
      record: { type: 'object', description: 'Alias for data (create, update)' },
      key: { type: 'string', description: 'Optional unique field key for idempotent upsert (create)' },
      q: { type: 'string', description: 'Search query (search)' },
      objects: {
        description: 'Optional comma-separated string or array of CRM objects to scope search',
      },
      limit: { type: 'number', description: 'Maximum results (search)' },
      filter: { type: 'string', description: 'Filter expression (list, analytics)' },
      sort: { type: 'string', description: 'Sort expression, e.g. -created (list)' },
      search: { type: 'string', description: 'Full-text search term within collection (list)' },
      page: { type: 'number', description: '1-based page number (list)' },
      per_page: { type: 'number', description: 'Records per page (list)' },
      expand: { type: 'string', description: 'Comma-separated relation fields to expand (list, get)' },
      include: {
        type: 'string',
        description: 'Comma-separated related summaries to attach: timeline, notes, tasks, attachments, or all (get)',
      },
      source_id: { type: 'string', description: 'Source record ID to merge from (merge) or idempotency key (log_activity)' },
      target_id: { type: 'string', description: 'Target record ID to merge into (merge)' },
      fields: { type: 'object', description: 'Winning field overrides for merge' },
      stage: { type: 'string', description: 'Target deal pipeline stage (move_stage)' },
      next_step: { type: 'string', description: 'Optional updated next_step for the opportunity (move_stage)' },
      note: { type: 'string', description: 'Optional stage-change note (move_stage)' },
      kind: { type: 'string', description: 'Activity kind, e.g. call, email, meeting, note, task (log_activity)' },
      subject: { type: 'string', description: 'Activity or email subject (log_activity, send_email)' },
      snippet: { type: 'string', description: 'Short activity summary (log_activity)' },
      body: { type: 'string', description: 'Activity or email body (log_activity, send_email)' },
      at: { type: 'string', description: 'Optional RFC3339 activity timestamp (log_activity)' },
      person_id: { type: 'string', description: 'Linked person record ID (log_activity)' },
      company_id: { type: 'string', description: 'Linked company record ID (log_activity)' },
      opportunity_id: { type: 'string', description: 'Linked opportunity/deal record ID (log_activity)' },
      candidate_id: { type: 'string', description: 'Linked candidate record ID (log_activity)' },
      person: { type: 'string', description: 'Linked person record ID (send_email; alias for person_id in log_activity)' },
      company: { type: 'string', description: 'Alias for company_id (log_activity)' },
      opportunity: { type: 'string', description: 'Alias for opportunity_id (log_activity)' },
      candidate: { type: 'string', description: 'Alias for candidate_id (log_activity)' },
      direction: { type: 'string', description: 'Activity direction: in | out (aliases: inbound | outbound) (log_activity)' },
      channel: { type: 'string', description: 'Activity channel, e.g. email | phone | slack | linkedin (log_activity)' },
      mode: {
        type: 'string',
        enum: [...AI_ASSIST_MODES],
        description: 'AI assist mode: ask | enrich | draft_email | summarize (ai_assist)',
      },
      prompt: { type: 'string', description: 'Instruction or question for AI assist (ai_assist; required for mode=ask)' },
      model: { type: 'string', description: 'Optional inference model override (ai_assist)' },
      to: { type: 'string', description: 'Recipient email address (send_email)' },
      in_reply_to: { type: 'string', description: 'Optional Message-ID header <id@host> being replied to (send_email)' },
      references: { type: 'string', description: 'Optional space-separated Message-ID thread references (send_email)' },
      pipeline: {
        type: 'string',
        enum: ['sales', 'fundraising'],
        description: 'Optional pipeline filter: sales | fundraising (analytics)',
      },
      period: { type: 'string', description: 'Optional analytics window, e.g. 7d, 30d, 90d (analytics)' },
      from: { type: 'string', description: 'Optional analytics start date (analytics)' },
    },
    required: ['action'],
  },
  handler: async (args: Record<string, any> = {}): Promise<ToolResult> => {
    const action = nonEmptyString(args?.action) || '';
    if (!CRM_ACTION_SET.has(action)) {
      return errEnvelope(action, 'INVALID_ARGS', `action must be one of: ${CRM_ACTIONS.join(', ')}`);
    }

    let org: string | undefined;
    try {
      org = resolveOrg(args?.org);
    } catch (e: any) {
      return errEnvelope(action, 'INVALID_ARGS', e.message);
    }

    const requireToken = (): string | ToolResult => {
      const t = resolveCrmToken();
      if (!t) return errEnvelope(action, 'NO_API_KEY', 'no API key: run `hanzo login` or set HANZO_API_KEY (pk-/sk-)');
      return t;
    };

    try {
      switch (action as CrmAction) {
        case 'objects': {
          const token = requireToken();
          if (typeof token !== 'string') return token;
          return finalizeReply(action, await sendRequest('GET', '/v1/crm/objects', token, org));
        }

        case 'search': {
          const q = nonEmptyString(args.q ?? args.query);
          if (!q) return errEnvelope(action, 'INVALID_ARGS', 'q required');
          const objects = parseObjectsList(args.objects);
          const limit = positiveInt(args.limit);
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const reqPath = `/v1/crm/search${qs({ q, objects, limit })}`;
          return finalizeReply(action, await sendRequest('GET', reqPath, token, org));
        }

        case 'list': {
          if (!nonEmptyString(args.object)) return errEnvelope(action, 'INVALID_ARGS', 'object required');
          const obj = resolveCrmObject(args.object);
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const filter = nonEmptyString(args.filter);
          const sort = nonEmptyString(args.sort);
          const search = nonEmptyString(args.search ?? args.q);
          const page = positiveInt(args.page);
          const perPage = positiveInt(args.per_page ?? args.perPage ?? args.limit);
          const expand = nonEmptyString(args.expand);
          const crmPath = `/v1/crm/records/${obj}${qs({ filter, sort, search, page, per_page: perPage, expand })}`;
          const basePath = `/v1/base/collections/${obj}/records${qs({ filter, sort, search, page, perPage, expand })}`;
          return await callWithBaseFallback(action, 'GET', crmPath, basePath, token, org);
        }

        case 'get': {
          if (!nonEmptyString(args.object)) return errEnvelope(action, 'INVALID_ARGS', 'object required');
          const obj = resolveCrmObject(args.object);
          const id = validateRecordId(args.id ?? args.record_id);
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const expand = nonEmptyString(args.expand);
          const include = nonEmptyString(args.include);
          const crmQ = qs({ expand, include });
          const baseQ = qs({ expand });
          return await callWithBaseFallback(
            action,
            'GET',
            `/v1/crm/records/${obj}/${encodeURIComponent(id)}${crmQ}`,
            `/v1/base/collections/${obj}/records/${encodeURIComponent(id)}${baseQ}`,
            token,
            org,
          );
        }

        case 'create': {
          if (!nonEmptyString(args.object)) return errEnvelope(action, 'INVALID_ARGS', 'object required');
          const obj = resolveCrmObject(args.object);
          const data = plainObject(args.data ?? args.record ?? args.fields ?? args.body);
          if (!data) return errEnvelope(action, 'INVALID_ARGS', 'data object required');
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const crmBody: Record<string, unknown> = { record: data };
          const key = nonEmptyString(args.key);
          if (key) crmBody.key = key;
          return await callWithBaseFallback(
            action,
            'POST',
            `/v1/crm/records/${obj}`,
            `/v1/base/collections/${obj}/records`,
            token,
            org,
            crmBody,
            data,
          );
        }

        case 'update': {
          if (!nonEmptyString(args.object)) return errEnvelope(action, 'INVALID_ARGS', 'object required');
          const obj = resolveCrmObject(args.object);
          const id = validateRecordId(args.id ?? args.record_id);
          const data = plainObject(args.data ?? args.record ?? args.fields ?? args.body);
          if (!data) return errEnvelope(action, 'INVALID_ARGS', 'data object required');
          if (Object.keys(data).length === 0) return errEnvelope(action, 'INVALID_ARGS', 'data cannot be empty');
          const token = requireToken();
          if (typeof token !== 'string') return token;
          return await callWithBaseFallback(
            action,
            'PATCH',
            `/v1/crm/records/${obj}/${encodeURIComponent(id)}`,
            `/v1/base/collections/${obj}/records/${encodeURIComponent(id)}`,
            token,
            org,
            { record: data },
            data,
          );
        }

        case 'delete': {
          if (!nonEmptyString(args.object)) return errEnvelope(action, 'INVALID_ARGS', 'object required');
          const obj = resolveCrmObject(args.object);
          const id = validateRecordId(args.id ?? args.record_id);
          const token = requireToken();
          if (typeof token !== 'string') return token;
          return await callWithBaseFallback(
            action,
            'DELETE',
            `/v1/crm/records/${obj}/${encodeURIComponent(id)}`,
            `/v1/base/collections/${obj}/records/${encodeURIComponent(id)}`,
            token,
            org,
            undefined,
            undefined,
            { deleted: true, object: obj, id },
          );
        }

        case 'merge': {
          if (!nonEmptyString(args.object)) return errEnvelope(action, 'INVALID_ARGS', 'object required');
          const obj = resolveCrmObject(args.object);
          const sourceId = validateRecordId(args.source_id ?? args.sourceId);
          const targetId = validateRecordId(args.target_id ?? args.targetId);
          if (sourceId === targetId) {
            return errEnvelope(action, 'INVALID_ARGS', 'source_id and target_id must differ');
          }
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const body: Record<string, unknown> = { source_id: sourceId, target_id: targetId };
          const fields = plainObject(args.fields ?? args.data);
          if (fields) body.fields = fields;
          return finalizeReply(action, await sendRequest('POST', `/v1/crm/records/${obj}/merge`, token, org, body));
        }

        case 'move_stage': {
          const id = validateRecordId(args.id ?? args.deal_id ?? args.opportunity_id ?? args.record_id);
          const stage = nonEmptyString(args.stage);
          if (!stage) return errEnvelope(action, 'INVALID_ARGS', 'stage required');
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const body: Record<string, unknown> = { stage };
          const nextStep = nonEmptyString(args.next_step);
          if (nextStep) body.next_step = nextStep;
          const note = nonEmptyString(args.note);
          if (note) body.note = note;
          return finalizeReply(
            action,
            await sendRequest('POST', `/v1/crm/deals/${encodeURIComponent(id)}/stage`, token, org, body),
          );
        }

        case 'log_activity': {
          const kind = nonEmptyString(args.kind ?? args.type);
          if (!kind) return errEnvelope(action, 'INVALID_ARGS', 'kind required');
          const personId = nonEmptyString(args.person_id ?? args.person);
          const companyId = nonEmptyString(args.company_id ?? args.company);
          const opportunityId = nonEmptyString(args.opportunity_id ?? args.opportunity);
          const candidateId = nonEmptyString(args.candidate_id ?? args.candidate);
          if (!personId && !companyId && !opportunityId && !candidateId) {
            return errEnvelope(
              action,
              'INVALID_ARGS',
              'at least one of person_id, company_id, opportunity_id, or candidate_id required',
            );
          }
          const direction = normalizeDirection(args.direction);
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const body: Record<string, unknown> = { kind };
          if (direction) body.direction = direction;
          if (personId) body.person_id = personId;
          if (companyId) body.company_id = companyId;
          if (opportunityId) body.opportunity_id = opportunityId;
          if (candidateId) body.candidate_id = candidateId;
          for (const key of ['subject', 'snippet', 'body', 'channel', 'at', 'source_id']) {
            const val = nonEmptyString(args[key]);
            if (val) body[key] = val;
          }
          const metaData = plainObject(args.data);
          if (metaData) body.data = metaData;
          return finalizeReply(action, await sendRequest('POST', '/v1/crm/timeline', token, org, body));
        }

        case 'analytics': {
          const obj = nonEmptyString(args.object) ? resolveCrmObject(args.object) : undefined;
          const pipelineRaw = nonEmptyString(args.pipeline)?.toLowerCase();
          if (pipelineRaw && !ANALYTICS_PIPELINES.has(pipelineRaw)) {
            return errEnvelope(action, 'INVALID_ARGS', `invalid pipeline ${JSON.stringify(args.pipeline)}; allowed: sales, fundraising`);
          }
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const reqPath = `/v1/crm/analytics${qs({
            pipeline: pipelineRaw,
            object: obj,
            period: nonEmptyString(args.period),
            from: nonEmptyString(args.from),
            to: nonEmptyString(args.to),
            filter: nonEmptyString(args.filter),
          })}`;
          return finalizeReply(action, await sendRequest('GET', reqPath, token, org));
        }

        case 'ai_assist': {
          const mode = nonEmptyString(args.mode);
          if (!mode) {
            return errEnvelope(action, 'INVALID_ARGS', `mode required (${AI_ASSIST_MODES.join(' | ')})`);
          }
          if (!AI_ASSIST_MODE_SET.has(mode)) {
            return errEnvelope(action, 'INVALID_ARGS', `invalid mode ${JSON.stringify(mode)}; allowed: ${AI_ASSIST_MODES.join(', ')}`);
          }
          const prompt = nonEmptyString(args.prompt);
          if (mode === 'ask' && !prompt) {
            return errEnvelope(action, 'INVALID_ARGS', 'prompt required when mode is ask');
          }
          const obj = nonEmptyString(args.object) ? resolveCrmObject(args.object) : undefined;
          const recordId = nonEmptyString(args.record_id ?? args.id)
            ? validateRecordId(args.record_id ?? args.id)
            : undefined;
          if (Boolean(obj) !== Boolean(recordId)) {
            return errEnvelope(action, 'INVALID_ARGS', 'object and record_id must be provided together');
          }
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const body: Record<string, unknown> = { mode };
          if (prompt) body.prompt = prompt;
          if (obj) body.object = obj;
          if (recordId) body.record_id = recordId;
          const model = nonEmptyString(args.model);
          if (model) body.model = model;
          return finalizeReply(action, await sendRequest('POST', '/v1/crm/ai/assist', token, org, body));
        }

        case 'send_email': {
          let to: string | undefined;
          if (typeof args.to === 'string' && args.to.trim()) {
            to = args.to.trim();
          } else if (Array.isArray(args.to)) {
            const cleaned = args.to.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
            if (cleaned.length > 1) {
              return errEnvelope(action, 'INVALID_ARGS', 'invalid to: /v1/marketing/mail accepts one email address per request');
            }
            if (cleaned.length === 1) to = cleaned[0];
          }
          if (!to) return errEnvelope(action, 'INVALID_ARGS', 'to required');
          const subject = nonEmptyString(args.subject);
          if (!subject) return errEnvelope(action, 'INVALID_ARGS', 'subject required');
          const emailBody = nonEmptyString(args.body);
          if (!emailBody) return errEnvelope(action, 'INVALID_ARGS', 'body required');
          const token = requireToken();
          if (typeof token !== 'string') return token;
          const body: Record<string, unknown> = { to, subject, body: emailBody };
          const person = nonEmptyString(args.person ?? args.person_id);
          if (person) body.person = person;
          const inReplyTo = nonEmptyString(args.in_reply_to);
          if (inReplyTo) body.in_reply_to = inReplyTo;
          const references = nonEmptyString(args.references);
          if (references) body.references = references;
          return finalizeReply(action, await sendRequest('POST', '/v1/marketing/mail', token, org, body));
        }
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      const code = msg.startsWith('invalid ') || msg.endsWith(' required') ? 'INVALID_ARGS' : 'UPSTREAM';
      return errEnvelope(action, code, msg);
    }
  },
};

export const crmTools: Tool[] = [crmTool];
