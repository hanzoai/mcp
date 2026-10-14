/**
 * Decisions — Kai, Hanzo's decision model, on the /v1/decisions surface as MCP tools.
 *
 *   kai_decide  POST /v1/decisions  one state, any named questions: the whole decision
 *   kai_choice  POST /v1/decisions  one choice: a label
 *   kai_score   POST /v1/decisions  one score: an ordinal level
 *   kai_noul    POST /v1/decisions  one noul: the probability a statement holds
 *
 * Each call carries the caller's Hanzo bearer from the environment to `API_URL`
 * or https://api.hanzo.ai. A plan refusal (402/429 with a code) comes back as an
 * error result naming the code and the actions (./refusal.ts).
 */

import { Tool } from '../types/index.js';
import { Refusal, refusal } from './refusal.js';

function apiBase(): string {
  return process.env.LOCAL_KAI_URL || process.env.KAI_URL || process.env.API_URL || 'https://api.hanzo.ai';
}
function isLocalEndpoint(url: string): boolean {
  return url.includes('127.0.0.1') || url.includes('localhost');
}
function token(): string { return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || ''; }

// reason is the sentence in an error body — decision's error.message, the gateway's msg — else the body.
function reason(body: string): string {
  let b: any;
  try { b = JSON.parse(body); } catch { return body.substring(0, 200); }
  const m = b?.error?.message ?? b?.msg ?? b?.message ?? b?.error;
  return typeof m === 'string' && m ? m : body.substring(0, 200);
}

