/**
 * kai — THE ONE SINGLE KAI TOOL (HIP-0300).
 *
 * Unifies:
 *   - Calibrated Decisions (/v1/decisions): decide, choice, score, noul
 *   - Verified Kai Actions (rust/actions): run, plan, list, triggers
 *   - Context Compaction: compact
 *   - Deterministic Selection & Safety: tool_select, next_action, command_guard,
 *     injection_screen, extract, log_triage, recover
 *   - Single-pass Trajectory Step: agent_step
 *
 * Schema matches `schema/kai.json` and `rust/schema/kai.json` byte-for-byte.
 */

import { spawn } from 'node:child_process';
import { Tool } from '../types/index.js';
import { kaiCompactTool } from './compact.js';
import {
  kaiAgentStepTool,
  kaiChoiceTool,
  kaiCommandGuardTool,
  kaiDecideTool,
  kaiExtractTool,
  kaiInjectionScreenTool,
  kaiLogTriageTool,
  kaiNextActionTool,
  kaiNoulTool,
  kaiRecoverTool,
  kaiScoreTool,
  kaiToolSelectTool,
} from './kai.js';

export const kaiActionSchema = {
  "name": "kai",
  "description": "Kai — Hanzo's unified decision model and verified action engine. One tool for calibrated decisions (/v1/decisions: decide, choice, score, noul), verified zero-LLM repository actions (run, plan, list, triggers), typed context compaction (compact), deterministic tool & candidate ranking (tool_select, next_action), pre-execution command policy (command_guard), prompt-injection screening (injection_screen), structured field extraction (extract), build/CI failure classification & loop-breaking recovery (log_triage, recover), and single-pass trajectory steps (agent_step).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "decide",
          "choice",
          "score",
          "noul",
          "run",
          "plan",
          "list",
          "triggers",
          "compact",
          "tool_select",
          "next_action",
          "command_guard",
          "injection_screen",
          "extract",
          "log_triage",
          "recover",
          "agent_step"
        ],
        "default": "run",
        "description": "Kai operation: decide | choice | score | noul | run | plan | list | triggers | compact | tool_select | next_action | command_guard | injection_screen | extract | log_triage | recover | agent_step"
      },
      "state": {
        "type": ["string", "object", "array"],
        "items": {},
        "description": "The case to decide about (decide, choice, score, noul, next_action)"
      },
      "questions": {
        "type": "object",
        "description": "decide: Question name -> {type: choice|score|noul, instructions?, criteria?}; 1 to 100 questions"
      },
      "instructions": {
        "type": ["string", "object", "array"],
        "items": {},
        "description": "choice / score / noul: What Kai answers"
      },
      "criteria": {
        "type": ["object", "array"],
        "items": {},
        "description": "choice: {label: desc} or [label, ...]; score: [level0, level1, ...]; noul: {\"true\": ..., \"false\": ...}"
      },
      "request": {
        "type": "string",
        "description": "run / plan / triggers: The chore in the user's words"
      },
      "cwd": {
        "type": "string",
        "description": "run / plan: Working directory (default: server cwd)"
      },
      "approve": {
        "type": "boolean",
        "description": "run / plan: Grant approval for consequential actions (push, remote, outside workspace, stop process)"
      },
      "ask": {
        "type": "boolean",
        "description": "run / plan: Ask Kai when several actions or values remain (default true)"
      },
      "model": {
        "type": "string",
        "description": "Decision model (default kai)"
      },
      "cache": {
        "type": "string",
        "description": "run / plan: Directory for action proofs and reusable memos"
      },
      "prove": {
        "type": "boolean",
        "description": "run / plan: Record a proof for each action whose verifier passes"
      },
      "min_margin": {
        "type": "number",
        "description": "run / plan: Least lead of Kai's pick over the next real option (default 0.1)"
      },
      "min_p": {
        "type": "number",
        "description": "run / plan: Least probability of Kai's pick among real options (default 0)"
      },
      "max_abstain": {
        "type": "number",
        "description": "run / plan: Most probability Kai may give to abstaining (default 0.6)"
      },
      "messages": {
        "type": "array",
        "items": { "type": "object" },
        "description": "compact: Conversation messages to compact"
      },
      "preserve_recent": {
        "type": "number",
        "description": "compact: Number of recent messages to keep verbatim (default 4)"
      },
      "keep_threshold": {
        "type": "number",
        "description": "compact: Confidence threshold for keeping tool outputs (default 0.5)"
      },
      "truncate_chars": {
        "type": "number",
        "description": "compact: Max characters retained for truncated outputs (default 400)"
      },
      "task": {
        "type": "string",
        "description": "tool_select: What the agent is about to do"
      },
      "tools": {
        "type": "array",
        "items": { "type": "object" },
        "description": "tool_select: Candidate tools [{name, description?, parameters?}]"
      },
      "limit": {
        "type": "number",
        "description": "tool_select: Maximum ranked tools to return (default 5)"
      },
      "goal": {
        "type": "string",
        "description": "next_action / agent_step: Overall task objective"
      },
      "candidates": {
        "type": "array",
        "items": { "type": "object" },
        "description": "next_action: Candidate actions [{action_id, tool, description, parameters?, preconditions_satisfied?}]"
      },
      "command": {
        "type": "string",
        "description": "command_guard: Shell command line to classify (allow | ask | deny)"
      },
      "policy": {
        "type": "string",
        "enum": ["allow", "ask", "deny"],
        "description": "command_guard: Floor verdict (default allow)"
      },
      "text": {
        "type": ["string", "object"],
        "description": "injection_screen / extract: Untrusted text or evidence object"
      },
      "schema": {
        "type": "object",
        "description": "extract: Field extraction schema {field: {type: choice|score|noul, description?, options?, levels?}}"
      },
      "logs": {
        "type": "string",
        "description": "log_triage: Build, test, or CI log tail"
      },
      "error_category": {
        "type": "string",
        "description": "recover: Failure class from log_triage"
      },
      "failure_fingerprint": {
        "type": "object",
        "description": "recover: {tool, error_snippet, attempt_count, last_action?}"
      },
      "trajectory": {
        "type": "array",
        "items": { "type": "object" },
        "description": "agent_step: Prior steps [{step_index, action, tool_name, arguments, observation, is_error}]"
      },
      "available_tools": {
        "type": "array",
        "items": { "type": "object" },
        "description": "agent_step: Candidate tool specifications [{name, description, parameters}]"
      }
    }
  }
};

