/**
 * A coding run started through the cloud tools carries a request id that every try carries too, and
 * a read is made again after a failure. The id is what lets the cloud answer a retry the run the
 * first try started.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let server: http.Server;
let calls: { op: string; input: any }[] = [];
let failures = 0;
let cloudTools: any[];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { params } = JSON.parse(body);
      calls.push({ op: params.arguments.op, input: params.arguments.input });
      if (failures > 0) {
        failures--;
        res.writeHead(503).end('busy');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.HANZO_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HANZO_API_KEY = 'test-key';
  ({ cloudTools } = await import('../src/tools/cloud.js'));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const tool = (name: string) => cloudTools.find((t: any) => t.name === name);

describe('starting a run', () => {
  it('names it with a request id, the same on every try, and starts it after a failure', async () => {
    calls = [];
    failures = 1;
    const res = await tool('agent').handler({ op: 'post_agent_coding', input: { repo: 'cloud', prompt: 'fix it' } });
    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(typeof calls[0].input.requestId).toBe('string');
    expect(calls[1].input.requestId).toBe(calls[0].input.requestId);
    expect(calls[0].input.repo).toBe('cloud');
  }, 30_000);

  it('keeps the request id a caller gave', async () => {
    calls = [];
    failures = 0;
    await tool('agent').handler({ op: 'post_agent_coding', input: { prompt: 'x', requestId: 'mine-1' } });
    expect(calls[0].input.requestId).toBe('mine-1');
  });

  it('is not made again after a failure when it is another write', async () => {
    calls = [];
    failures = 1;
    const res = await tool('agent').handler({ op: 'post_agent_coding_by_session_steer', input: { session: 's', text: 'go' } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('watching a run', () => {
  it('is made again after a failure', async () => {
    calls = [];
    failures = 1;
    const res = await tool('agent').handler({ op: 'get_agent_coding_by_session_changes', input: { session: 's' } });
    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
  }, 30_000);
});