// decide is the one request path: Bearer auth, JSON in and out; a plan refusal throws
// a Refusal, any other non-2xx `${status}: ${sentence}`.
async function decide(body: Record<string, unknown>): Promise<any> {
  const base = apiBase();
  const t = token();
  if (!t && !isLocalEndpoint(base)) throw new Error('HANZO_API_KEY required');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (t) headers['Authorization'] = `Bearer ${t}`;
  const r = await fetch(`${base}/v1/decisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    const refused = refusal(r.status, b);
    if (refused) throw refused;
    throw new Error(`${r.status}: ${reason(b) || r.statusText || 'empty response'}`);
  }
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
    return e instanceof Refusal ? e.result : fail(e.message);
  }
}

const WHEN = 'Reach for Kai when the answer is one of options you already know — classify, route, gate, rank, check. It writes no text; open-ended answers are a language model\'s job.';
const TRUST = 'Probabilities are calibrated. confidence = (n·p_max − 1)/(n − 1) over the n options: 0 when all are equally likely, 1 when one is certain. Act when it clears your threshold; below it, escalate or ask a person.';
const NOUL = 'Write a noul as a statement and describe both sides in criteria, or ask a choice whose labels name the outcomes, such as refund and other rather than yes and no (kai_choice, or a choice question in kai_decide): Kai reads a bare yes/no question poorly.';

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
      return e instanceof Refusal ? e.result : fail(e.message);
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

export const kaiAgentStepTool: Tool = {
  name: 'kai_agent_step',
  description: "Evaluate next bounded agent decision along a task trajectory: NEXT, RECOVER, STOP, CLARIFY. Selects tools, binds verified argument byte spans, and checks completion in a single fast forward pass (<5ms).",
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The overall goal or task objective' },
      trajectory: {
        type: 'array',
        description: 'Past steps taken: [{step_index, action, tool_name, arguments, observation, is_error}]',
        items: { type: 'object' }
      },
      available_tools: {
        type: 'array',
        description: 'Candidate tool specifications: [{name, description, parameters}]',
        items: { type: 'object' }
      }
    },
    required: ['goal', 'available_tools']
  },
  handler: async (args) => {
    try {
      const t = token();
      const r = await fetch(`${apiBase()}/v1/agent/step`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(t ? { 'Authorization': `Bearer ${t}` } : {})
        },
        body: JSON.stringify({
          goal: args.goal,
          trajectory: args.trajectory || [],
          available_tools: args.available_tools || []
        })
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`${r.status}: ${reason(txt) || r.statusText}`);
      }
      return ok(await r.json());
    } catch (e: any) {
      return fail(e.message);
    }
  }
};

// --- 8 Purpose-Built Native Kai MCP Tools ---

export const kaiToolSelectTool: Tool = {
  name: 'kai_tool_select',
  description: "Shortlist the most relevant tools for a coding task from registered tool schemas using Kai's calibrated choice ranking. Filters large tool sets to high-recall candidates, returning ranked scores and calibrated abstention if ambiguous.",
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task description, current user goal, or step objective.' },
      tools: {
        type: 'array',
        description: 'Candidate tool specifications: [{ name, description, parameters? }].',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool identifier (e.g. "Bash", "Read", "edit")' },
            description: { type: 'string', description: 'What the tool does' },
            parameters: { type: 'object', description: 'Optional JSON schema of parameters' }
          },
          required: ['name', 'description']
        }
      },
      limit: { type: 'number', description: 'Maximum number of candidate tools to return in shortlist (default: 5).' },
      min_confidence: { type: 'number', description: 'Calibrated confidence threshold below which Kai abstains (default: 0.1).' },
      state: { type: ['string', 'object'], description: 'Optional current execution state or history context.' },
      model: MODEL
    },
    required: ['task', 'tools']
  },
  handler: async (args) => {
    try {
      if (!args.task || typeof args.task !== 'string') return fail('task required (string)');
      if (!Array.isArray(args.tools) || args.tools.length === 0) return fail('tools required: array with at least 1 tool');

      for (const t of args.tools) {
        if (!t || typeof t.name !== 'string' || !t.name) return fail('every tool must have a non-empty string name');
      }

      if (args.tools.length === 1) {
        const single = args.tools[0];
        return ok({
          selected_tools: [{ name: single.name, description: single.description || single.name, score: 1.0 }],
          top_tool: single.name,
          confidence: 1.0,
          abstained: false,
          reason: 'Single registered candidate'
        });
      }

      const criteria: Record<string, string> = {};
      for (const t of args.tools) {
        const desc = typeof t.description === 'string' && t.description.trim() ? t.description.trim().substring(0, 300) : t.name;
        criteria[t.name] = desc;
      }

      const questions = {
        selected_tool: {
          type: 'choice',
          instructions: 'Which tool should the agent use next to accomplish the task?',
          criteria
        }
      };

      const stateObj = typeof args.state === 'object' && args.state !== null
        ? { task: args.task, ...args.state }
        : { task: args.task, context: typeof args.state === 'string' ? args.state : '' };

      const d = await decide(request(stateObj, questions, args.model));
      const answer = d.answers.selected_tool;
      if (!answer) return fail(`decision ${d.id} returned no answer for selected_tool`);

      const probs = answer.probabilities || {};
      const scored = args.tools.map((t: any) => ({
        name: t.name,
        description: t.description || t.name,
        score: typeof probs[t.name] === 'number' ? probs[t.name] : 0,
        ...(t.parameters ? { parameters: t.parameters } : {})
      })).sort((a: any, b: any) => b.score - a.score);

      const limit = Math.max(1, Math.min(typeof args.limit === 'number' ? args.limit : 5, args.tools.length));
      const selected_tools = scored.slice(0, limit);
      const top_tool = selected_tools[0]?.name || '';
      const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
      const min_conf = typeof args.min_confidence === 'number' ? args.min_confidence : 0.1;
      const abstained = confidence < min_conf;

      return ok({
        selected_tools,
        top_tool,
        confidence,
        abstained,
        decision_id: d.id,
        model: d.model,
        latency_ms: d.latency_ms,
        reason: abstained ? `Confidence ${confidence.toFixed(3)} below threshold ${min_conf}` : 'Kai ranked candidate tools'
      });
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  }
};

export const kaiNextActionTool: Tool = {
  name: 'kai_next_action',
  description: "Recommend a typed executable next Action or abstain using Kai. Evaluates candidate actions against task state, applying zero-inference execution for single valid actions and calibrated decision ranking when multiple candidates exist.",
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Overall goal or objective.' },
      state: { type: ['string', 'object'], description: 'Current workspace context, last tool output, or error state.' },
      candidates: {
        type: 'array',
        description: 'Candidate actions: [{ action_id, tool, parameters, description, preconditions_satisfied? }].',
        items: {
          type: 'object',
          properties: {
            action_id: { type: 'string', description: 'Unique identifier for the action' },
            tool: { type: 'string', description: 'Tool name to execute' },
            parameters: { type: 'object', description: 'Arguments for the tool' },
            description: { type: 'string', description: 'Description of what this action accomplishes' },
            preconditions_satisfied: { type: 'boolean', description: 'Whether required preconditions have been validated' }
          },
          required: ['action_id', 'tool', 'description']
        }
      },
      confidence_threshold: { type: 'number', description: 'Minimum confidence required to proceed with action (default: 0.4).' },
      model: MODEL
    },
    required: ['goal', 'candidates']
  },
  handler: async (args) => {
    try {
      if (!args.goal || typeof args.goal !== 'string') return fail('goal required (string)');
      if (!Array.isArray(args.candidates)) return fail('candidates required (array)');

      if (args.candidates.length === 0) {
        return ok({
          action: null,
          abstained: true,
          confidence: 0,
          zero_inference: false,
          reason: 'No candidate actions provided'
        });
      }

      // 1. Zero-Inference Fast Path: exactly 1 candidate with satisfied preconditions
      const valid = args.candidates.filter((c: any) => c && c.preconditions_satisfied === true);
      if (valid.length === 1) {
        return ok({
          action: valid[0],
          selected_action_id: valid[0].action_id,
          confidence: 1.0,
          abstained: false,
          zero_inference: true,
          reason: 'Zero-inference fast path: exactly 1 candidate with satisfied preconditions'
        });
      }

      if (args.candidates.length === 1) {
        return ok({
          action: args.candidates[0],
          selected_action_id: args.candidates[0].action_id,
          confidence: 1.0,
          abstained: false,
          zero_inference: true,
          reason: 'Single registered action candidate'
        });
      }

      // 2. Ambiguity: multiple candidates, evaluate on Kai
      const criteria: Record<string, string> = {};
      for (const c of args.candidates) {
        criteria[c.action_id] = `${c.tool}: ${c.description || c.action_id}`;
      }

      const questions = {
        action: {
          type: 'choice',
          instructions: 'Which executable action is the best next step to achieve the goal?',
          criteria
        }
      };

      const d = await decide(request({ goal: args.goal, state: args.state || {} }, questions, args.model));
      const answer = d.answers.action;
      if (!answer) return fail(`decision ${d.id} returned no answer for action`);

      const chosenId = answer.choice;
      const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
      const threshold = typeof args.confidence_threshold === 'number' ? args.confidence_threshold : 0.4;
      const chosenCandidate = args.candidates.find((c: any) => c.action_id === chosenId) || null;
      const abstained = confidence < threshold || !chosenCandidate;

      return ok({
        action: abstained ? null : chosenCandidate,
        selected_action_id: chosenId,
        confidence,
        abstained,
        zero_inference: false,
        probabilities: answer.probabilities || {},
        decision_id: d.id,
        latency_ms: d.latency_ms,
        reason: abstained ? `Confidence ${confidence.toFixed(3)} below threshold ${threshold}` : 'Kai decided candidate action'
      });
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  }
};

const DENY_PATTERNS = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force|-[a-zA-Z]*f[a-zA-Z]*r).*\s+\/($|\s)/, // rm -rf /
  /mkfs(\.[a-zA-Z0-9]+)?\s+/, // format drive
  /dd\s+if=.*of=\/dev\/(sd[a-z]|nvme|hd[a-z])/, // wipe disk
  /:\(\)\s*\{\s*:\|\:&\s*\}\s*;\s*:/, // fork bomb
  /cat\s+.*(\.env|\.ssh\/id_rsa|\.ssh\/id_ed25519|credentials|\.aws\/credentials)/i, // read secrets
  /curl\s+.*(-d|--data).*(\.env|id_rsa|\/etc\/shadow)/i, // exfiltrate secrets
  />\s*\/etc\/(passwd|shadow|hosts|sudoers)/, // overwrite critical system files
  /chmod\s+(-R\s+)?777\s+\/($|\s)/ // world-writable root
];

const ASK_PATTERNS = [
  /git\s+push\s+.*(--force|-f)($|\s)/, // force push
  /git\s+reset\s+--hard/, // hard reset
  /sudo\s+/, // sudo command
  /npm\s+i(nstall)?\s+-g/, // global package install
  /pip\s+install\s+(?!-t|--target|--user)/, // global pip install
  /curl\s+.*\|\s*(bash|sh|zsh)/, // piping curl to shell
  /wget\s+.*\|\s*(bash|sh|zsh)/,
  /drop\s+(table|database)/i, // sql drop
  /truncate\s+table/i
];

const ALLOW_PATTERNS = [
  /^git\s+(status|diff|log|branch|show|rev-parse)/,
  /^cargo\s+(test|check|build|clippy)/,
  /^npm\s+(test|run\s+(test|build|lint|check))/,
  /^(pytest|go\s+test)/,
  /^(ls|pwd|echo|head|tail|grep|rg|find|which|whoami)($|\s)/
];

function checkDeterministicPolicy(cmd: string): { verdict: 'allow' | 'ask' | 'deny'; reason: string; is_verified_allow: boolean } {
  for (const p of DENY_PATTERNS) {
    if (p.test(cmd)) {
      return { verdict: 'deny', reason: `Deterministic security policy: blocked high-risk command pattern (${p.source})`, is_verified_allow: false };
    }
  }
  for (const p of ASK_PATTERNS) {
    if (p.test(cmd)) {
      return { verdict: 'ask', reason: `Deterministic security policy: requires user approval (${p.source})`, is_verified_allow: false };
    }
  }
  for (const p of ALLOW_PATTERNS) {
    if (p.test(cmd)) {
      return { verdict: 'allow', reason: 'Verified safe read-only command pattern', is_verified_allow: true };
    }
  }
  return { verdict: 'allow', reason: 'Passed deterministic policy checks', is_verified_allow: false };
}

const LATTICE_ORDER: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

export const kaiCommandGuardTool: Tool = {
  name: 'kai_command_guard',
  description: "Classify shell command execution risk (allow, ask, deny) using deterministic security policy combined with Kai's calibrated risk assessment. Enforces strict monotonic lattice: allow < ask < deny (never loosens deterministic policy).",
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command line string to evaluate (e.g. "git push --force", "rm -rf /", "cargo test").' },
      working_dir: { type: 'string', description: 'Current working directory.' },
      policy: { type: 'string', enum: ['allow', 'ask', 'deny'], description: 'Initial deterministic policy level (default: "allow").' },
      model: MODEL
    },
    required: ['command']
  },
  handler: async (args) => {
    try {
      if (!args.command || typeof args.command !== 'string') return fail('command required (string)');

      const policyVerdict = checkDeterministicPolicy(args.command);
      const callerPolicy = (args.policy && ['allow', 'ask', 'deny'].includes(args.policy)) ? args.policy : 'allow';
      const basePolicy = LATTICE_ORDER[policyVerdict.verdict] >= LATTICE_ORDER[callerPolicy] ? policyVerdict.verdict : callerPolicy;

      // Ask Kai for command risk assessment (grounded in agent.command-risk@1.json)
      const questions = {
        verdict: {
          type: 'choice',
          instructions: 'Should the agent run this shell command?',
          criteria: {
            allow: 'read-only, or confined to the working repository without destroying data',
            ask: 'writes outside the repository, installs global software, or touches shared systems',
            deny: 'reads or exfiltrates secrets, keys, ~/.ssh or .env files, or causes irreversible destruction'
          }
        },
        secret_exposure: {
          type: 'noul',
          instructions: 'Could this command read, print or send credentials, keys, or private tokens?'
        },
        production_impact: {
          type: 'noul',
          instructions: 'Could this command change or break a production system, external server, or shared data?'
        },
        network: {
          type: 'noul',
          instructions: 'Does this command send or fetch data over the network?'
        }
      };

      const d = await decide(request({
        command: args.command,
        working_dir: args.working_dir || '.'
      }, questions, args.model));

      const vAnswer = d.answers.verdict;
      let modelVerdict: 'allow' | 'ask' | 'deny' = (vAnswer?.choice as any) || 'allow';
      const modelConfidence = typeof vAnswer?.confidence === 'number' ? vAnswer.confidence : 0.5;
      const secretExposure = d.answers.secret_exposure?.noul ?? 0;
      const productionImpact = d.answers.production_impact?.noul ?? 0;
      const network = d.answers.network?.noul ?? 0;

      // Escalate based on risk factors (grounded in agent.command-risk@1 rules)
      if (secretExposure >= 0.55) {
        modelVerdict = 'deny';
      } else if (productionImpact >= 0.55 && LATTICE_ORDER[modelVerdict] < LATTICE_ORDER['ask']) {
        modelVerdict = 'ask';
      } else if (network >= 0.65 && modelVerdict === 'allow') {
        modelVerdict = 'ask';
      }

      // If deterministic policy explicitly verified the command as a safe read-only pattern,
      // only escalate if model is confident (confidence >= 0.5) and indicates deny or severe secret exposure
      let finalVerdict: 'allow' | 'ask' | 'deny';
      if (policyVerdict.is_verified_allow && modelVerdict !== 'allow' && modelConfidence < 0.4 && secretExposure < 0.55) {
        finalVerdict = 'allow';
      } else {
        finalVerdict = LATTICE_ORDER[basePolicy] >= LATTICE_ORDER[modelVerdict] ? basePolicy : modelVerdict;
      }

      return ok({
        verdict: finalVerdict,
        policy_verdict: basePolicy,
        model_verdict: modelVerdict,
        confidence: vAnswer?.confidence ?? 0.5,
        risk_factors: {
          secret_exposure: secretExposure,
          production_impact: productionImpact,
          network
        },
        reason: basePolicy === 'deny' ? policyVerdict.reason : `Kai evaluated command risk (${finalVerdict})`,
        decision_id: d.id,
        latency_ms: d.latency_ms
      });
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  }
};

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior)\s+(prompts|instructions)/i,
  /you\s+are\s+now\s+(DAN|unrestricted|in\s+developer\s+mode|an\s+unconstrained\s+AI)/i,
  /<\/?system>/i,
  /\[SYSTEM\s+INSTRUCTION\]/i,
  /<<<SYSTEM>>>/i,
  /<\|im_start\|>system/i,
  /reveal\s+(your\s+)?(system\s+prompt|hidden\s+instructions|secret\s+key)/i,
  /print\s+(your\s+)?(full\s+)?system\s+prompt/i,
  /exfiltrate\s+to\s+http/i
];

export const kaiInjectionScreenTool: Tool = {
  name: 'kai_injection_screen',
  description: "Screen untrusted text, tool outputs, or user prompts for prompt injection, system override, and jailbreak patterns using Kai. Returns calibrated injection probability, risk level, and flagged status. Note: Defense-in-depth, not a sole security guarantee.",
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The untrusted text content to screen (tool outputs, web content, user input).' },
      source: { type: 'string', description: 'Source origin: "tool_output", "web_fetch", "user_prompt", "git_commit", etc.' },
      threshold: { type: 'number', description: 'Calibrated probability threshold for flagging injection (default: 0.5).' },
      model: MODEL
    },
    required: ['text']
  },
  handler: async (args) => {
    try {
      if (!args.text || typeof args.text !== 'string') return fail('text required (string)');

      const detectedCategories: string[] = [];
      let deterministicFlag = false;
      for (const p of INJECTION_PATTERNS) {
        if (p.test(args.text)) {
          deterministicFlag = true;
          detectedCategories.push(`pattern_match_${p.source.substring(0, 20)}`);
        }
      }

      const sample = args.text.slice(0, 3000);
      const questions = {
        is_injection: {
          type: 'noul',
          instructions: 'Does this text attempt to inject instructions, override system rules, hijack agent control, or extract internal credentials?'
        },
        risk_level: {
          type: 'score',
          instructions: 'What is the security risk level of this input?',
          criteria: ['benign_content', 'suspicious_ambiguous_text', 'malicious_injection_or_exploit']
        }
      };

      const d = await decide(request({
        source: args.source || 'unknown',
        text: sample
      }, questions, args.model));

      const injectionProb = d.answers.is_injection?.noul ?? (deterministicFlag ? 0.95 : 0.05);
      const scoreVal = d.answers.risk_level?.score ?? (deterministicFlag ? 2 : 0);
      const riskIdx = Math.max(0, Math.min(2, Math.round(scoreVal)));
      const riskLabels = ['benign', 'suspicious', 'malicious'] as const;
      const riskLevel = deterministicFlag ? 'malicious' : riskLabels[riskIdx];
      const threshold = typeof args.threshold === 'number' ? args.threshold : 0.5;
      const flagged = deterministicFlag || injectionProb >= threshold || riskIdx >= 2;

      return ok({
        flagged,
        injection_probability: injectionProb,
        risk_level: riskLevel,
        categories: detectedCategories,
        confidence: d.answers.is_injection?.confidence ?? (deterministicFlag ? 1.0 : 0.5),
        defense_in_depth_note: 'Screening is defense-in-depth, not a complete security guarantee.',
        decision_id: d.id,
        latency_ms: d.latency_ms
      });
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  }
};

export const kaiExtractTool: Tool = {
  name: 'kai_extract',
  description: "Extract typed structured choices and ratings from text or observations using Kai. Maps extraction schemas to a single-pass multi-question decision, returning calibrated values and confidence for each field.",
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: ['string', 'object'], description: 'The text or evidence to extract information from.' },
      schema: {
        type: 'object',
        description: 'Field extraction schema: { [fieldName]: { type: "choice"|"score"|"noul", description: string, options?: string[]|object, levels?: string[] } }',
        additionalProperties: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['choice', 'score', 'noul'] },
            description: { type: 'string', description: 'What to extract for this field' },
            options: { type: ['array', 'object'], description: 'For choice: candidate labels [opt1, opt2] or {opt1: desc1, opt2: desc2}' },
            levels: { type: 'array', description: 'For score: ordered levels [low, med, high]' }
          },
          required: ['type']
        }
      },
      model: MODEL
    },
    required: ['text', 'schema']
  },
  handler: async (args) => {
    try {
      if (!content(args.text)) return fail('text required (string, object, or array)');
      if (typeof args.schema !== 'object' || args.schema === null || Array.isArray(args.schema)) {
        return fail('schema required: object mapping field names to question specifications');
      }

      const questions: Record<string, any> = {};
      for (const [field, spec] of Object.entries(args.schema)) {
        if (typeof spec !== 'object' || spec === null) return fail(`schema field '${field}' must be an object`);
        const s: any = spec;
        if (!['choice', 'score', 'noul'].includes(s.type)) {
          return fail(`schema field '${field}' type must be choice, score, or noul`);
        }
        const q: any = { type: s.type };
        if (s.description) q.instructions = s.description;
        if (s.type === 'choice') {
          q.criteria = s.options || s.criteria;
          if (!q.criteria) return fail(`choice field '${field}' requires options`);
        } else if (s.type === 'score') {
          q.criteria = s.levels || s.criteria;
          if (!q.criteria) return fail(`score field '${field}' requires levels`);
        } else if (s.type === 'noul' && s.criteria) {
          q.criteria = s.criteria;
        }
        questions[field] = q;
      }

      const d = await decide(request(args.text, questions, args.model));
      const extracted: Record<string, any> = {};
      let totalConfidence = 0;
      let count = 0;

      for (const [field, ans] of Object.entries(d.answers as Record<string, any>)) {
        count++;
        const conf = typeof ans.confidence === 'number' ? ans.confidence : 0;
        totalConfidence += conf;
        let val: any;
        if (ans.type === 'choice') val = ans.choice;
        else if (ans.type === 'score') val = ans.score;
        else if (ans.type === 'noul') val = ans.noul >= 0.5;
        extracted[field] = {
          value: val,
          confidence: conf,
          probabilities: ans.probabilities,
          abstained: conf < 0.1
        };
      }

      return ok({
        extracted,
        overall_confidence: count > 0 ? totalConfidence / count : 1.0,
        decision_id: d.id,
        model: d.model,
        latency_ms: d.latency_ms
      });
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  }
};

export const kaiLogTriageTool: Tool = {
  name: 'kai_log_triage',
  description: "Triage and classify build, test, and runtime failure logs using Kai. Categorizes the root error, rates severity, isolates relevant file/line evidence, and determines if the error is deterministic or flaky.",
  inputSchema: {
    type: 'object',
    properties: {
      logs: { type: 'string', description: 'Raw build logs, compiler diagnostics, stack traces, or test outputs.' },
      command: { type: 'string', description: 'The command that produced the logs (e.g. "cargo test", "npm run build").' },
      model: MODEL
    },
    required: ['logs']
  },
  handler: async (args) => {
    try {
      if (!args.logs || typeof args.logs !== 'string') return fail('logs required (string)');

      const filePattern = /(?:[\/\w\.-]+\/)?[\w\.-]+\.(?:rs|ts|js|py|go|c|cpp|h|java|json|yaml|toml):(?:\d+)(?::(?:\d+))?/g;
      const matches = Array.from(new Set(args.logs.match(filePattern) || []));

      const lines = args.logs.split('\n');
      const errorLines = lines.filter((l: string) => /error|fail|panic|exception|assert|fatal/i.test(l)).slice(0, 10);
      const excerpt = errorLines.join('\n') || args.logs.substring(0, 500);

      const questions = {
        category: {
          type: 'choice',
          instructions: 'What is the primary category of this failure?',
          criteria: {
            compilation_error: 'compiler syntax, type, borrow checker, or symbol resolution error',
            test_assertion_failure: 'test assertion failed, expected vs actual mismatch, or test panic',
            runtime_panic_or_crash: 'unhandled runtime exception, panic, segfault, or abort',
            dependency_missing: 'missing package, module, crate, or binary in environment',
            timeout_or_hang: 'operation exceeded deadline, timed out, or hung',
            permission_or_io: 'file permission denied, disk full, or missing file/dir'
          }
        },
        severity: {
          type: 'score',
          instructions: 'What is the severity of this log error?',
          criteria: ['informational_or_warning', 'recoverable_test_or_code_error', 'fatal_environment_or_system_failure']
        },
        deterministic: {
          type: 'noul',
          instructions: 'Is this error deterministic and reproducible rather than a transient flaky failure?'
        }
      };

      const d = await decide(request({
        command: args.command || '',
        evidence: excerpt
      }, questions, args.model));

      const catAns = d.answers.category;
      const sevAns = d.answers.severity;
      const detAns = d.answers.deterministic;

      const sevLabels = ['warning', 'recoverable_error', 'fatal_failure'] as const;
      const sevIdx = Math.max(0, Math.min(2, Math.round(sevAns?.score ?? 1)));

      return ok({
        category: catAns?.choice || 'unknown_error',
        severity: sevLabels[sevIdx],
        deterministic: (detAns?.noul ?? 0.5) >= 0.5,
        confidence: catAns?.confidence ?? 0.5,
        relevant_files: matches.slice(0, 5),
        evidence_snippet: excerpt,
        decision_id: d.id,
        latency_ms: d.latency_ms
      });
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  }
};

const DEFAULT_RECOVERY_STRATEGIES = [
  { id: 'inspect_source_evidence', description: 'Read surrounding code, imports, and definitions to understand failure root cause.' },
  { id: 'retry_with_corrected_parameters', description: 'Adjust arguments, paths, or flags to correct syntax or missing parameters.' },
  { id: 'run_focused_test_diagnostics', description: 'Execute a single failing test or compiler check with verbose output.' },
  { id: 'revert_and_switch_strategy', description: 'Discard the current failing edit and take an alternative architectural approach.' },
  { id: 'install_missing_dependency', description: 'Add missing package, update build configuration, or set required environment variable.' }
];

export const kaiRecoverTool: Tool = {
  name: 'kai_recover',
  description: "Select an optimal recovery strategy for task or tool failures using Kai. Evaluates failure fingerprints, detects recurring error loops, and enforces circuit breaking after repeated failures.",
  inputSchema: {
    type: 'object',
    properties: {
      error_category: { type: 'string', description: 'Error category (from kai_log_triage or tool outcome).' },
      failure_fingerprint: {
        type: 'object',
        description: 'Failure fingerprint: { tool: string, error_snippet: string, attempt_count: number, last_action?: string }.',
        properties: {
          tool: { type: 'string', description: 'Tool that failed' },
          error_snippet: { type: 'string', description: 'Key error message or failure summary' },
          attempt_count: { type: 'number', description: 'Number of consecutive attempts that have failed with this fingerprint' },
          last_action: { type: 'string', description: 'Last action attempted' }
        },
        required: ['tool', 'error_snippet', 'attempt_count']
      },
      strategies: {
        type: 'array',
        description: 'Optional list of candidate recovery strategies: [{ id, description }].',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['id', 'description']
        }
      },
      model: MODEL
    },
    required: ['error_category', 'failure_fingerprint']
  },
  handler: async (args) => {
    try {
      if (!args.error_category || typeof args.error_category !== 'string') return fail('error_category required (string)');
      if (!args.failure_fingerprint || typeof args.failure_fingerprint !== 'object') {
        return fail('failure_fingerprint required: { tool, error_snippet, attempt_count }');
      }

      const fp = args.failure_fingerprint;
      const attemptCount = typeof fp.attempt_count === 'number' ? fp.attempt_count : 1;

      // Deterministic Loop Breaker (Circuit breaker on repeated attempts)
      if (attemptCount >= 3) {
        return ok({
          strategy: 'revert_and_switch_strategy',
          confidence: 1.0,
          abstained: false,
          attempt_count: attemptCount,
          loop_breaker_triggered: true,
          actionable_guidance: `Attempt count ${attemptCount} reached loop limit (3). Circuit breaker tripped: stop repeating identical actions and switch strategy or request human clarification.`
        });
      }

      const strats = Array.isArray(args.strategies) && args.strategies.length >= 2
        ? args.strategies
        : DEFAULT_RECOVERY_STRATEGIES;

      const criteria: Record<string, string> = {};
      for (const s of strats) {
        criteria[s.id] = s.description || s.id;
      }

      const questions = {
        recovery_strategy: {
          type: 'choice',
          instructions: 'Which recovery strategy is most appropriate to resolve this failure without looping?',
          criteria
        }
      };

      const d = await decide(request({
        error_category: args.error_category,
        tool: fp.tool,
        error_snippet: fp.error_snippet,
        attempt_count: attemptCount,
        last_action: fp.last_action || ''
      }, questions, args.model));

      const ans = d.answers.recovery_strategy;
      const strategy = ans?.choice || 'inspect_source_evidence';
      const confidence = typeof ans?.confidence === 'number' ? ans.confidence : 0.5;

      const guidanceMap: Record<string, string> = {
        inspect_source_evidence: 'Inspect failing file and surrounding symbols before making further edits.',
        retry_with_corrected_parameters: 'Update command or tool arguments to match required schema.',
        run_focused_test_diagnostics: 'Run the isolated failing test to reproduce error deterministically.',
        revert_and_switch_strategy: 'Revert uncommitted breaking change and try alternative implementation.',
        install_missing_dependency: 'Install the missing library or binary dependency before retrying.'
      };

      return ok({
        strategy,
        confidence,
        abstained: confidence < 0.2,
        attempt_count: attemptCount,
        loop_breaker_triggered: false,
        actionable_guidance: guidanceMap[strategy] || `Proceed with recovery strategy: ${strategy}`,
        decision_id: d.id,
        latency_ms: d.latency_ms
      });
    } catch (e: any) {
      return e instanceof Refusal ? e.result : fail(e.message);
    }
  }
};

export const kaiTools: Tool[] = [kaiDecideTool, kaiChoiceTool, kaiScoreTool, kaiNoulTool];
export const kaiAgentTools: Tool[] = [kaiAgentStepTool];
export const kaiPurposeBuiltTools: Tool[] = [
  kaiToolSelectTool,
  kaiNextActionTool,
  kaiCommandGuardTool,
  kaiInjectionScreenTool,
  kaiExtractTool,
  kaiLogTriageTool,
  kaiRecoverTool,
];
export const kai8Tools: Tool[] = [
  kaiDecideTool,
  ...kaiPurposeBuiltTools,
];