function ok(v: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] }; }
function fail(m: string) { return { content: [{ type: 'text' as const, text: `Error: ${m}` }], isError: true as const }; }

const NATIVE_ACTIONS = ['run', 'plan', 'list', 'triggers'];
const ALL_ACTIONS = kaiActionSchema.inputSchema.properties.action.enum;

const SUITE_HANDLERS: Record<string, Tool> = {
  decide: kaiDecideTool,
  choice: kaiChoiceTool,
  score: kaiScoreTool,
  noul: kaiNoulTool,
  compact: kaiCompactTool,
  tool_select: kaiToolSelectTool,
  next_action: kaiNextActionTool,
  command_guard: kaiCommandGuardTool,
  injection_screen: kaiInjectionScreenTool,
  extract: kaiExtractTool,
  log_triage: kaiLogTriageTool,
  recover: kaiRecoverTool,
  agent_step: kaiAgentStepTool,
};

// argv is the native CLI's command line for one call: `hanzo-mcp kai <action> --cwd ... --request ...`.
export function argv(args: any): string[] {
  const action = args.action || 'run';
  if (action === 'list') return ['kai', 'list'];
  if (action === 'triggers') return ['kai', 'triggers', '--request', String(args.request)];
  const out = ['kai', action, '--cwd', args.cwd || process.cwd(), '--request', String(args.request)];
  if (args.ask !== false) {
    const base = (process.env.HANZO_API_BASE || process.env.HANZO_API_URL || 'https://api.hanzo.ai').replace(/\/+$/, '').replace(/\/v1$/, '');
    out.push('--kai', `${base}/v1`, '--model', args.model || 'kai');
    if (process.env.HANZO_API_KEY) out.push('--key-env', 'HANZO_API_KEY');
  }
  if (args.cache) out.push('--cache', args.cache);
  if (args.approve === true) out.push('--approve', 'grant');
  if (args.prove === true) out.push('--prove');
  for (const [k, flag] of [['min_margin', '--min-margin'], ['min_p', '--min-p'], ['max_abstain', '--max-abstain']] as const) {
    if (typeof args[k] === 'number') out.push(flag, String(args[k]));
  }
  return out;
}

function native(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const bin = process.env.HANZO_MCP_NATIVE as string;
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: null, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

export const kaiActionTool: Tool = {
  name: kaiActionSchema.name,
  description: kaiActionSchema.description,
  inputSchema: kaiActionSchema.inputSchema as Tool['inputSchema'],
  handler: async (args) => {
    const action = args?.action || 'run';
    if (SUITE_HANDLERS[action]) {
      return SUITE_HANDLERS[action].handler(args);
    }
    if (!NATIVE_ACTIONS.includes(action)) {
      return fail(`action must be one of ${ALL_ACTIONS.join(', ')}`);
    }
    if (action !== 'list' && (typeof args?.request !== 'string' || !args.request)) return fail('request required');
    if (!process.env.HANZO_MCP_NATIVE) return fail('kai runs in the native runtime: serve the Rust hanzo-mcp, or set HANZO_MCP_NATIVE to its path');
    const r = await native(argv(args));
    if (r.code === null || ![0, 2, 3].includes(r.code)) return fail(r.err.trim() || `hanzo-mcp kai exited ${r.code}`);
    try {
      return ok(JSON.parse(r.out));
    } catch {
      return fail(`not a report: ${r.out.substring(0, 200)}`);
    }
  },
};

export const kaiTool = kaiActionTool;
export const kaiActionTools: Tool[] = [kaiActionTool];
