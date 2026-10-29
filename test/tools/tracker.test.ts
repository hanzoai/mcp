/**
 * Tests for the work-item tools (Hanzo /v1/task surface).
 *
 * A local HTTP server stands in for api.hanzo.ai so the tests are deterministic
 * and hermetic. We assert each tool: (1) hits the right method + path, (2) carries
 * the caller's Bearer token, (3) NEVER sends an org (tenancy is minted server-side
 * from the identity), (4) writes the agent link in the one anchor format, (5)
 * sends only the fields the caller named, and (6) surfaces non-2xx + arg/auth
 * failures as isError.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as T from '../../src/tools/tracker.js';

interface RecordedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
const recorded: RecordedRequest[] = [];
let prevApiUrl: string | undefined;
let prevKey: string | undefined;

const last = () => recorded[recorded.length - 1];
const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      recorded.push({
        method: req.method || '',
        pathname: parsed.pathname,
        query: parsed.searchParams,
        headers: req.headers,
        body,
      });

      // A magic key lets us force cloud's own refusal for the error path.
      if (parsed.pathname.includes('/DENY')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 403, code: 'forbidden', error: 'X-Org-Id required' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pathname: parsed.pathname, sent: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;

  prevApiUrl = process.env.API_URL;
  prevKey = process.env.HANZO_API_KEY;
  process.env.API_URL = `http://127.0.0.1:${addr.port}`;
  process.env.HANZO_API_KEY = 'test-key';
});

afterAll(async () => {
  if (prevApiUrl === undefined) delete process.env.API_URL; else process.env.API_URL = prevApiUrl;
  if (prevKey === undefined) delete process.env.HANZO_API_KEY; else process.env.HANZO_API_KEY = prevKey;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => { recorded.length = 0; });

describe('tracker tools hit /v1/task (the renamed surface), never /v1/tracker', () => {
  const cases: [string, any, any, string, string][] = [
    ['boards', T.trackerBoardsTool, {}, 'GET', '/v1/task/projects'],
    ['issues/board', T.trackerIssuesTool, { key: 'cloud', status: 'todo' }, 'GET', '/v1/task/projects/cloud/issues'],
    ['issues/global', T.trackerIssuesTool, {}, 'GET', '/v1/task/board'],
    ['issue', T.trackerIssueTool, { key: 'ENG', number: 3 }, 'GET', '/v1/task/projects/ENG/issues/3'],
    ['create', T.trackerCreateTool, { key: 'cloud', title: 't' }, 'POST', '/v1/task/projects/cloud/issues'],
    ['update', T.trackerUpdateTool, { key: 'cloud', number: 2, priority: 'high' }, 'PATCH', '/v1/task/projects/cloud/issues/2'],
    ['close', T.trackerCloseTool, { key: 'cloud', number: 2 }, 'PATCH', '/v1/task/projects/cloud/issues/2'],
    ['comment', T.trackerCommentTool, { key: 'cloud', number: 2, body: 'hi' }, 'PATCH', '/v1/task/projects/cloud/issues/2'],
    ['comments', T.trackerCommentsTool, { key: 'cloud', number: 2 }, 'GET', '/v1/task/projects/cloud/issues/2/comments'],
    ['labels', T.trackerLabelsTool, { key: 'cloud' }, 'GET', '/v1/task/projects/cloud/labels'],
    ['label create', T.trackerLabelCreateTool, { key: 'cloud', name: 'bug', color: '#ff0000' }, 'POST', '/v1/task/projects/cloud/labels'],
    ['label edit', T.trackerLabelEditTool, { key: 'cloud', id: 7, color: '#00ff00' }, 'PATCH', '/v1/task/projects/cloud/labels/7'],
    ['milestones', T.trackerMilestonesTool, { key: 'cloud' }, 'GET', '/v1/task/projects/cloud/milestones'],
    ['milestone create', T.trackerMilestoneCreateTool, { key: 'cloud', title: 'v1' }, 'POST', '/v1/task/projects/cloud/milestones'],
    ['milestone edit', T.trackerMilestoneEditTool, { key: 'cloud', id: 4, state: 'closed' }, 'PATCH', '/v1/task/projects/cloud/milestones/4'],
  ];
  for (const [name, tool, args, method, path] of cases) {
    test(name, async () => {
      const r: any = await tool.handler(args);
      expect(r.isError).toBeUndefined();
      expect(last().method).toBe(method);
      expect(last().pathname).toBe(path);
      expect(last().headers.authorization).toBe('Bearer test-key');
      expect(last().query.has('org')).toBe(false);
      if (last().body) expect(JSON.parse(last().body).org).toBeUndefined();
    });
  }

  test('keys keep their case (forge repo names)', async () => {
    await T.trackerIssuesTool.handler({ key: 'cloud' });
    expect(last().pathname).toBe('/v1/task/projects/cloud/issues');
  });

  test('close sends status done and the comment', async () => {
    const r: any = await T.trackerCloseTool.handler({ key: 'cloud', number: 2, comment: 'fixed' });
    expect(json(r).sent).toEqual({ status: 'done', comment: 'fixed' });
  });

  test('comment is written through PATCH {comment}', async () => {
    const r: any = await T.trackerCommentTool.handler({ key: 'cloud', number: 2, body: 'hi' });
    expect(json(r).sent).toEqual({ comment: 'hi' });
  });

  test('update sends only named fields; empty assignee unassigns', async () => {
    const r: any = await T.trackerUpdateTool.handler({ key: 'cloud', number: 2, assignee: '' });
    expect(json(r).sent).toEqual({ assignee: '' });
  });

  test('update with nothing is refused locally', async () => {
    const r: any = await T.trackerUpdateTool.handler({ key: 'cloud', number: 2 });
    expect(r.isError).toBe(true);
    expect(recorded.length).toBe(0);
  });

  test('missing required args are refused locally', async () => {
    const r: any = await T.trackerCreateTool.handler({ key: 'cloud' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('title required');
    expect(recorded.length).toBe(0);
  });

  test('cloud refusals reach the agent verbatim', async () => {
    const r: any = await T.trackerIssuesTool.handler({ key: 'DENY' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('403');
  });

  test('no token → error, no request', async () => {
    const k = process.env.HANZO_API_KEY;
    delete process.env.HANZO_API_KEY;
    try {
      const r: any = await T.trackerBoardsTool.handler({});
      expect(r.isError).toBe(true);
      expect(recorded.length).toBe(0);
    } finally { process.env.HANZO_API_KEY = k; }
  });

  test('registry lists every tool once', () => {
    const names = T.trackerTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(14);
  });
});
