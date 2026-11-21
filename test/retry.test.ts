/**
 * What a call to the cloud does when the cloud is busy or failing: it waits and tries again, as the
 * server said or by a doubling wait, four times at most; a refusal is never made again; a write is
 * made again after a failure only when it carries a request id.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { send, waitOf, backoff, TRIES, FIRST, LONGEST, HOLD } from '../src/tools/retry.js';

type Reply = { status?: number; headers?: Record<string, string>; body?: unknown; drop?: boolean };

let server: http.Server;
let url: string;
let replies: Reply[];
let seen: { method?: string; body: string }[];

beforeEach(async () => {
  replies = [];
  seen = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, body });
      const r = replies[Math.min(seen.length - 1, replies.length - 1)];
      if (r.drop) return req.socket.destroy();
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/mcp`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const waits = () => {
  const made: number[] = [];
  return { made, sleep: async (ms: number) => void made.push(ms) };
};
const post = { method: 'POST', body: '{"id":1}' };

describe('a 429', () => {
  it('waits the Retry-After in seconds, then succeeds', async () => {
    replies = [{ status: 429, headers: { 'Retry-After': '7' } }, { status: 200 }];
    const w = waits();
    const res = await send(url, post, false, w.sleep);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(w.made).toEqual([7000]);
  });

  it('waits until a Retry-After HTTP date', async () => {
    replies = [{ status: 429, headers: { 'Retry-After': new Date(Date.now() + 9000).toUTCString() } }, { status: 200 }];
    const w = waits();
    expect((await send(url, post, false, w.sleep)).status).toBe(200);
    expect(w.made).toHaveLength(1);
    expect(w.made[0]).toBeGreaterThan(7000);
    expect(w.made[0]).toBeLessThanOrEqual(9000);
  });

  it('backs off with jitter when the server names no wait', async () => {
    replies = [{ status: 429 }, { status: 429 }, { status: 200 }];
    const w = waits();
    expect((await send(url, post, false, w.sleep)).status).toBe(200);
    expect(w.made).toHaveLength(2);
    w.made.forEach((ms, i) => {
      const ceil = Math.min(FIRST * 2 ** i, LONGEST);
      expect(ms).toBeGreaterThanOrEqual(ceil / 2);
      expect(ms).toBeLessThanOrEqual(ceil);
    });
  });

  it('is answered as it was when the wait it names is past the hold', async () => {
    replies = [{ status: 429, headers: { 'Retry-After': String(HOLD / 1000 + 1) } }, { status: 200 }];
    const w = waits();
    expect((await send(url, post, false, w.sleep)).status).toBe(429);
    expect(seen).toHaveLength(1);
    expect(w.made).toEqual([]);
  });

  it('is made again even for a write with no request id: it was never processed', async () => {
    replies = [{ status: 429 }, { status: 200 }];
    expect((await send(url, post, false, waits().sleep)).status).toBe(200);
  });
});

describe('a failure that passes', () => {
  it.each([500, 502, 503, 504])('a %i that later succeeds is made again', async (status) => {
    replies = [{ status }, { status: 200 }];
    const w = waits();
    expect((await send(url, post, true, w.sleep)).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(w.made).toHaveLength(1);
  });

  it('a dropped connection is made again', async () => {
    replies = [{ drop: true }, { status: 200 }];
    expect((await send(url, post, true, waits().sleep)).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('a refused connection is made again, and then thrown', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const w = waits();
    await expect(send(url, post, true, w.sleep)).rejects.toThrow();
    expect(w.made).toHaveLength(TRIES - 1);
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  it('is made TRIES times at most, and the last answer is returned', async () => {
    replies = [{ status: 503 }];
    const w = waits();
    expect((await send(url, post, true, w.sleep)).status).toBe(503);
    expect(seen).toHaveLength(TRIES);
    expect(w.made).toHaveLength(TRIES - 1);
  });

  it('is not made again for a write that carries no request id', async () => {
    replies = [{ status: 503 }, { status: 200 }];
    const w = waits();
    expect((await send(url, post, false, w.sleep)).status).toBe(503);
    expect(seen).toHaveLength(1);
    expect(w.made).toEqual([]);
  });
});

describe('a refusal', () => {
  it.each([400, 401, 403, 404, 409, 422])('a %i is never made again', async (status) => {
    replies = [{ status }, { status: 200 }];
    const w = waits();
    expect((await send(url, post, true, w.sleep)).status).toBe(status);
    expect(seen).toHaveLength(1);
    expect(w.made).toEqual([]);
  });
});

describe('the parts', () => {
  it('reads a Retry-After', () => {
    expect(waitOf(null)).toBe(0);
    expect(waitOf('5')).toBe(5000);
    expect(waitOf('soon')).toBe(0);
    expect(waitOf(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it('doubles to its ceiling with the lower half fixed', () => {
    for (let n = 1; n <= 8; n++) {
      const ceil = Math.min(FIRST * 2 ** (n - 1), LONGEST);
      for (let i = 0; i < 50; i++) {
        const ms = backoff(n);
        expect(ms).toBeGreaterThanOrEqual(ceil / 2);
        expect(ms).toBeLessThanOrEqual(ceil);
      }
    }
  });
});
