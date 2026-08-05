/**
 * Tests for the work-item tools (Hanzo /v1/tracker surface).
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
import {
  trackerBoardsTool,
  trackerIssuesTool,
  trackerCreateTool,
  trackerUpdateTool,
  trackerTools,
} from '../../src/tools/tracker.js';

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

describe('the tracker tool surface', () => {
  test('is four tools, each uniquely named', () => {
    const names = trackerTools.map((t) => t.name);
    expect(names).toEqual(['tracker_boards', 'tracker_issues', 'tracker_create', 'tracker_update']);
    expect(new Set(names).size).toBe(names.length);
  });

  test('does not collide with the LOCAL `tasks` todo tool', () => {
    // `tasks` is a private file on disk; these are the shared board. Two planes,
    // two names — the day they collide is the day an agent reports progress into
    // a file nobody reads.
    expect(trackerTools.map((t) => t.name)).not.toContain('tasks');
  });
});

describe('tracker_boards', () => {
  test('GET /v1/tracker/projects with the bearer and no org', async () => {
    const result = await trackerBoardsTool.handler({});
    expect(result.isError).toBeFalsy();

    const req = last();
    expect(req.method).toBe('GET');
    expect(req.pathname).toBe('/v1/tracker/projects');
    expect(req.headers['authorization']).toBe('Bearer test-key');
    // Tenancy is minted from the identity; a tool that sends an org is a tool
    // asking to be trusted about tenancy.
    expect([...req.query.keys()]).not.toContain('org');
  });
});

describe('tracker_issues', () => {
  test('GET one board, uppercasing the key as cloud stores it', async () => {
    await trackerIssuesTool.handler({ key: 'eng' });
    expect(last().pathname).toBe('/v1/tracker/projects/ENG/issues');
  });

  test('carries every filter, and only the ones given', async () => {
    await trackerIssuesTool.handler({ key: 'ENG', status: 'in_progress', source: 'agent' });
    const req = last();
    expect(req.query.get('status')).toBe('in_progress');
    expect(req.query.get('source')).toBe('agent');
    expect(req.query.get('kind')).toBeNull();
    expect(req.query.get('repo')).toBeNull();
  });

  test('missing key fails before any network call', async () => {
    const result = await trackerIssuesTool.handler({});
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});

describe('tracker_create', () => {
  test('POSTs the issue and defaults source to agent', async () => {
    const result = await trackerCreateTool.handler({ key: 'ENG', title: 'ship the board' });
    expect(result.isError).toBeFalsy();

    const req = last();
    expect(req.method).toBe('POST');
    expect(req.pathname).toBe('/v1/tracker/projects/ENG/issues');
    // The board's "an agent's work" filter is only true if agents say so.
    expect(JSON.parse(req.body)).toEqual({ title: 'ship the board', source: 'agent' });
  });

  test('writes an agent session as the one anchor format', async () => {
    await trackerCreateTool.handler({ key: 'ENG', title: 'x', session: 'sess_123' });
    expect(JSON.parse(last().body).extRef).toBe('session:sess_123');
  });

  test('a raw extRef still passes through for a non-session anchor', async () => {
    await trackerCreateTool.handler({ key: 'ENG', title: 'x', extRef: 'feat/branch' });
    expect(JSON.parse(last().body).extRef).toBe('feat/branch');
  });

  test('sends no field the caller did not name', async () => {
    await trackerCreateTool.handler({ key: 'ENG', title: 'x', source: 'team' });
    // An undefined priority must not become a null that overwrites cloud's default.
    expect(JSON.parse(last().body)).toEqual({ title: 'x', source: 'team' });
  });

  test('missing title fails before any network call', async () => {
    const result = await trackerCreateTool.handler({ key: 'ENG' });
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});

describe('tracker_update', () => {
  test('PATCHes one issue by board key and number', async () => {
    const result = await trackerUpdateTool.handler({ key: 'ENG', number: 14, status: 'done' });
    expect(result.isError).toBeFalsy();

    const req = last();
    expect(req.method).toBe('PATCH');
    expect(req.pathname).toBe('/v1/tracker/projects/ENG/issues/14');
    expect(JSON.parse(req.body)).toEqual({ status: 'done' });
  });

  test('relinks a session without touching anything else', async () => {
    await trackerUpdateTool.handler({ key: 'ENG', number: 1, session: 'sess_9' });
    expect(JSON.parse(last().body)).toEqual({ extRef: 'session:sess_9' });
  });

  test('number 0 is a number, not a missing argument', async () => {
    // `if (!args.number)` would refuse this; cloud refuses it too, but for the
    // right reason and with its own message.
    await trackerUpdateTool.handler({ key: 'ENG', number: 0, status: 'todo' });
    expect(last().pathname).toBe('/v1/tracker/projects/ENG/issues/0');
  });

  test('an empty patch is refused rather than sent as a no-op write', async () => {
    const result = await trackerUpdateTool.handler({ key: 'ENG', number: 3 });
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});

describe('failures surface honestly', () => {
  test("cloud's own refusal reaches the agent verbatim", async () => {
    const result = await trackerIssuesTool.handler({ key: 'DENY' });
    expect(result.isError).toBe(true);
    // Not "request failed" — the sentence cloud actually said.
    expect(result.content[0].text).toContain('403');
    expect(result.content[0].text).toContain('X-Org-Id required');
  });

  test('missing token fails with a clear error and no call', async () => {
    const prev = process.env.HANZO_API_KEY;
    delete process.env.HANZO_API_KEY;
    try {
      const result = await trackerBoardsTool.handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('HANZO_API_KEY required');
      expect(recorded).toHaveLength(0);
    } finally {
      process.env.HANZO_API_KEY = prev;
    }
  });
});

describe('the body comes back to the agent', () => {
  test('a successful call returns the parsed JSON', async () => {
    const result = await trackerBoardsTool.handler({});
    expect(json(result as { content: { text: string }[] }).pathname).toBe('/v1/tracker/projects');
  });
});
