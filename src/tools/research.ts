/**
 * research — Unified Hanzo Science & Research tool (HIP-0300).
 *
 * Mirrors rust/src/tools/cloud_web.rs::ResearchTool 1-to-1:
 *   studies    GET  /v1/research/studies
 *   runs       GET  /v1/research/runs
 *   start      POST /v1/research/{runs|studies|experiments}
 *   status     GET  /v1/research/runs?id=...
 *   ledger     GET/POST /v1/research/evidence
 *   artifacts  GET/POST /v1/research/artifacts
 *   search     POST /v1/ask (mode="research", Accept: text/event-stream)
 */

import { Tool, ToolResult } from '../types/index.js';
import { resolveHanzoToken } from './hanzo-auth.js';

const ACTIONS = ['studies', 'runs', 'start', 'status', 'ledger', 'artifacts', 'search'] as const;

function apiBase(): string {
  const raw =
    process.env.RESEARCH_BASE ||
    process.env.HANZO_API_BASE ||
    process.env.HANZO_API_URL ||
    process.env.HANZO_CLOUD_API ||
    process.env.API_URL ||
    'https://api.hanzo.ai';
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function token(): string {
  return resolveHanzoToken();
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function decodeFrames(body: string): any[] {
  const out: any[] = [];
  let data = '';
  const flush = () => {
    const payload = data.trim();
    data = '';
    if (!payload || payload === '[DONE]') return;
    try {
      out.push(JSON.parse(payload));
    } catch {}
  };
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('data:')) {
      const rest = line.slice(5);
      if (data) data += '\n';
      data += rest.startsWith(' ') ? rest.slice(1) : rest;
    }
  }
  flush();
  return out;
}

function foldStream(events: any[]): Record<string, unknown> {
  const errEvt = events.find((e) => e?.type === 'error');
  if (errEvt) throw new Error(String(errEvt.error || 'answer failed'));

  let answer = '';
  let sources: Array<Record<string, string>> = [];
  let followUps: unknown[] = [];
  let done = false;

  const mapSource = (s: any) => ({
    url: typeof s?.url === 'string' ? s.url : '',
    title: typeof s?.title === 'string' ? s.title : '',
    favicon: typeof s?.favicon === 'string' ? s.favicon : '',
  });

  for (const e of events) {
    switch (e?.type) {
      case 'text':
        answer += typeof e.delta === 'string' ? e.delta : '';
        break;
      case 'sources':
        if (Array.isArray(e.sources)) sources = e.sources.map(mapSource);
        break;
      case 'follow_ups':
        if (Array.isArray(e.questions)) followUps = e.questions;
        break;
      case 'done':
        done = true;
        if (typeof e.answer === 'string' && e.answer) answer = e.answer;
        if (Array.isArray(e.sources) && e.sources.length) sources = e.sources.map(mapSource);
        break;
    }
  }
  if (!answer) throw new Error('stream ended without an answer');
  return {
    mode: 'research',
    answer,
    sources,
    follow_ups: followUps,
    complete: done,
  };
}

function envelope(data: unknown, action: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'research', action } }, null, 2) }],
  };
}

function fail(action: string, code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'research', action } }, null, 2) }],
    isError: true,
  };
}

