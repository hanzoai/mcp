/**
 * llm — models through Hanzo, one tool routed by action (HIP-0300).
 *
 *   query     POST /v1/chat/completions  one completion; Enso picks the model unless one is named
 *   models    GET  /v1/models            the catalog with each model's price, searched by text, class, family, capability
 *   limits    GET  /v1/ai/limits         where the plan stands: shares, states, resets and actions, never a figure
 *   feedback  POST /v1/ai/feedback       how a routed answer went, so Enso learns from it
 *
 * Every call carries the caller's Hanzo bearer from the environment to `API_URL`
 * or https://api.hanzo.ai, the one endpoint. A plan refusal (402/429 with a code)
 * comes back as an error result naming the code and the actions (./refusal.ts).
 */

import { Tool, ToolResult } from '../types/index.js';
import { Refusal, refusal } from './refusal.js';

function apiBase(): string { return process.env.API_URL || 'https://api.hanzo.ai'; }
function token(): string { return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || ''; }

// reason is the sentence in an error body: the gateway's error.message or msg, else the body.
function reason(body: string): string {
  let b: any;
  try { b = JSON.parse(body); } catch { return body.substring(0, 200); }
  const m = b?.error?.message ?? b?.msg ?? b?.message ?? b?.error;
  return typeof m === 'string' && m ? m : body.substring(0, 200);
}

