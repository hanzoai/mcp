/**
 * One retrying fetch for the calls that start and watch cloud runs: a 429 waits the Retry-After the
 * server named (seconds or an HTTP date, never past a minute) or backs off, and a failure that
 * passes (500, 502, 503, 504, a timeout, a reset, a refused connection) is tried again. Four tries
 * at most. Any other answer is the answer.
 *
 * A request that may already have been processed is made again only when repeating it is safe: a
 * read, or a write that carries a request id, which the server answers once. A 429 was never
 * processed, so it is always made again.
 */

export const TRIES = 4;
export const FIRST = 1000;
export const LONGEST = 20_000;
export const HOLD = 60_000;

const PASSING = new Set([500, 502, 503, 504]);
const FAULTS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/** The wait a Retry-After header names, in ms: seconds or an HTTP date; 0 when absent or past. */
export function waitOf(value: string | null): number {
  const v = (value ?? '').trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(at - Date.now(), 0);
}

/** The wait after try number `n` (from 1): doubling to LONGEST, its lower half fixed and its upper half random. */
export function backoff(n: number): number {
  const d = Math.min(FIRST * 2 ** (n - 1), LONGEST);
  return d / 2 + Math.random() * (d / 2);
}

/** A failure of the connection that a second try may not have: a timeout, a reset, a refusal. */
export function passes(e: unknown): boolean {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  return err?.name === 'TimeoutError' || FAULTS.has(err?.code ?? '') || FAULTS.has(err?.cause?.code ?? '');
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** fetch, made again as above. `repeat` says whether a try that may have been processed is safe to repeat. */
export async function send(
  url: string,
  init: RequestInit,
  repeat: boolean,
  sleep: (ms: number) => Promise<void> = pause,
): Promise<Response> {
  for (let n = 1; ; n++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (!repeat || !passes(e) || n === TRIES) throw e;
      await sleep(backoff(n));
      continue;
    }
    const again = res.status === 429 || (repeat && PASSING.has(res.status));
    const named = res.status === 429 ? waitOf(res.headers.get('retry-after')) : 0;
    if (!again || n === TRIES || named > HOLD) return res;
    await res.arrayBuffer().catch(() => undefined);
    await sleep(named > 0 ? named : backoff(n));
  }
}
