/**
 * Kai Actions — `kai`: run a request as a saved, typed, verified action.
 *
 * One tool, action-routed (run, plan, list, triggers). The executor is the Rust runtime's `actions` module
 * (rust/src/actions): it matches the request to an action or workflow, binds its inputs from the request and from
 * values read out of the repository (Kai is asked only when several remain, and may abstain; it never writes a
 * command), checks the preconditions again just before it runs, and the action's verifier says whether it worked.
 *
 * This file carries the schema and delegates the work. The schema is `schema/kai.json`, and the Rust runtime
 * (`rust/schema/kai.json`) holds the same text; test/tools/kai-action.test.ts fails if the three differ. The work is not
 * written twice: the tool runs the native binary named by HANZO_MCP_NATIVE (`hanzo-mcp kai ...`) and returns its JSON.
 */

import { spawn } from 'node:child_process';
import { Tool } from '../types/index.js';

export const kaiActionSchema = {
  "name": "kai",
  "description": "Kai Actions: run a request as a saved, typed, verified action. A chore that recurs (find where a name is used, run the suite and count, commit named paths and push, wait for a rollout to finish, create a worktree, rebuild a pinned copy from a commit, compare two arms of a results file, add a line to a section of a document) runs with no model call: the request is matched to an action or workflow by trigger, its inputs are bound from the request and from values read out of the repository (Kai is asked only when several remain, and may abstain; it never writes a command), the preconditions are read again just before it runs, and the action's own verifier says whether it worked. action=run does it and returns the ledger: outcome done, failed or declined, and one record per step with its source (rule or kai), revision, preconditions, authorization, cache use, steps, timing and verdict. A declined request (nothing fits, an input is missing or ambiguous, a precondition fails, the action is unproven here, approval is missing) is yours to do the usual way. An action that writes outside the workspace, reaches a remote or stops a process runs only with approve=true: ask the user first, then call again. action=plan binds without running; list shows the catalog; triggers shows which actions a request fires. Reports and files named in the request (\"write ... to answer.txt\") are written for you.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "run",
          "plan",
          "list",
          "triggers"
        ],
        "default": "run",
        "description": "run: execute the request as an action or workflow; plan: bind it and say what would run; list: the catalog; triggers: the actions and workflows whose triggers fit the request"
      },
      "request": {
        "type": "string",
        "description": "The chore in the user's words, as you would give it to an agent (required for run, plan and triggers)"
      },
      "cwd": {
        "type": "string",
        "description": "The directory the request is made in (default: the server's working directory)"
      },
      "approve": {
        "type": "boolean",
        "description": "Grant the approval a consequential action needs (a push or fetch, a write outside the workspace, stopping a process). Default false: such a request is declined with its reason."
      },
      "ask": {
        "type": "boolean",
        "description": "Ask Kai when several actions or values remain (default true). false declines them instead."
      },
      "model": {
        "type": "string",
        "description": "Decision model (default kai)"
      },
      "cache": {
        "type": "string",
        "description": "A directory for the cache: proofs that an action has worked here, and results it can reuse while what they read is unchanged"
      },
      "prove": {
        "type": "boolean",
        "description": "Record a proof for each action whose verifier passes, and do not require one (a proving workspace)"
      },
      "min_margin": {
        "type": "number",
        "description": "The least lead of Kai's pick over the next option, among the real options (default 0.1)"
      },
      "min_p": {
        "type": "number",
        "description": "The least probability of Kai's pick among the real options (default 0)"
      },
      "max_abstain": {
        "type": "number",
        "description": "The most probability Kai may give to abstaining (default 0.6)"
      }
    }
  }
};

function ok(v: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] }; }
function fail(m: string) { return { content: [{ type: 'text' as const, text: `Error: ${m}` }], isError: true as const }; }

const ACTIONS = ['run', 'plan', 'list', 'triggers'];

// argv is the native CLI's command line for one call: `hanzo-mcp kai <action> --cwd ... --request ...`.
export function argv(args: any): string[] {
  const action = args.action || 'run';
  if (action === 'list') return ['kai', 'list'];
  if (action === 'triggers') return ['kai', 'triggers', '--request', String(args.request)];
  const out = ['kai', action, '--cwd', args.cwd || process.cwd(), '--request', String(args.request)];
  if (args.ask !== false) {
    const base = (process.env.HANZO_API_BASE || 'https://api.hanzo.ai').replace(/\/+$/, '');
    // The key goes to the configured API alone: a call never names where it is sent.
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
    if (!ACTIONS.includes(action)) return fail(`action must be one of ${ACTIONS.join(', ')}`);
    if (action !== 'list' && (typeof args?.request !== 'string' || !args.request)) return fail('request required');
    if (!process.env.HANZO_MCP_NATIVE) return fail('kai runs in the native runtime: serve the Rust hanzo-mcp, or set HANZO_MCP_NATIVE to its path');
    const r = await native(argv(args));
    // The CLI exits 0 done, 2 declined, 3 failed: each prints the report. Anything else is the CLI itself failing.
    if (r.code === null || ![0, 2, 3].includes(r.code)) return fail(r.err.trim() || `hanzo-mcp kai exited ${r.code}`);
    try {
      return ok(JSON.parse(r.out));
    } catch {
      return fail(`not a report: ${r.out.substring(0, 200)}`);
    }
  },
};

export const kaiActionTools: Tool[] = [kaiActionTool];
