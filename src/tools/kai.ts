/**
 * Decisions — Kai, Hanzo's decision model, on the /v1/decisions surface as MCP tools.
 *
 *   kai_decide  POST /v1/decisions  one state, any named questions: the whole decision
 *   kai_choice  POST /v1/decisions  one choice: a label
 *   kai_score   POST /v1/decisions  one score: an ordinal level
 *   kai_noul    POST /v1/decisions  one noul: the probability a statement holds
 *
 * Each call carries the caller's Hanzo bearer from the environment to `API_URL`
 * or https://api.hanzo.ai.
 */

import { Tool } from '../types/index.js';

function apiBase(): string { return process.env.API_URL || 'https://api.hanzo.ai'; }
function token(): string { return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || ''; }

// reason is the sentence in an error body — decision's error.message, the gateway's msg — else the body.
function reason(body: string): string {
  let b: any;
  try { b = JSON.parse(body); } catch { return body.substring(0, 200); }
  const m = b?.error?.message ?? b?.msg ?? b?.message ?? b?.error;
  return typeof m === 'string' && m ? m : body.substring(0, 200);
}

// decide is the one request path: Bearer auth, JSON in and out; a non-2xx throws `${status}: ${sentence}`.
async function decide(body: Record<string, unknown>): Promise<any> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const r = await fetch(`${apiBase()}/v1/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${t}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const b = await r.text().catch(() => ''); throw new Error(`${r.status}: ${reason(b) || r.statusText || 'empty response'}`); }
  const txt = await r.text();
  let d: any;
  try { d = JSON.parse(txt); } catch { d = null; }
  if (typeof d?.answers !== 'object' || d.answers === null) throw new Error(`${r.status}: not a decision: ${txt.substring(0, 200)}`);
  return d;
}

function ok(v: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] }; }
function fail(m: string) { return { content: [{ type: 'text' as const, text: `Error: ${m}` }], isError: true as const }; }

const KINDS = ['choice', 'score', 'noul'];

// content holds for the wire's Content: text, an object or an array.
function content(v: unknown): boolean {
  return typeof v === 'string' || (typeof v === 'object' && v !== null);
}

// fault says what is wrong with one question's shape under the wire contract, or '' when nothing is.
function fault(q: any): string {
  if (typeof q !== 'object' || q === null || Array.isArray(q)) return 'must be {type, instructions, criteria}';
  if (!KINDS.includes(q.type)) return `type must be one of ${KINDS.join(', ')}`;
  if (q.instructions != null && !content(q.instructions)) return 'instructions must be text, an object or an array';
  const c = q.criteria;
  if (q.type === 'choice') {
    let n: number;
    if (Array.isArray(c)) {
      if (!c.every((l: unknown) => typeof l === 'string')) return 'criteria as a list must hold string labels';
      n = new Set(c).size;
    } else if (typeof c === 'object' && c !== null) {
      n = Object.keys(c).length;
    } else {
      return 'criteria must be {label: description} or [label, ...]';
    }
    return n >= 2 ? '' : `criteria must name at least 2 labels, not ${n}`;
  }
  if (q.type === 'score') {
    if (!Array.isArray(c)) return 'criteria must be the levels, lowest first: [level0, level1, ...]';
    if (!c.length) return 'criteria must list at least 1 level';
    const i = c.findIndex((l: unknown) => l == null);
    return i < 0 ? '' : `score level ${i} is null; describe every level`;
  }
  if (c == null) return '';
  if (typeof c !== 'object' || Array.isArray(c)) return 'criteria must be {"true": ..., "false": ...}';
  const odd = Object.keys(c).filter((k) => k.toLowerCase() !== 'true' && k.toLowerCase() !== 'false');
  return odd.length ? `criteria take only "true" and "false", not ${odd.join(', ')}` : '';
}

// request checks a decision's shape and returns its body; whether a state fits the model is the server's to say.
function request(state: unknown, questions: unknown, model: unknown): Record<string, unknown> {
  if (!content(state)) throw new Error('state required: text, an object or an array');
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    throw new Error('questions required: {name: {type, instructions, criteria}}');
  }
  const n = Object.keys(questions).length;
  if (n < 1 || n > 100) throw new Error(`questions must hold 1 to 100 questions, not ${n}`);
  for (const [name, q] of Object.entries(questions)) {
    const f = fault(q);
    if (f) throw new Error(`question '${name}': ${f}`);
  }
  const m = model || 'kai';
  if (typeof m !== 'string') throw new Error('model must be a model name, e.g. kai');
  return { model: m, state, questions };
}

// one asks a single question, named by its type, and returns its answer with id, model and usage.
async function one(type: string, args: any) {
  try {
    const q: Record<string, unknown> = { type };
    if (args.instructions != null && args.instructions !== '') q.instructions = args.instructions;
    if (args.criteria != null) q.criteria = args.criteria;
    const d = await decide(request(args.state, { [type]: q }, args.model));
    const answer = d.answers[type];
    if (typeof answer !== 'object' || answer === null) return fail(`decision ${d.id} has no answer for '${type}'`);
    return ok({ answer, id: d.id, model: d.model, usage: d.usage });
  } catch (e: any) {
    return fail(e.message);
  }
}

const WHEN = 'Reach for Kai when the answer is one of options you already know — classify, route, gate, rank, check. It writes no text; open-ended answers are a language model\'s job.';
const TRUST = 'Probabilities are calibrated. confidence = (n·p_max − 1)/(n − 1) over the n options: 0 when all are equally likely, 1 when one is certain. Act when it clears your threshold; below it, escalate or ask a person.';
const NOUL = 'Write a noul as a statement and describe both sides in criteria: Kai reads a bare yes/no question poorly. When a yes/no gates an action, a choice between described yes and no options (kai_choice, or a choice question in kai_decide) is usually sharper.';

const STATE = { type: ['string', 'object', 'array'], items: {}, description: 'The case to decide about: text, a JSON object or an array' };
const INSTRUCTIONS = { type: ['string', 'object', 'array'], items: {}, description: 'Optional, recommended. What Kai answers' };
const MODEL = { type: 'string', description: 'Decision model (default kai)' };

export const kaiDecideTool: Tool = {
  name: 'kai_decide',
  description: `Ask Kai, Hanzo's decision model, typed questions about one case in one call (POST /v1/decisions). ${WHEN} \`questions\` maps a name to {type, instructions, criteria}, 1 to 100 of them; \`instructions\` is optional on every question but recommended, as the text Kai answers. choice picks one label: criteria {label: description} or [label, ...], 2 labels or more; Kai narrows a wide choice by retrieval. score picks an ordinal level: criteria [level0, level1, ...], lowest first, 1 level or more; act on the argmax of its probabilities, since its score is the mean level index. noul gives the probability a statement holds: criteria {"true": ..., "false": ...}, optional. Returns the decision {id, model, answers: {name: answer}, usage, ...}. ${TRUST} ${NOUL}`,
  inputSchema: {
    type: 'object',
    properties: {
      state: STATE,
      questions: {
        type: 'object',
        description: 'Question name → {type, instructions, criteria}; 1 to 100 questions',
        additionalProperties: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: KINDS },
            instructions: INSTRUCTIONS,
            criteria: { type: ['object', 'array'], items: {}, description: 'choice: {label: description} or [label, ...], 2 labels or more; score: [level0, level1, ...], lowest first, none null; noul: {"true": ..., "false": ...}, optional' },
          },
          required: ['type'],
        },
      },
      model: MODEL,
    },
    required: ['state', 'questions'],
  },
  handler: async (args) => {
    try {
      return ok(await decide(request(args.state, args.questions, args.model)));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

export const kaiChoiceTool: Tool = {
  name: 'kai_choice',
  description: `Ask Kai, Hanzo's decision model, to pick one label for a case: classify, route, triage, select. ${WHEN} \`instructions\` (optional, recommended) says what to decide; criteria names 2 labels or more, {label: description} or [label, ...]; Kai narrows a wide choice by retrieval. Returns {answer: {choice, confidence, probabilities, answer_confidence}, id, model, usage}. ${TRUST}`,
  inputSchema: {
    type: 'object',
    properties: {
      state: STATE,
      instructions: { ...INSTRUCTIONS, description: 'Optional, recommended. What to decide, e.g. "Which team should handle this ticket?"' },
      criteria: { type: ['object', 'array'], items: { type: 'string' }, description: '{label: description} or [label, ...]; 2 labels or more' },
      model: MODEL,
    },
    required: ['state', 'criteria'],
  },
  handler: async (args) => one('choice', args),
};

export const kaiScoreTool: Tool = {
  name: 'kai_score',
  description: `Ask Kai, Hanzo's decision model, for an ordinal level: severity, urgency, priority, risk, quality. ${WHEN} \`instructions\` (optional, recommended) says what to rate; criteria lists the levels lowest first, [level0, level1, ...]. Returns {answer: {score, confidence, legend, probabilities, answer_confidence}, id, model, usage}: probabilities are by level index and legend maps each index to its level. The likeliest level is the argmax of probabilities, and confidence and answer_confidence describe that level; score is the mean level index Σ i·p_i, which can sit between levels or round to a different one, so act on the argmax, not on score. ${TRUST}`,
  inputSchema: {
    type: 'object',
    properties: {
      state: STATE,
      instructions: { ...INSTRUCTIONS, description: 'Optional, recommended. What to rate, e.g. "How urgent is this ticket?"' },
      criteria: { type: 'array', items: {}, description: 'The levels, lowest first: [level0, level1, ...]; none null' },
      model: MODEL,
    },
    required: ['state', 'criteria'],
  },
  handler: async (args) => one('score', args),
};

export const kaiNoulTool: Tool = {
  name: 'kai_noul',
  description: `Ask Kai, Hanzo's decision model, whether a statement holds about a case: gate, check, flag. ${WHEN} \`instructions\` (optional, recommended) is the statement; criteria describes each side, {"true": ..., "false": ...}. Returns {answer: {noul, confidence, answer_confidence}, id, model, usage}: noul is the calibrated probability the statement holds, confidence is |2·noul − 1|, which is (n·p_max − 1)/(n − 1) with n = 2, and answer_confidence the likelier side's probability. Act when confidence clears your threshold; below it, escalate or ask a person. ${NOUL}`,
  inputSchema: {
    type: 'object',
    properties: {
      state: STATE,
      instructions: { ...INSTRUCTIONS, description: 'Optional, recommended. The statement, e.g. "The customer asks for a refund."' },
      criteria: { type: 'object', description: 'What each side means: {"true": ..., "false": ...}' },
      model: MODEL,
    },
    required: ['state'],
  },
  handler: async (args) => one('noul', args),
};

export const kaiTools: Tool[] = [kaiDecideTool, kaiChoiceTool, kaiScoreTool, kaiNoulTool];