async function jsonReq(path: string, key: string, method = 'GET', body?: unknown): Promise<unknown> {
  const r = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

export const researchTool: Tool = {
  name: 'research',
  description:
    'Hanzo Science & Research tool (/v1/research evidence plane + /v1/ask deep cited synthesis): studies, runs, start, status, ledger, artifacts, and search.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        default: 'search',
        description: 'Research action: studies | runs | start | status | ledger | artifacts | search',
      },
      query: { type: 'string', description: 'Question to research (action=search; alias: q)' },
      mode: {
        type: 'string',
        enum: ['research', 'deep'],
        default: 'research',
        description: 'Answer mode for action=search (research or retired deep)',
      },
      id: { type: 'string', description: 'Study, experiment, or run ID (status, runs, studies)' },
      benchmark: { type: 'string', description: 'Filter runs/ledger by benchmark ID' },
      system: { type: 'string', description: 'Filter runs by system under test' },
      completion: { type: 'string', enum: ['complete', 'partial', 'inconsistent', 'unknown'] },
      project: { type: 'string', description: 'Project sub-scope' },
      sha256: { type: 'string', description: 'Content-addressed artifact SHA-256 (artifacts)' },
      content_b64: { type: 'string', description: 'Base64-encoded artifact bytes to upload (artifacts)' },
      kind: { type: 'string', description: 'Target kind for start/artifacts (study, experiment, run, snapshot, report)' },
      body: { type: 'object', description: 'Payload for start or ledger write' },
    },
  },
  handler: async (args: any = {}): Promise<ToolResult> => {
    const action = String(args.action || 'search').trim().toLowerCase();
    const key = token();
    if (!key) {
      return fail(action, 'NO_API_KEY', 'no API key: run `hanzo login` or set HANZO_API_KEY (pk-/sk-)');
    }

    const qstr = qs({
      id: args.id,
      benchmark: args.benchmark,
      system: args.system,
      completion: args.completion,
      project: args.project,
    });

    try {
      switch (action) {
        case 'studies':
          return envelope(await jsonReq(`/v1/research/studies${qstr}`, key), 'studies');

        case 'runs':
          return envelope(await jsonReq(`/v1/research/runs${qstr}`, key), 'runs');

        case 'status': {
          const targetId = String(args.id ?? args.run_id ?? '').trim();
          if (!targetId) return fail('status', 'INVALID_ARGS', 'id required');
          return envelope(await jsonReq(`/v1/research/runs${qs({ id: targetId, project: args.project })}`, key), 'status');
        }

        case 'start': {
          const endpoint =
            args.kind === 'study'
              ? '/v1/research/studies'
              : args.kind === 'experiment'
                ? '/v1/research/experiments'
                : '/v1/research/runs';
          return envelope(await jsonReq(endpoint, key, 'POST', args.body ?? args), 'start');
        }

        case 'ledger': {
          if (args.body) {
            return envelope(await jsonReq('/v1/research/evidence', key, 'POST', args.body), 'ledger');
          }
          return envelope(await jsonReq(`/v1/research/evidence${qstr}`, key), 'ledger');
        }

        case 'artifacts': {
          if (args.content_b64) {
            return envelope(
              await jsonReq('/v1/research/artifacts', key, 'POST', {
                content: args.content_b64,
                kind: args.kind || 'report',
                run_id: args.run_id || args.id || 'standalone',
              }),
              'artifacts',
            );
          }
          if (args.sha256) {
            return envelope(await jsonReq(`/v1/research/artifacts/${encodeURIComponent(args.sha256)}`, key), 'artifacts');
          }
          return envelope(await jsonReq(`/v1/research/artifacts${qstr}`, key), 'artifacts');
        }

        case 'search': {
          const query = String(args.query ?? args.q ?? '').trim();
          if (!query) return fail('research', 'INVALID_ARGS', 'query required');
          const rawMode = String(args.mode ?? 'research').trim().toLowerCase();
          if (rawMode !== '' && rawMode !== 'research' && rawMode !== 'deep') {
            return fail(
              'research',
              'INVALID_ARGS',
              `unknown mode "${rawMode}": research accepts "research" (or its retired name "deep")`,
            );
          }
          const r = await fetch(`${apiBase()}/v1/ask`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({ q: query, mode: 'research' }),
          });
          const raw = await r.text();
          if (!r.ok) return fail('research', 'UPSTREAM', `${r.status} ${raw.trim()}`);
          const folded = foldStream(decodeFrames(raw));
          folded.query = query;
          return envelope(folded, 'research');
        }

        default:
          return fail(action, 'INVALID_ARGS', `action must be one of: ${ACTIONS.join(', ')}`);
      }
    } catch (e: any) {
      return fail(action, 'UPSTREAM', e?.message || String(e));
    }
  },
};

export const researchTools: Tool[] = [researchTool];
