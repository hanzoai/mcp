/**
 * llm — models through Hanzo, one tool routed by action (HIP-0300).
 *
 *   query     POST /v1/chat/completions  one completion; Enso picks the model unless one is named
 *   models    GET  /v1/models            the catalog with each model's price, as the gateway states it
 *   feedback  POST /v1/ai/feedback       how a routed answer went, so Enso learns from it
 *
 * Every call carries the caller's Hanzo bearer from the environment to `API_URL`
 * or https://api.hanzo.ai, the one endpoint.
 */

import { Tool, ToolResult } from '../types/index.js';

function apiBase(): string { return process.env.API_URL || 'https://api.hanzo.ai'; }
function token(): string { return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || ''; }

// reason is the sentence in an error body: the gateway's error.message or msg, else the body.
function reason(body: string): string {
  let b: any;
  try { b = JSON.parse(body); } catch { return body.substring(0, 200); }
  const m = b?.error?.message ?? b?.msg ?? b?.message ?? b?.error;
  return typeof m === 'string' && m ? m : body.substring(0, 200);
}

// send is the one request path: Bearer auth, JSON in and out; a non-2xx, or a 200
// whose envelope says error, throws `${status}: ${sentence}`.
async function send(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ data: any; headers: Headers }> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const r = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${t}`, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`${r.status}: ${reason(txt) || r.statusText || 'empty response'}`);
  let d: any;
  try { d = JSON.parse(txt); } catch { throw new Error(`${r.status}: not JSON: ${txt.substring(0, 200)}`); }
  if (d?.status === 'error') throw new Error(`${r.status}: ${reason(txt)}`);
  return { data: d, headers: r.headers };
}

function ok(v: unknown): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] }; }
function fail(m: string): ToolResult { return { content: [{ type: 'text', text: `Error: ${m}` }], isError: true }; }

const ACTIONS = ['query', 'models', 'feedback'];
const SIGNALS = ['up', 'accept', 'regenerate', 'down', 'switch', 'abandon', 'revert', 'rating', 'dismiss'];
const DEFAULT_MODEL = 'enso-auto';

// bounds turns the routing ceilings into the two headers Enso reads; an unset one is not sent.
function bounds(args: any): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [key, header] of [['max_cost', 'X-Max-Cost'], ['max_latency_ms', 'X-Max-Latency-Ms']] as const) {
    const v = args[key];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number, not ${JSON.stringify(v)}`);
    h[header] = String(key === 'max_latency_ms' ? Math.round(n) : n);
  }
  return h;
}

async function query(args: any): Promise<ToolResult> {
  let messages = args.messages;
  if (messages == null) {
    if (typeof args.prompt !== 'string' || !args.prompt) throw new Error('prompt or messages required');
    messages = [];
    if (args.system) messages.push({ role: 'system', content: args.system });
    messages.push({ role: 'user', content: args.prompt });
  } else if (!Array.isArray(messages) || !messages.length) {
    throw new Error('messages must be a non-empty array of {role, content}');
  }
  const body: Record<string, unknown> = { model: args.model || DEFAULT_MODEL, messages };
  if (args.max_tokens != null) body.max_tokens = args.max_tokens;
  if (args.temperature != null) body.temperature = args.temperature;
  const { data, headers } = await send('POST', '/v1/chat/completions', body, bounds(args));
  const choice = data?.choices?.[0];
  return ok({
    id: data?.id,
    // The model that served: Enso names it in X-Routed-Model when it rewrote the
    // request, and the body's model always says the same.
    model: headers.get('X-Routed-Model') || data?.model,
    content: choice?.message?.content ?? null,
    finish_reason: choice?.finish_reason ?? null,
    usage: data?.usage ?? null,
  });
}

async function models(args: any): Promise<ToolResult> {
  const { data } = await send('GET', '/v1/models');
  const rows: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const family = typeof args.family === 'string' && args.family ? args.family.toLowerCase() : '';
  const out = rows
    .filter((m) => !family || String(m.family || '').toLowerCase() === family)
    .map((m) => ({
      id: m.id,
      family: m.family ?? null,
      class: m.class ?? null,
      outputs: m.outputs ?? null,
      context_window: m.context_window ?? null,
      // USD per million tokens, read from the gateway's catalog and never restated here.
      input_per_million: m.pricing?.input_per_million ?? null,
      output_per_million: m.pricing?.output_per_million ?? null,
    }));
  return ok({ count: out.length, models: out });
}

async function feedback(args: any): Promise<ToolResult> {
  const id = args.request_id;
  if (typeof id !== 'string' || !id) throw new Error('request_id required: the id of the completion (chatcmpl-...)');
  if (!SIGNALS.includes(args.signal)) throw new Error(`signal must be one of ${SIGNALS.join(', ')}`);
  const body: Record<string, unknown> = { request_id: id, signal: args.signal };
  if (args.signal === 'rating') {
    if (![1, 2, 3].includes(Number(args.rating))) throw new Error('rating must be 1, 2 or 3 when signal is rating');
    body.rating = Number(args.rating);
  }
  const { data } = await send('POST', '/v1/ai/feedback', body);
  return ok(data?.data ?? data);
}

export const llmTool: Tool = {
  name: 'llm',
  description:
    'Models through Hanzo. ' +
    'query: one completion; model defaults to enso-auto, and "auto" lets Enso, the router, pick across the models your org can serve. ' +
    'max_cost (USD per 1,000 tokens) and max_latency_ms bound what Enso may pick. ' +
    'Returns {id, model, content, finish_reason, usage}: model is the one that served, id is what feedback takes. ' +
    'models: the catalog with each model\'s family, class and price per million input and output tokens (family filters, e.g. enso or kai). ' +
    'feedback: tell Enso how a routed answer went: request_id is the completion id, signal one of ' + SIGNALS.join(', ') +
    ', and rating 1 to 3 with signal rating. Typed decisions are kai_decide\'s, not a completion\'s.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'query (default), models or feedback' },
      prompt: { type: 'string', description: 'query: the user message' },
      system: { type: 'string', description: 'query: an optional system message, with prompt' },
      messages: { type: 'array', items: { type: 'object' }, description: 'query: the whole conversation as [{role, content}], instead of prompt' },
      model: { type: 'string', description: `query: a model id, "auto", or an enso id (enso-auto, enso-flash, enso-pro, enso-ultra, enso-free); default ${DEFAULT_MODEL}` },
      max_tokens: { type: 'number', description: 'query: the most tokens to generate' },
      temperature: { type: 'number', description: 'query: sampling temperature' },
      max_cost: { type: 'number', description: 'query: the most you will pay, in USD per 1,000 tokens (X-Max-Cost)' },
      max_latency_ms: { type: 'number', description: 'query: the slowest model you will accept, in milliseconds (X-Max-Latency-Ms)' },
      family: { type: 'string', description: 'models: only this family, e.g. enso or kai' },
      request_id: { type: 'string', description: 'feedback: the completion id query returned (chatcmpl-...)' },
      signal: { type: 'string', enum: SIGNALS, description: 'feedback: how the answer went' },
      rating: { type: 'number', enum: [1, 2, 3], description: 'feedback: 1 to 3, with signal rating' },
    },
    required: [],
  },
  handler: async (args: any = {}) => {
    try {
      switch (args.action || 'query') {
        case 'query': return await query(args);
        case 'models': return await models(args);
        case 'feedback': return await feedback(args);
        default: return fail(`action must be one of ${ACTIONS.join(', ')}`);
      }
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

export const llmTools: Tool[] = [llmTool];
