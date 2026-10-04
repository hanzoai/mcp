/**
 * Tests for the llm tool (Hanzo /v1/chat/completions, /v1/models, /v1/ai/feedback).
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
  ],
};

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
    expect(llmTool.inputSchema.properties.action.enum).toEqual(['query', 'models', 'feedback']);
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
    });
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
    expect(r.count).toBe(4);
    expect(r.models[0]).toEqual({ id: 'kai', family: 'kai', class: 'ours', outputs: ['decision'], context_window: null, input_per_million: 0.021, output_per_million: 0 });
  });

  test('filters by family', async () => {
    const r = json(await llmTool.handler({ action: 'models', family: 'enso' }));
    expect(r.models.map((m: any) => m.id)).toEqual(['enso-auto', 'enso-flash']);
    expect(json(await llmTool.handler({ action: 'models', family: 'kai' })).models.map((m: any) => m.id)).toEqual(['kai']);
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
