/**
 * A plan refusal as an MCP error result.
 *
 * api.hanzo.ai refuses a request the plan, a cap or the balance will not pay for
 * with a 402 or 429 whose `error.code` names why. Clients switch on the code, never
 * on the message (hanzoai/ai `object.LimitHit`), so the result leads with it and
 * carries what the server offers to do about it: the actions (upgrade, switch,
 * credits, topup), the class, the capped model and its fallback, the window and
 * when it resets. The message is the server's own sentence, which names no figure;
 * nothing else in the body is passed on, so no amount, count or cap reaches a tool
 * result from here.
 */

import { ToolResult } from '../types/index.js';

export const CODES = [
  'plan_allowance_used',
  'paid_plan_required',
  'free_plan_cap',
  'model_cap',
  'usage_cap_exceeded',
  'insufficient_balance',
];

const ACTION_KEYS = ['kind', 'label', 'url', 'plan', 'model'];

/** Refusal is thrown by a request path and answered as its `result`. */
export class Refusal extends Error {
  constructor(readonly result: ToolResult) {
    super('refused');
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * refusal reads a non-2xx answer and returns a Refusal when it is a plan refusal
 * (402 or 429 carrying one of CODES), else undefined so the caller reports it as
 * any other error.
 */
export function refusal(status: number, body: string): Refusal | undefined {
  if (status !== 402 && status !== 429) return undefined;
  let b: any;
  try { b = JSON.parse(body); } catch { return undefined; }
  // The gate answers {error: {message, code, ...}}; a controller answers the /v1
  // envelope {status: "error", msg, code}.
  const e = b?.error && typeof b.error === 'object' ? b.error : b?.status === 'error' ? { code: b.code, message: b.msg } : undefined;
  if (!e || !CODES.includes(e.code)) return undefined;

  const actions: Record<string, string>[] = (Array.isArray(e.actions) ? e.actions : [])
    .filter((a: any) => a && typeof a === 'object' && str(a.kind))
    .map((a: any) => Object.fromEntries(ACTION_KEYS.filter((k) => str(a[k])).map((k) => [k, a[k]])));
  const upgrade = str(e.upgrade_url);
  if (upgrade && !actions.some((a) => a.url === upgrade)) actions.unshift({ kind: 'upgrade', url: upgrade });

  const error = {
    status,
    code: e.code as string,
    message: str(e.message),
    class: str(e.class),
    model: str(e.model),
    fallback: str(e.fallback),
    // `limit` names the window that is spent (session or day), never its size.
    window: str(e.limit),
    resets_at: str(e.resets_at),
    actions,
  };
  return new Refusal({ content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }], isError: true });
}
