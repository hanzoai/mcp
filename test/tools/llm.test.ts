/**
 * Tests for the llm tool (Hanzo /v1/chat/completions, /v1/models, /v1/ai/limits,
 * /v1/ai/feedback).
 *
 * fetch is replaced with a recorder that answers as the gateway does, so each test
 * reads the exact request the tool sent (URL, method, headers, body) and what it
 * made of the answer. No socket is opened.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { llmTool } from '../../src/tools/llm.js';
import { allUnifiedTools, optionalTools } from '../../src/tools/unified/index.js';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

const sent: Sent[] = [];
let reply: (s: Sent) => { status: number; text: string; headers?: Record<string, string> };

// Shapes as api.hanzo.ai answers them (values from live calls).
const COMPLETION = {
  id: 'chatcmpl-ae7c311d-5c64-47da-886b-86ceb2fd185f',
  object: 'chat.completion',
  model: 'enso-free',
  provider: 'hanzo',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi there, friend.' } }],
  usage: { prompt_tokens: 110, completion_tokens: 6, total_tokens: 116 },
};
const CATALOG = {
  object: 'list',
  data: [
    { id: 'kai', family: 'kai', class: 'ours', outputs: ['decision'], pricing: { input_per_million: 0.021, output_per_million: 0 } },
    { id: 'enso-auto', family: 'enso', class: 'free', outputs: ['text'], context_window: 1000000, pricing: { input_per_million: 0, output_per_million: 0 } },
    { id: 'enso-flash', family: 'enso', class: 'free', outputs: ['text'], context_window: 1000000, pricing: { input_per_million: 0, output_per_million: 0 } },
    { id: 'zen5', family: 'zen', class: 'ours', outputs: ['text'], context_window: 262144, pricing: { input_per_million: 0.3, output_per_million: 1.2 } },
    { id: 'zen-embedding', object: 'model', owned_by: 'zenlm', canonical_slug: 'zenlm/zen-embedding', class: 'ours', family: 'zen', context_window: 32768, outputs: ['embeddings'], pricing: { prompt: '0.00000001', completion: '0.00000001', input_per_million: 0.01, output_per_million: 0.01 } },
    { id: 'anthropic/claude-sonnet-4.5', object: 'model', owned_by: 'anthropic', canonical_slug: 'anthropic/claude-sonnet-4.5', class: 'premium', name: 'Claude Sonnet 4.5', description: 'Anthropic\'s most capable Sonnet for coding and agents.', context_window: 1000000, inputs: ['text', 'image', 'file'], outputs: ['text'], supports_vision: true, supports_tools: true, supports_reasoning: true, pricing: { prompt: '0.0000036', completion: '0.000018', input_per_million: 3.6, output_per_million: 18 } },
    { id: 'typesafe/jev-router', object: 'model', owned_by: 'typesafe', canonical_slug: 'typesafe/jev-router', class: 'premium', name: 'Jev Router', context_window: 1000000, inputs: ['audio', 'file', 'image', 'text', 'video'], outputs: ['text'], supports_vision: true, supports_tools: true, supports_reasoning: true, pricing: { prompt: '0.00018', completion: '0.00072', input_per_million: 180, output_per_million: 720, variable: true } },
  ],
};

// GET /v1/ai/limits for org hanzo on the free plan, as it answered live.
const LIMITS_LIVE = {
  plan: 'free', state: 'ok', classes: {},
  actions: [
    { kind: 'upgrade', label: 'Upgrade to Pro', url: 'https://hanzo.ai/pay/cart?plan=dev', plan: 'dev' },
    { kind: 'topup', label: 'Add prepaid credit', url: 'https://hanzo.ai/pay' },
  ],
  upgrade: 'dev', credits_after_allowance: false,
};

// A paid plan near its premium share, with every field the contract names, plus
// figures a server must never send and the tool must never pass on if it did.
const LIMITS_PAID = {
  plan: 'max-5x', period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z', state: 'near',
  classes: {
    premium: { percent: 85, state: 'near', paying: 'plan', resets_at: '2026-11-01T00:00:00Z', window: { percent: 40, state: 'ok', resets_at: '2026-10-05T03:00:00Z' }, used_cents: 4250, cap_cents: 5000 },
    ours: { percent: 5, state: 'ok', paying: 'plan', resets_at: '2026-11-01T00:00:00Z', requests: 12, limit: 240 },
  },
  session: { percent: 20, state: 'ok', resets_at: '2026-10-05T03:00:00Z', used: 9, limit: 45 },
  day: { percent: 35, state: 'ok', resets_at: '2026-10-05T00:00:00Z' },
  paused: [{ model: 'anthropic/claude-opus-4.1', fallback: 'enso', resets_at: '2026-11-01T00:00:00Z', share_cents: 1500 }],
  actions: [{ kind: 'upgrade', label: 'Upgrade to Max 20x', url: 'https://hanzo.ai/pay/cart?plan=max-20x', plan: 'max-20x', price_cents: 20000 }],
  upgrade: 'max-20x', credits_after_allowance: true,
  allowance_cents: 5000, balance_cents: 1234,
};

// Plan refusals as api.hanzo.ai writes them (hanzoai/ai routers/filter_balance.go
// limitReached and object.InsufficientBalance; free_plan_cap is a live answer).
const PAY = 'https://hanzo.ai/pay';
const REFUSALS: [string, number, unknown][] = [
  ['free_plan_cap', 429, { error: { message: "Free plan: today's Kai requests are used. Upgrade for more: https://hanzo.ai/pay", type: 'rate_limit_error', code: 'free_plan_cap', class: 'ours', resets_at: '2026-10-05T00:00:00Z', upgrade_url: 'https://hanzo.ai/pay/cart?plan=dev', actions: [{ kind: 'upgrade', label: 'Upgrade your plan', url: 'https://hanzo.ai/pay/cart?plan=dev', plan: 'dev' }, { kind: 'topup', label: 'Add prepaid credit', url: PAY }] } }],
  ['model_cap', 402, { error: { message: 'This model has used its share of your plan for now. Try Enso, continue with credits, or upgrade: https://hanzo.ai/pay', type: 'billing_error', code: 'model_cap', class: 'premium', model: 'anthropic/claude-opus-4.1', fallback: 'enso', resets_at: '2026-11-01T00:00:00Z', upgrade_url: 'https://hanzo.ai/pay/cart?plan=max-20x', actions: [{ kind: 'upgrade', label: 'Upgrade your plan', url: 'https://hanzo.ai/pay/cart?plan=max-20x', plan: 'max-20x' }, { kind: 'switch', label: 'Try Enso', model: 'enso' }, { kind: 'credits', label: 'Continue with credits', url: '/v1/ai/limits' }] } }],
  ['plan_allowance_used', 402, { error: { message: "Your plan's included usage of premium models is used for now. Add prepaid credit or upgrade: https://hanzo.ai/pay", type: 'billing_error', code: 'plan_allowance_used', class: 'premium', resets_at: '2026-11-01T00:00:00Z', upgrade_url: 'https://hanzo.ai/pay/cart?plan=max-5x', actions: [{ kind: 'upgrade', label: 'Upgrade your plan', url: 'https://hanzo.ai/pay/cart?plan=max-5x', plan: 'max-5x' }, { kind: 'topup', label: 'Add prepaid credit', url: PAY }] } }],
  ['paid_plan_required', 402, { error: { message: 'anthropic/claude-opus-4.1 needs a paid plan or prepaid balance. Upgrade or add prepaid credit: https://hanzo.ai/pay', type: 'billing_error', code: 'paid_plan_required', class: 'premium', upgrade_url: 'https://hanzo.ai/pay/cart?plan=dev', actions: [{ kind: 'upgrade', label: 'Upgrade your plan', url: 'https://hanzo.ai/pay/cart?plan=dev', plan: 'dev' }, { kind: 'topup', label: 'Add prepaid credit', url: PAY }] } }],
  ['usage_cap_exceeded', 429, { error: { message: "You've used today's requests on your plan. They reset at 2026-10-05T00:00:00Z. Upgrade for more at https://hanzo.ai/pay/cart?plan=max-20x", type: 'rate_limit_error', code: 'usage_cap_exceeded', limit: 'day', resets_at: '2026-10-05T00:00:00Z', upgrade_url: 'https://hanzo.ai/pay/cart?plan=max-20x', actions: [{ kind: 'upgrade', label: 'Upgrade your plan', url: 'https://hanzo.ai/pay/cart?plan=max-20x', plan: 'max-20x' }] } }],
  ['insufficient_balance', 402, { error: { message: 'Insufficient balance. Add credits to your wallet at https://hanzo.ai/pay', type: 'billing_error', code: 'insufficient_balance' } }],
];

const realFetch = globalThis.fetch;
const ENV = ['API_URL', 'HANZO_API_KEY', 'API_KEY', 'API_TOKEN', 'HANZO_TOKEN'];
const saved: Record<string, string | undefined> = {};

const last = () => sent[sent.length - 1];
const text = (r: { content: { text?: string }[] }) => r.content[0].text as string;
const json = (r: { content: { text?: string }[] }) => JSON.parse(text(r));

beforeAll(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.HANZO_API_KEY = 'test-key';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const s: Sent = {
      url: String(url),
      method: String(init?.method),
      headers: init?.headers as Record<string, string>,
      body: init?.body == null ? undefined : JSON.parse(String(init.body)),
    };
    sent.push(s);
    const r = reply(s);
    return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

beforeEach(() => {
  sent.length = 0;
  reply = (s) => {
    if (s.url.endsWith('/v1/models')) return { status: 200, text: JSON.stringify(CATALOG) };
    if (s.url.endsWith('/v1/ai/limits')) return { status: 200, text: JSON.stringify(LIMITS_LIVE) };
    if (s.url.endsWith('/v1/ai/feedback')) {
      const reward = { up: 1, accept: 1, regenerate: 0.25, rating: (s.body.rating - 1) / 2, dismiss: 0 }[s.body.signal as string] ?? 0;
      return { status: 200, text: JSON.stringify({ status: 'ok', msg: '', data: { request_id: s.body.request_id.replace(/^chatcmpl-/, ''), reward, recorded: s.body.signal !== 'dismiss' } }) };
    }
    return { status: 200, text: JSON.stringify(COMPLETION), headers: { 'X-Routed-Model': 'enso-free' } };
  };
});

describe('llm surface', () => {
  test('is one HIP-0300 tool on the default surface', () => {
    expect(optionalTools.filter((t) => t.name === 'llm')).toHaveLength(1);
    expect(allUnifiedTools.filter((t) => t.name === 'llm')).toHaveLength(1);
    expect(llmTool.inputSchema.properties.action.enum).toEqual(['query', 'models', 'limits', 'feedback']);
  });
});

describe('query', () => {
  test('defaults to enso-auto and sends no routing bound it was not given', async () => {
    const r = await llmTool.handler({ prompt: 'Say hi.' });
    expect(r.isError).toBeUndefined();
    expect(last().url).toBe('https://api.hanzo.ai/v1/chat/completions');
    expect(last().method).toBe('POST');
    expect(last().headers.Authorization).toBe('Bearer test-key');
    expect(last().headers['X-Max-Cost']).toBeUndefined();
    expect(last().headers['X-Max-Latency-Ms']).toBeUndefined();
    expect(last().headers['X-Hanzo-Fallback']).toBeUndefined();
    expect(last().body).toEqual({ model: 'enso-auto', messages: [{ role: 'user', content: 'Say hi.' }] });
  });

  test('carries auto, the bounds as Enso\'s headers, and returns the model that served', async () => {
    const r = await llmTool.handler({ action: 'query', model: 'auto', system: 'Be brief.', prompt: 'Say hi.', max_tokens: 20, max_cost: 0.01, max_latency_ms: 800.4 });
    expect(last().headers['X-Max-Cost']).toBe('0.01');
    expect(last().headers['X-Max-Latency-Ms']).toBe('800');
    expect(last().body).toEqual({
      model: 'auto',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hi.' }],
      max_tokens: 20,
    });
    expect(json(r)).toEqual({
      id: COMPLETION.id,
      model: 'enso-free',
      content: 'Hi there, friend.',
      finish_reason: 'stop',
      usage: COMPLETION.usage,
      served: null,
      paid_by: null,
      usage_state: null,
      usage_class: null,
      fallback: null,
      fallback_reason: null,
    });
  });

  test('returns the model that served and who paid, from the gateway\'s headers', async () => {
    // As measured for a named premium model on a funded org.
    reply = () => ({
      status: 200,
      text: JSON.stringify({ ...COMPLETION, model: 'anthropic/claude-sonnet-4.5' }),
      headers: { 'X-Hanzo-Usage': 'ok', 'X-Hanzo-Usage-Class': 'premium', 'X-Hanzo-Paid-By': 'credits', 'X-Hanzo-Served': 'anthropic/claude-sonnet-4.5' },
    });
    const r = json(await llmTool.handler({ model: 'anthropic/claude-sonnet-4.5', prompt: 'hi' }));
    expect(last().body.model).toBe('anthropic/claude-sonnet-4.5');
    expect(r).toMatchObject({ model: 'anthropic/claude-sonnet-4.5', served: 'anthropic/claude-sonnet-4.5', paid_by: 'credits', usage_state: 'ok', usage_class: 'premium', fallback: null });
  });

  test('a free model says only who served', async () => {
    reply = () => ({ status: 200, text: JSON.stringify({ ...COMPLETION, model: 'zen5' }), headers: { 'X-Hanzo-Served': 'zen5' } });
    const r = json(await llmTool.handler({ model: 'zen5', prompt: 'hi' }));
    expect(last().body.model).toBe('zen5');
    expect(r).toMatchObject({ model: 'zen5', served: 'zen5', paid_by: null, usage_class: null });
  });

  test('fallback opts into another model answering, and names it and why', async () => {
    reply = () => ({
      status: 200,
      text: JSON.stringify({ ...COMPLETION, model: 'enso' }),
      headers: { 'X-Hanzo-Fallback': 'enso', 'X-Hanzo-Usage-Reason': 'model_cap', 'X-Hanzo-Served': 'enso', 'X-Hanzo-Usage': 'limited', 'X-Hanzo-Usage-Class': 'premium' },
    });
    const r = json(await llmTool.handler({ model: 'anthropic/claude-opus-4.1', prompt: 'hi', fallback: true }));
    expect(last().headers['X-Hanzo-Fallback']).toBe('allow');
    expect(r).toMatchObject({ served: 'enso', fallback: 'enso', fallback_reason: 'model_cap', usage_state: 'limited' });
  });

  test('reads the body\'s model when the gateway sent no X-Routed-Model', async () => {
    reply = () => ({ status: 200, text: JSON.stringify({ ...COMPLETION, model: 'enso-flash' }) });
    expect(json(await llmTool.handler({ model: 'enso-flash', prompt: 'hi' })).model).toBe('enso-flash');
  });

  test('takes a whole conversation in messages', async () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    await llmTool.handler({ messages, model: 'enso-pro' });
    expect(last().body).toEqual({ model: 'enso-pro', messages });
  });

  test('refuses a bound that is not a positive number before any request', async () => {
    const r = await llmTool.handler({ prompt: 'hi', max_cost: -1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('max_cost must be a positive number');
    expect(sent).toHaveLength(0);
  });

  test('reports the gateway\'s own sentence on a refusal', async () => {
    reply = () => ({ status: 402, text: JSON.stringify({ error: { message: 'Pick a plan', type: 'billing_error' } }) });
    const r = await llmTool.handler({ prompt: 'hi' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Error: 402: Pick a plan');
  });

  test('needs a key', async () => {
    delete process.env.HANZO_API_KEY;
    try {
      const r = await llmTool.handler({ prompt: 'hi' });
      expect(text(r)).toBe('Error: HANZO_API_KEY required');
      expect(sent).toHaveLength(0);
    } finally {
      process.env.HANZO_API_KEY = 'test-key';
    }
  });
});

describe('models', () => {
  test('lists every model with the catalog\'s own price', async () => {
    const r = json(await llmTool.handler({ action: 'models' }));
    expect(last().url).toBe('https://api.hanzo.ai/v1/models');
    expect(last().method).toBe('GET');
    expect(last().body).toBeUndefined();
    expect(r.count).toBe(CATALOG.data.length);
    expect(r.models[0]).toEqual({ id: 'kai', family: 'kai', class: 'ours', outputs: ['decision'], context_window: null, supports: [], input_per_million: 0.021, output_per_million: 0, variable: false });
    expect(r.models.find((m: any) => m.id === 'anthropic/claude-sonnet-4.5')).toEqual({
      id: 'anthropic/claude-sonnet-4.5', family: null, class: 'premium', outputs: ['text'], context_window: 1000000,
      supports: ['tools', 'vision', 'reasoning'], input_per_million: 3.6, output_per_million: 18, variable: false,
    });
  });

  test('marks a router SKU billed at the answering model\'s cost', async () => {
    const r = json(await llmTool.handler({ action: 'models', search: 'router' }));
    expect(r.models).toEqual([expect.objectContaining({ id: 'typesafe/jev-router', variable: true, input_per_million: 180 })]);
  });

  test('narrows by class', async () => {
    const ours = json(await llmTool.handler({ action: 'models', class: 'ours' }));
    expect(ours.models.map((m: any) => m.id)).toEqual(['kai', 'zen5', 'zen-embedding']);
    const premium = json(await llmTool.handler({ action: 'models', class: 'Premium' }));
    expect(premium.models.map((m: any) => m.id)).toEqual(['anthropic/claude-sonnet-4.5', 'typesafe/jev-router']);
  });

  test('refuses a class that is not one before any request', async () => {
    const r = await llmTool.handler({ action: 'models', class: 'gold' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Error: class must be one of premium, ours, free');
    expect(sent).toHaveLength(0);
  });

  test('searches words across id, name, owner and description', async () => {
    expect(json(await llmTool.handler({ action: 'models', search: 'sonnet' })).models.map((m: any) => m.id)).toEqual(['anthropic/claude-sonnet-4.5']);
    expect(json(await llmTool.handler({ action: 'models', search: 'Anthropic coding' })).models.map((m: any) => m.id)).toEqual(['anthropic/claude-sonnet-4.5']);
    expect(json(await llmTool.handler({ action: 'models', search: 'zenlm' })).models.map((m: any) => m.id)).toEqual(['zen-embedding']);
    expect(json(await llmTool.handler({ action: 'models', search: 'no such model' })).count).toBe(0);
  });

  test('narrows by capability: a support flag or a modality', async () => {
    expect(json(await llmTool.handler({ action: 'models', capability: 'tools' })).models.map((m: any) => m.id)).toEqual(['anthropic/claude-sonnet-4.5', 'typesafe/jev-router']);
    expect(json(await llmTool.handler({ action: 'models', capability: 'embeddings' })).models.map((m: any) => m.id)).toEqual(['zen-embedding']);
    expect(json(await llmTool.handler({ action: 'models', capability: 'decision' })).models.map((m: any) => m.id)).toEqual(['kai']);
    expect(json(await llmTool.handler({ action: 'models', capability: 'video' })).models.map((m: any) => m.id)).toEqual(['typesafe/jev-router']);
  });

  test('combines filters', async () => {
    const r = json(await llmTool.handler({ action: 'models', class: 'ours', family: 'zen', capability: 'text' }));
    expect(r.models.map((m: any) => m.id)).toEqual(['zen5']);
  });

  test('filters by family', async () => {
    const r = json(await llmTool.handler({ action: 'models', family: 'enso' }));
    expect(r.models.map((m: any) => m.id)).toEqual(['enso-auto', 'enso-flash']);
    expect(json(await llmTool.handler({ action: 'models', family: 'kai' })).models.map((m: any) => m.id)).toEqual(['kai']);
  });
});

describe('limits', () => {
  test('reads where the plan stands, as the live answer says it', async () => {
    const r = await llmTool.handler({ action: 'limits' });
    expect(r.isError).toBeUndefined();
    expect(last().url).toBe('https://api.hanzo.ai/v1/ai/limits');
    expect(last().method).toBe('GET');
    expect(last().body).toBeUndefined();
    expect(last().headers.Authorization).toBe('Bearer test-key');
    expect(json(r)).toEqual(LIMITS_LIVE);
  });

  test('keeps shares, states, resets and actions, and passes on no figure', async () => {
    reply = () => ({ status: 200, text: JSON.stringify(LIMITS_PAID) });
    const out = text(await llmTool.handler({ action: 'limits' }));
    expect(JSON.parse(out)).toEqual({
      plan: 'max-5x', state: 'near', period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z',
      classes: {
        premium: { percent: 85, state: 'near', resets_at: '2026-11-01T00:00:00Z', paying: 'plan', window: { percent: 40, state: 'ok', resets_at: '2026-10-05T03:00:00Z' } },
        ours: { percent: 5, state: 'ok', resets_at: '2026-11-01T00:00:00Z', paying: 'plan' },
      },
      session: { percent: 20, state: 'ok', resets_at: '2026-10-05T03:00:00Z' },
      day: { percent: 35, state: 'ok', resets_at: '2026-10-05T00:00:00Z' },
      paused: [{ model: 'anthropic/claude-opus-4.1', fallback: 'enso', resets_at: '2026-11-01T00:00:00Z' }],
      actions: [{ kind: 'upgrade', label: 'Upgrade to Max 20x', url: 'https://hanzo.ai/pay/cart?plan=max-20x', plan: 'max-20x' }],
      upgrade: 'max-20x', credits_after_allowance: true,
    });
    for (const figure of ['cents', '"used"', '"limit"', '"requests"', 'balance', '4250', '1234', '5000', '240']) {
      expect(out).not.toContain(figure);
    }
  });

  test('a limited plan says why and which classes', async () => {
    const limited = { ...LIMITS_LIVE, state: 'limited', limited: { reason: 'plan_allowance_used', classes: ['premium'], message: "Your plan's included usage of premium models is used for now." } };
    reply = () => ({ status: 200, text: JSON.stringify(limited) });
    expect(json(await llmTool.handler({ action: 'limits' })).limited).toEqual(limited.limited);
  });
});

describe('refusals', () => {
  test.each(REFUSALS)('%s is an error naming the code and the actions, and no figure', async (code, status, body) => {
    reply = () => ({ status, text: JSON.stringify(body) });
    const r = await llmTool.handler({ model: 'anthropic/claude-opus-4.1', prompt: 'hi' });
    expect(r.isError).toBe(true);
    const { error } = json(r);
    const said = (body as any).error;
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe(said.message);
    expect(error.class).toBe(said.class);
    expect(error.model).toBe(said.model);
    expect(error.fallback).toBe(said.fallback);
    expect(error.resets_at).toBe(said.resets_at);
    expect(error.window).toBe(said.limit);
    expect(error.actions).toEqual(said.actions ?? []);
    expect(Object.keys(error).every((k) => ['status', 'code', 'message', 'class', 'model', 'fallback', 'window', 'resets_at', 'actions'].includes(k))).toBe(true);
  });

  test('model_cap offers the switch to its fallback', async () => {
    const [, status, body] = REFUSALS.find(([c]) => c === 'model_cap')!;
    reply = () => ({ status, text: JSON.stringify(body) });
    const { error } = json(await llmTool.handler({ model: 'anthropic/claude-opus-4.1', prompt: 'hi' }));
    expect(error.fallback).toBe('enso');
    expect(error.actions).toContainEqual({ kind: 'switch', label: 'Try Enso', model: 'enso' });
    expect(error.actions).toContainEqual({ kind: 'credits', label: 'Continue with credits', url: '/v1/ai/limits' });
  });

  test('a controller\'s envelope refusal reads the same', async () => {
    reply = () => ({ status: 402, text: JSON.stringify({ status: 'error', msg: 'Insufficient balance for the estimated request cost. Add credits to your wallet at https://hanzo.ai/pay', code: 'insufficient_balance' }) });
    const { error } = json(await llmTool.handler({ prompt: 'hi' }));
    expect(error).toEqual({ status: 402, code: 'insufficient_balance', message: 'Insufficient balance for the estimated request cost. Add credits to your wallet at https://hanzo.ai/pay', actions: [] });
  });

  test('an upgrade_url with no action of its own becomes one', async () => {
    reply = () => ({ status: 402, text: JSON.stringify({ error: { message: 'm', code: 'paid_plan_required', upgrade_url: 'https://hanzo.ai/pay/cart?plan=dev' } }) });
    expect(json(await llmTool.handler({ prompt: 'hi' })).error.actions).toEqual([{ kind: 'upgrade', url: 'https://hanzo.ai/pay/cart?plan=dev' }]);
  });

  test('a figure beside the code is not passed on', async () => {
    reply = () => ({ status: 429, text: JSON.stringify({ error: { message: 'm', code: 'usage_cap_exceeded', limit: 'session', used: 45, cap: 45, actions: [{ kind: 'upgrade', label: 'Upgrade', url: 'u', price_cents: 2000 }] } }) });
    const out = text(await llmTool.handler({ prompt: 'hi' }));
    expect(JSON.parse(out).error).toEqual({ status: 429, code: 'usage_cap_exceeded', message: 'm', window: 'session', actions: [{ kind: 'upgrade', label: 'Upgrade', url: 'u' }] });
    expect(out).not.toMatch(/45|2000|cents/);
  });

  test('a refusal on limits or models reads the same', async () => {
    const [, status, body] = REFUSALS.find(([c]) => c === 'insufficient_balance')!;
    reply = () => ({ status, text: JSON.stringify(body) });
    expect(json(await llmTool.handler({ action: 'limits' })).error.code).toBe('insufficient_balance');
    expect(json(await llmTool.handler({ action: 'models' })).error.code).toBe('insufficient_balance');
  });

  test('a 402 or 429 without a plan code stays the server\'s sentence', async () => {
    reply = () => ({ status: 429, text: JSON.stringify({ error: { message: 'The free pool is busy.', code: 'pool_busy' } }) });
    expect(text(await llmTool.handler({ prompt: 'hi' }))).toBe('Error: 429: The free pool is busy.');
  });
});

describe('feedback', () => {
  test('posts the signal for a completion id and returns what was recorded', async () => {
    const r = json(await llmTool.handler({ action: 'feedback', request_id: COMPLETION.id, signal: 'accept' }));
    expect(last().url).toBe('https://api.hanzo.ai/v1/ai/feedback');
    expect(last().body).toEqual({ request_id: COMPLETION.id, signal: 'accept' });
    expect(r).toEqual({ request_id: 'ae7c311d-5c64-47da-886b-86ceb2fd185f', reward: 1, recorded: true });
  });

  test('a rating rides with signal rating, 1 to 3', async () => {
    await llmTool.handler({ action: 'feedback', request_id: COMPLETION.id, signal: 'rating', rating: 3 });
    expect(last().body).toEqual({ request_id: COMPLETION.id, signal: 'rating', rating: 3 });
    const bad = await llmTool.handler({ action: 'feedback', request_id: COMPLETION.id, signal: 'rating', rating: 4 });
    expect(bad.isError).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('refuses an unknown signal and an envelope that says error', async () => {
    const r = await llmTool.handler({ action: 'feedback', request_id: COMPLETION.id, signal: 'bogus' });
    expect(text(r)).toContain('signal must be one of');
    reply = () => ({ status: 200, text: JSON.stringify({ status: 'error', msg: 'request not found', data: null }) });
    const e = await llmTool.handler({ action: 'feedback', request_id: COMPLETION.id, signal: 'down' });
    expect(text(e)).toBe('Error: 200: request not found');
  });
});