// send is the one request path: Bearer auth, JSON in and out; a plan refusal throws
// a Refusal, any other non-2xx, or a 200 whose envelope says error, `${status}: ${sentence}`.
async function send(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ data: any; headers: Headers }> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const r = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${t}`, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text().catch(() => '');
  const refused = refusal(r.status, txt);
  if (refused) throw refused;
  if (!r.ok) throw new Error(`${r.status}: ${reason(txt) || r.statusText || 'empty response'}`);
  let d: any;
  try { d = JSON.parse(txt); } catch { throw new Error(`${r.status}: not JSON: ${txt.substring(0, 200)}`); }
  if (d?.status === 'error') throw new Error(`${r.status}: ${reason(txt)}`);
  return { data: d, headers: r.headers };
}

function ok(v: unknown): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] }; }
function fail(m: string): ToolResult { return { content: [{ type: 'text', text: `Error: ${m}` }], isError: true }; }

const ACTIONS = ['query', 'models', 'limits', 'feedback'];
const CLASSES = ['premium', 'ours', 'free'];
const SUPPORTS = ['tools', 'vision', 'reasoning'];
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
  const extra = bounds(args);
  if (args.fallback === true) extra['X-Hanzo-Fallback'] = 'allow';
  const { data, headers } = await send('POST', '/v1/chat/completions', body, extra);
  const choice = data?.choices?.[0];
  return ok({
    id: data?.id,
    // The model that served: Enso names it in X-Routed-Model when it rewrote the
    // request, and the body's model always says the same.
    model: headers.get('X-Routed-Model') || data?.model,
    content: choice?.message?.content ?? null,
    finish_reason: choice?.finish_reason ?? null,
    usage: data?.usage ?? null,
    // Who answered and who paid, as the gateway says on the response; a header it
    // did not send is null (a free model sends only X-Hanzo-Served).
    served: headers.get('X-Hanzo-Served'),
    paid_by: headers.get('X-Hanzo-Paid-By'),
    usage_state: headers.get('X-Hanzo-Usage'),
    usage_class: headers.get('X-Hanzo-Usage-Class'),
    fallback: headers.get('X-Hanzo-Fallback'),
    fallback_reason: headers.get('X-Hanzo-Usage-Reason'),
  });
}

// supports lists what a catalog row says the model can do beyond text.
function supports(m: any): string[] {
  return SUPPORTS.filter((s) => m[`supports_${s}`] === true);
}

// capable says whether a row has a capability: tools, vision or reasoning, or a
// modality it takes or makes (image, audio, embeddings, decision, transcript, ...).
function capable(m: any, c: string): boolean {
  if (SUPPORTS.includes(c)) return m[`supports_${c}`] === true;
  const has = (v: unknown) => Array.isArray(v) && v.some((x) => String(x).toLowerCase() === c);
  return has(m.inputs) || has(m.outputs);
}

function lower(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

async function models(args: any): Promise<ToolResult> {
  const cls = lower(args.class);
  if (cls && !CLASSES.includes(cls)) throw new Error(`class must be one of ${CLASSES.join(', ')}`);
  const family = lower(args.family);
  const capability = lower(args.capability);
  const words = lower(args.search).split(/\s+/).filter(Boolean);
  const { data } = await send('GET', '/v1/models');
  const rows: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const out = rows
    .filter((m) => !cls || lower(m.class) === cls)
    .filter((m) => !family || lower(m.family) === family)
    .filter((m) => !capability || capable(m, capability))
    .filter((m) => {
      if (!words.length) return true;
      const hay = [m.id, m.name, m.canonical_slug, m.owned_by, m.description].map(lower).join(' ');
      return words.every((w) => hay.includes(w));
    })
    .map((m) => ({
      id: m.id,
      family: m.family ?? null,
      class: m.class ?? null,
      outputs: m.outputs ?? null,
      context_window: m.context_window ?? null,
      supports: supports(m),
      // USD per million tokens, read from the gateway's catalog and never restated here.
      input_per_million: m.pricing?.input_per_million ?? null,
      output_per_million: m.pricing?.output_per_million ?? null,
      // A router SKU is billed at the cost of the model that answers; its listed price is not what a call costs.
      variable: m.pricing?.variable === true,
    }));
  return ok({ count: out.length, models: out });
}

// share keeps the share fields of a usage window: percent, state, resets_at.
function share(w: any): Record<string, unknown> | undefined {
  if (!w || typeof w !== 'object') return undefined;
  return { percent: w.percent, state: w.state, resets_at: w.resets_at };
}

// limits answers where the caller's plan stands, field by field from /v1/ai/limits:
// shares (percent), states, who pays, resets and actions. Only named fields are
// copied, so a figure the answer might carry can never reach the result.
async function limits(): Promise<ToolResult> {
  const { data: d } = await send('GET', '/v1/ai/limits');
  const classes: Record<string, unknown> = {};
  for (const [name, c] of Object.entries<any>(d?.classes && typeof d.classes === 'object' ? d.classes : {})) {
    classes[name] = { ...share(c), paying: c?.paying, window: share(c?.window) };
  }
  const actions = (Array.isArray(d?.actions) ? d.actions : []).map((a: any) => ({ kind: a?.kind, label: a?.label, url: a?.url, plan: a?.plan, model: a?.model }));
  const paused = Array.isArray(d?.paused) ? d.paused.map((p: any) => ({ model: p?.model, fallback: p?.fallback, resets_at: p?.resets_at })) : undefined;
  const limited = d?.limited && typeof d.limited === 'object'
    ? { reason: d.limited.reason, classes: d.limited.classes, message: d.limited.message }
    : undefined;
  return ok({
    plan: d?.plan,
    state: d?.state,
    period_start: d?.period_start,
    period_end: d?.period_end,
    classes,
    session: share(d?.session),
    day: share(d?.day),
    limited,
    paused,
    actions,
    upgrade: d?.upgrade,
    credits_after_allowance: d?.credits_after_allowance,
  });
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
    'fallback true lets another model answer when the plan refuses the one named. ' +
    'Returns {id, model, content, finish_reason, usage, served, paid_by, usage_state, usage_class, fallback, fallback_reason}: ' +
    'model is the one Enso routed to, served the SKU that answered, paid_by plan, credits or free, id is what feedback takes. ' +
    'models: the catalog with each model\'s family, class (premium, ours, free), what it supports and price per million input and output tokens; ' +
    'variable true means a router billed at the answering model\'s cost. search (words in id, name, owner or description), class, family and capability ' +
    '(tools, vision, reasoning, or a modality such as image, audio, embeddings) narrow it. ' +
    'limits: where your plan stands: its state (ok, near, limited), each class\'s percent used, who pays, when it resets, paused models and their fallbacks, ' +
    'and the actions (upgrade, credits, topup) with their links. ' +
    'A refusal (402 or 429) is an error naming its code (plan_allowance_used, paid_plan_required, free_plan_cap, model_cap, usage_cap_exceeded, insufficient_balance) and its actions. ' +
    'feedback: tell Enso how a routed answer went: request_id is the completion id, signal one of ' + SIGNALS.join(', ') +
    ', and rating 1 to 3 with signal rating. Typed decisions are kai_decide\'s, not a completion\'s.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'query (default), models, limits or feedback' },
      prompt: { type: 'string', description: 'query: the user message' },
      system: { type: 'string', description: 'query: an optional system message, with prompt' },
      messages: { type: 'array', items: { type: 'object' }, description: 'query: the whole conversation as [{role, content}], instead of prompt' },
      model: { type: 'string', description: `query: a model id, "auto", or an enso id (enso-auto, enso-flash, enso-pro, enso-ultra, enso-free); default ${DEFAULT_MODEL}` },
      max_tokens: { type: 'number', description: 'query: the most tokens to generate' },
      temperature: { type: 'number', description: 'query: sampling temperature' },
      max_cost: { type: 'number', description: 'query: the most you will pay, in USD per 1,000 tokens (X-Max-Cost)' },
      max_latency_ms: { type: 'number', description: 'query: the slowest model you will accept, in milliseconds (X-Max-Latency-Ms)' },
      fallback: { type: 'boolean', description: 'query: when the plan refuses the model, let its fallback answer instead (X-Hanzo-Fallback: allow)' },
      search: { type: 'string', description: 'models: words that must all appear in the id, name, owner or description' },
      class: { type: 'string', enum: CLASSES, description: 'models: only this class' },
      family: { type: 'string', description: 'models: only this family, e.g. enso, zen or kai' },
      capability: { type: 'string', description: 'models: tools, vision, reasoning, or a modality taken or made (image, audio, embeddings, rerank, transcript, decision)' },
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
        case 'limits': return await limits();
        case 'feedback': return await feedback(args);
        default: return fail(`action must be one of ${ACTIONS.join(', ')}`);
      }
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  },
};

export const llmTools: Tool[] = [llmTool];
