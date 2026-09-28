/**
 * Tests for the decision tools (Hanzo /v1/decisions, Kai).
 *
 * fetch is replaced with a recorder that answers as the server does, so each test
 * reads the exact request a tool sent (URL, method, bearer, body) and what the tool
 * made of the answer or the refusal. No socket is opened.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  kaiDecideTool,
  kaiChoiceTool,
  kaiScoreTool,
  kaiNoulTool,
  kaiTools,
} from '../../src/tools/kai.js';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

const sent: Sent[] = [];
let reply: (body: any) => { status: number; text: string };

// One answer per type in the contract's shape, values from a live kai run; a noul's confidence is |2p-1|.
const ANSWERS: Record<string, unknown> = {
  choice: { type: 'choice', choice: 'billing', confidence: 0.9995, probabilities: { billing: 0.9997, technical: 0.0003, sales: 0.0 }, answer_confidence: 0.9997 },
  score: { type: 'score', score: 1.3966, confidence: 0.3224, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.1516, 1: 0.3001, 2: 0.5482 }, answer_confidence: 0.5482 },
  noul: { type: 'noul', noul: 0.7232, confidence: 0.4464, answer_confidence: 0.7232 },
};

const ID = 'dec_56909080d4f6ae84865973380ac591e0';
const USAGE = { input_tokens: 148, output_tokens: 0 };

// decision answers every question asked, by name, in the server's envelope.
function decision(body: any) {
  return {
    id: ID,
    model: body.model,
    provider: 'Hanzo',
    answers: Object.fromEntries(Object.entries(body.questions).map(([name, q]: [string, any]) => [name, ANSWERS[q.type]])),
    usage: USAGE,
    routing: { backend: 'kai', checkpoint: 'a7', device: 'cpu', reason: "explicit model='kai'" },
    state_hash: 'sha256:9220c40541ea8076c938db02ee6a6cbd47cb516c96318d36e93bd820b8155414',
    latency_ms: 101.8,
  };
}

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
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), method: String(init?.method), headers: init?.headers as Record<string, string>, body });
    const r = reply(body);
    return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

beforeEach(() => {
  sent.length = 0;
  reply = (body) => ({ status: 200, text: JSON.stringify(decision(body)) });
});

describe('the kai tool surface', () => {
  test('is four tools, each uniquely named', () => {
    const names = kaiTools.map((t) => t.name);
    expect(names).toEqual(['kai_decide', 'kai_choice', 'kai_score', 'kai_noul']);
    expect(new Set(names).size).toBe(names.length);
  });

  test('instructions is optional everywhere; choice and score require their criteria', () => {
    expect(kaiDecideTool.inputSchema.required).toEqual(['state', 'questions']);
    expect(kaiDecideTool.inputSchema.properties.questions.additionalProperties.required).toEqual(['type']);
    expect(kaiChoiceTool.inputSchema.required).toEqual(['state', 'criteria']);
    expect(kaiScoreTool.inputSchema.required).toEqual(['state', 'criteria']);
    expect(kaiNoulTool.inputSchema.required).toEqual(['state']);
  });

  test('each description says when to reach for Kai and how to read its confidence', () => {
    for (const t of kaiTools) {
      expect(t.description).toContain('classify, route, gate, rank, check');
      expect(t.description).toContain('(n·p_max − 1)/(n − 1)');
      expect(t.description).toContain('`instructions`');
      expect(t.description).toContain('recommended');
      expect(t.description).toContain('escalate');
    }
    for (const t of [kaiDecideTool, kaiNoulTool]) expect(t.description).toContain('Write a noul as a statement');
  });
});

describe('kai_decide', () => {
  const questions = {
    team: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: { billing: 'charges, invoices, refunds', technical: 'bugs, errors' } },
    urgency: { type: 'score', instructions: 'How urgent is this ticket?', criteria: ['low', 'medium', 'high'] },
    refund: { type: 'noul', instructions: 'The customer asks for a refund.' },
  };

  test('POSTs the whole request to /v1/decisions with the bearer, model kai by default', async () => {
    const result = await kaiDecideTool.handler({ state: 'I was charged twice for my March invoice.', questions });
    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);

    const req = last();
    expect(req.url).toBe('https://api.hanzo.ai/v1/decisions');
    expect(req.method).toBe('POST');
    expect(req.headers['Authorization']).toBe('Bearer test-key');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.body).toEqual({ model: 'kai', state: 'I was charged twice for my March invoice.', questions });
  });

  test('returns the decision as the server sent it', async () => {
    const result = await kaiDecideTool.handler({ state: 'x', questions });
    expect(json(result)).toEqual(decision(last().body));
  });

  test('the model, the host and a structured state are the caller\'s', async () => {
    process.env.API_URL = 'https://gateway.example';
    try {
      const state = { ticket: 'I was charged twice.', plan: 'pro', history: ['opened', 'replied'] };
      await kaiDecideTool.handler({ state, questions, model: 'hanzo/kai' });
      expect(last().url).toBe('https://gateway.example/v1/decisions');
      expect(last().body.model).toBe('hanzo/kai');
      expect(last().body.state).toEqual(state);
    } finally {
      delete process.env.API_URL;
    }
  });

  test('an empty model is the default, as a client sends an unset option', async () => {
    await kaiDecideTool.handler({ state: 'x', questions, model: '' });
    expect(last().body.model).toBe('kai');
  });

  test('a state may be an array', async () => {
    await kaiDecideTool.handler({ state: [{ role: 'user', content: 'refund please' }], questions });
    expect(last().body.state).toEqual([{ role: 'user', content: 'refund please' }]);
  });

  test('a question without instructions goes as given', async () => {
    const bare = { team: { type: 'choice', criteria: ['billing', 'technical'] } };
    const result = await kaiDecideTool.handler({ state: 'x', questions: bare });
    expect(result.isError).toBeFalsy();
    expect(last().body.questions).toEqual(bare);
  });

  test('an empty state is text, and goes', async () => {
    await kaiDecideTool.handler({ state: '', questions });
    expect(last().body.state).toBe('');
  });

  test('a hundred questions go in one call', async () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `Statement ${i} holds.` }]));
    const result = await kaiDecideTool.handler({ state: 'x', questions: many });
    expect(result.isError).toBeFalsy();
    expect(Object.keys(last().body.questions)).toHaveLength(100);
  });
});

describe('kai_choice', () => {
  const criteria = { billing: 'charges, invoices, refunds', technical: 'bugs, errors', sales: 'pricing' };

  test('sends one choice question and returns its answer with id, model and usage', async () => {
    const result = await kaiChoiceTool.handler({ state: 'I was charged twice.', instructions: 'Which team should handle this ticket?', criteria });
    expect(result.isError).toBeFalsy();
    expect(last().body).toEqual({
      model: 'kai',
      state: 'I was charged twice.',
      questions: { choice: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria } },
    });
    expect(json(result)).toEqual({ answer: ANSWERS.choice, id: ID, model: 'kai', usage: USAGE });
  });

  test('takes criteria as a list of labels', async () => {
    await kaiChoiceTool.handler({ state: 'x', instructions: 'Which team?', criteria: ['billing', 'technical'] });
    expect(last().body.questions.choice.criteria).toEqual(['billing', 'technical']);
  });
});

describe('kai_score', () => {
  test('sends the levels lowest first and returns the level answer', async () => {
    const result = await kaiScoreTool.handler({ state: 'The site is down for every customer.', instructions: 'How urgent is this?', criteria: ['low', 'medium', 'high'] });
    expect(last().body.questions).toEqual({ score: { type: 'score', instructions: 'How urgent is this?', criteria: ['low', 'medium', 'high'] } });
    expect(json(result)).toEqual({ answer: ANSWERS.score, id: ID, model: 'kai', usage: USAGE });
  });
});

describe('kai_noul', () => {
  test('sends the question with neither instructions nor criteria when none are given', async () => {
    await kaiNoulTool.handler({ state: 'I was charged twice. Refund the duplicate.' });
    expect(last().body.questions).toEqual({ noul: { type: 'noul' } });
  });

  test('an empty instructions argument is left out, as a client sends an unset option', async () => {
    await kaiChoiceTool.handler({ state: 'x', instructions: '', criteria: ['a', 'b'] });
    expect(last().body.questions).toEqual({ choice: { type: 'choice', criteria: ['a', 'b'] } });
  });

  test('sends the statement alone when no criteria are given', async () => {
    const result = await kaiNoulTool.handler({ state: 'Refund the duplicate.', instructions: 'The customer asks for a refund.' });
    expect(last().body.questions).toEqual({ noul: { type: 'noul', instructions: 'The customer asks for a refund.' } });
    expect(json(result)).toEqual({ answer: ANSWERS.noul, id: ID, model: 'kai', usage: USAGE });
  });

  test('sends both sides when they are described', async () => {
    const criteria = { true: 'it concerns charges, invoices or refunds', false: 'it concerns something else' };
    await kaiNoulTool.handler({ state: 'x', instructions: 'This ticket is about billing.', criteria });
    expect(last().body.questions.noul.criteria).toEqual(criteria);
  });

  test('reads the sides case-insensitively, as the server does', async () => {
    const result = await kaiNoulTool.handler({ state: 'x', instructions: 'y', criteria: { True: 'a', FALSE: 'b' } });
    expect(result.isError).toBeFalsy();
    expect(last().body.questions.noul.criteria).toEqual({ True: 'a', FALSE: 'b' });
  });
});

describe('inputs are checked before any call', () => {
  const q = { type: 'noul', instructions: 'The ticket is urgent.' };
  test.each([
    ['kai_decide without state', kaiDecideTool, { questions: { q } }, 'state required'],
    ['a state that is a number', kaiDecideTool, { state: 7, questions: { q } }, 'state required'],
    ['a null state', kaiNoulTool, { state: null, instructions: 'y' }, 'state required'],
    ['kai_decide without questions', kaiDecideTool, { state: 'x' }, 'questions required'],
    ['questions as a list', kaiDecideTool, { state: 'x', questions: [q] }, 'questions required'],
    ['kai_decide with no question', kaiDecideTool, { state: 'x', questions: {} }, 'questions must hold 1 to 100 questions, not 0'],
    ['101 questions', kaiDecideTool, { state: 'x', questions: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`q${i}`, q])) }, 'questions must hold 1 to 100 questions, not 101'],
    ['a question that is not an object', kaiDecideTool, { state: 'x', questions: { q: 'urgent?' } }, "question 'q': must be {type, instructions, criteria}"],
    ['a question of unknown type', kaiDecideTool, { state: 'x', questions: { q: { type: 'rank', instructions: 'y' } } }, "question 'q': type must be one of choice, score, noul"],
    ['instructions that are a number', kaiDecideTool, { state: 'x', questions: { q: { type: 'noul', instructions: 7 } } }, "question 'q': instructions must be text, an object or an array"],
    ['kai_choice without criteria', kaiChoiceTool, { state: 'x', instructions: 'y' }, 'criteria must be {label: description} or [label, ...]'],
    ['kai_choice with no label', kaiChoiceTool, { state: 'x', instructions: 'y', criteria: {} }, 'criteria must name 2 to 255 labels, not 0'],
    ['kai_choice with one label', kaiChoiceTool, { state: 'x', instructions: 'y', criteria: { billing: 'charges' } }, 'criteria must name 2 to 255 labels, not 1'],
    ['a repeated label, which is one option', kaiChoiceTool, { state: 'x', instructions: 'y', criteria: ['a', 'a'] }, 'criteria must name 2 to 255 labels, not 1'],
    ['256 labels', kaiChoiceTool, { state: 'x', instructions: 'y', criteria: Array.from({ length: 256 }, (_, i) => `l${i}`) }, 'criteria must name 2 to 255 labels, not 256'],
    ['a label that is not a string', kaiChoiceTool, { state: 'x', instructions: 'y', criteria: ['a', 2] }, 'criteria as a list must hold string labels'],
    ['kai_score without levels', kaiScoreTool, { state: 'x', instructions: 'y', criteria: [] }, 'criteria must list 1 to 10 levels, not 0'],
    ['11 levels', kaiScoreTool, { state: 'x', instructions: 'y', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) }, 'criteria must list 1 to 10 levels, not 11'],
    ['levels as a map', kaiScoreTool, { state: 'x', instructions: 'y', criteria: { low: 'fine' } }, 'criteria must be the levels, lowest first'],
    ['a null level', kaiScoreTool, { state: 'x', instructions: 'y', criteria: ['low', null, 'high'] }, 'score level 1 is null'],
    ['a noul side other than true and false', kaiNoulTool, { state: 'x', instructions: 'y', criteria: { true: 'a', maybe: 'b' } }, 'criteria take only "true" and "false", not maybe'],
    ['noul criteria as a list', kaiNoulTool, { state: 'x', instructions: 'y', criteria: ['yes', 'no'] }, 'criteria must be {"true": ..., "false": ...}'],
    ['a model that is not a name', kaiNoulTool, { state: 'x', instructions: 'y', model: 3 }, 'model must be a model name'],
  ])('%s', async (_name, tool, args, message) => {
    const result = await tool.handler(args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(sent).toHaveLength(0);
  });
});

describe('refusals reach the agent as the server said them', () => {
  test.each([
    ['a 400 from decision', 400, { error: { code: 400, message: 'unknown model "kai-9"; use one of hanzo/kai, kai' } }, '400: unknown model "kai-9"; use one of hanzo/kai, kai'],
    ['a 402 from the gateway', 402, { error: { message: 'no plan or balance covers this request', type: 'billing', code: 402 } }, '402: no plan or balance covers this request'],
    ['a 402 in the gateway\'s other envelope', 402, { status: 'error', msg: 'balance exhausted: add credit to continue' }, '402: balance exhausted: add credit to continue'],
    ['a body that is not JSON', 502, 'upstream unavailable', '502: upstream unavailable'],
    ['no body at all', 503, '', '503: empty response'],
  ])('%s', async (_name, status, body, message) => {
    reply = () => ({ status: status as number, text: typeof body === 'string' ? body : JSON.stringify(body) });
    const result = await kaiChoiceTool.handler({ state: 'x', instructions: 'y', criteria: ['a', 'b'], model: 'kai-9' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Error: ${message}`);
  });
});

describe('what comes back is checked', () => {
  test('a 200 that is not a decision is an error, not an answer', async () => {
    reply = () => ({ status: 200, text: '<html>maintenance</html>' });
    const result = await kaiDecideTool.handler({ state: 'x', questions: { q: { type: 'noul', instructions: 'y' } } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not a decision');
  });

  test('a decision without the question asked is an error', async () => {
    reply = (body) => ({ status: 200, text: JSON.stringify({ ...decision(body), answers: {} }) });
    const result = await kaiNoulTool.handler({ state: 'x', instructions: 'y' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`decision ${ID} has no answer for 'noul'`);
  });
});

describe('auth', () => {
  test('a missing key fails with a clear error and no call', async () => {
    delete process.env.HANZO_API_KEY;
    try {
      const result = await kaiNoulTool.handler({ state: 'x', instructions: 'y' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('HANZO_API_KEY required');
      expect(sent).toHaveLength(0);
    } finally {
      process.env.HANZO_API_KEY = 'test-key';
    }
  });

  test('the key is read from the same variables the tracker tools read', async () => {
    delete process.env.HANZO_API_KEY;
    process.env.API_KEY = 'other-key';
    try {
      await kaiNoulTool.handler({ state: 'x', instructions: 'y' });
      expect(last().headers['Authorization']).toBe('Bearer other-key');
    } finally {
      delete process.env.API_KEY;
      process.env.HANZO_API_KEY = 'test-key';
    }
  });
});
