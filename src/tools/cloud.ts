/**
 * The Hanzo Cloud surface, offered as the fleet publishes it.
 *
 * One tool per subsystem, carrying that subsystem's operation names in an enum,
 * plus `describe` — which answers one operation's own prose and schema. That is
 * the shape the fleet serves at POST /v1/mcp, and it is the reason this file is
 * short: a flat projection is 1,417 tools and roughly a megabyte to enumerate,
 * which a model pays for on every turn and a client with a tool cap truncates.
 *
 * The names come from `catalog.json`, generated out of the fleet's own typed
 * operations (cloud `plugin/gen-mcp-catalog`). Nothing here is written by hand,
 * so a subsystem that gains an operation gains it here by regeneration and this
 * client cannot come to disagree with the API about what exists.
 *
 * It is a catalog rather than a fetch because a tool list is assembled
 * synchronously, before any request has been made.
 *
 * Every call goes to api.hanzo.ai — the one endpoint. The per-service hosts this
 * replaces (iam./kms./platform.) were four addresses for one API.
 */

import { Tool, ToolResult } from '../types/index.js';
import catalog from './catalog.json';

const ENDPOINT = process.env.HANZO_API_URL || process.env.API_URL || 'https://api.hanzo.ai';

type Entry = { ops: string[] };
const fleet = catalog as Record<string, Entry>;

function token(): string {
  return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || '';
}

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function refuse(why: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${why}` }], isError: true };
}

let seq = 0;

/**
 * call sends one JSON-RPC request to the fleet and returns what it answered.
 *
 * A transport failure and a refusal are told apart deliberately: `error` is the
 * fleet declining, and it is reported with its own message rather than as a
 * generic failure, because a model reads that message to decide what to do next.
 */
async function call(method: string, params: unknown): Promise<ToolResult> {
  const key = token();
  if (!key) return refuse('HANZO_API_KEY required');

  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/v1/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
    });
  } catch (e) {
    return refuse(`${ENDPOINT} unreachable: ${(e as Error).message}`);
  }

  const raw = await res.text();
  if (!res.ok) return refuse(`${res.status}: ${raw.slice(0, 400)}`);

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(`unreadable answer: ${raw.slice(0, 200)}`);
  }
  if (body.error) return refuse(body.error.message || JSON.stringify(body.error));

  // A tools/call answer IS a tool result, so it is returned as one rather than
  // stringified into a new envelope. Re-wrapping it would bury the fleet's own
  // `isError` inside a body that reads as a success — a refusal a client cannot
  // see is worse than no answer, because it is acted on.
  const out = body.result;
  if (out && Array.isArray(out.content)) return out as ToolResult;
  return text(JSON.stringify(out ?? body, null, 2));
}

/** subsystem builds the tool one subsystem is offered as. */
function subsystem(name: string, ops: string[]): Tool {
  return {
    name,
    description:
      `${name}: ${ops.length} operation${ops.length === 1 ? '' : 's'}. ` +
      `Name one in "op" and pass that operation's own arguments in "input". ` +
      `Use describe to read what an operation takes.`,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ops, description: `The ${name} operation to run.` },
        input: { type: 'object', description: "That operation's own arguments." },
      },
      required: ['op'],
    },
    handler: (args: any) => call('tools/call', { name, arguments: { op: args?.op, input: args?.input ?? {} } }),
  };
}

/**
 * describe answers one operation's prose and schema.
 *
 * It is what makes every other tool usable — the enums carry names and the
 * arguments live here — so it is registered first, where a client that keeps
 * only the head of a long list still keeps it.
 */
const describeTool: Tool = {
  name: 'describe',
  description:
    'Describes one operation: what it does and what it takes. ' +
    'Pass the subsystem tool name and the operation name.',
  inputSchema: {
    type: 'object',
    properties: {
      subsystem: { type: 'string', enum: Object.keys(fleet).sort(), description: 'The subsystem the operation belongs to.' },
      op: { type: 'string', description: 'The operation to describe.' },
    },
    required: ['subsystem', 'op'],
  },
  handler: (args: any) =>
    call('tools/call', { name: 'describe', arguments: { subsystem: args?.subsystem, op: args?.op } }),
};

export const cloudTools: Tool[] = [
  describeTool,
  ...Object.keys(fleet)
    .sort()
    .map((name) => subsystem(name, fleet[name].ops)),
];

/** operations is what this client can address, for anything that reports coverage. */
export const operations = Object.values(fleet).reduce((n, e) => n + e.ops.length, 0);
