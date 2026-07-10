/**
 * Tests for the code-intelligence tools (Hanzo /v1/code/* surface).
 *
 * A local HTTP server stands in for api.hanzo.ai so the tests are deterministic
 * and hermetic. We assert each tool: (1) hits the right method + path, (2) carries
 * the caller's Bearer token, (3) requests markdown (?format=md), (4) never leaks an
 * org param, (5) returns the markdown body, and (6) surfaces non-2xx + arg/auth
 * failures as isError.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  codeSearchTool,
  codeContextTool,
  codeAskTool,
  codeIndexTool,
  codeIntelTools,
} from '../../src/tools/code-intel.js';

interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
const recorded: RecordedRequest[] = [];
let prevApiUrl: string | undefined;
let prevKey: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      recorded.push({
        method: req.method || '',
        url: req.url || '',
        pathname: parsed.pathname,
        query: parsed.searchParams,
        headers: req.headers,
        body,
      });

      // A magic query lets us force a 403 (principal gate) for the error path.
      const q = parsed.searchParams.get('q');
      const bodyQuery = body ? (() => { try { return JSON.parse(body).query; } catch { return undefined; } })() : undefined;
      if (q === 'DENY' || bodyQuery === 'DENY') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'valid principal required' }));
        return;
      }

      // Echo a markdown table (what the code surface returns for ?format=md).
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(`| endpoint | ${parsed.pathname} |\n| --- | --- |\n`);
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
  process.env.API_URL = prevApiUrl;
  process.env.HANZO_API_KEY = prevKey;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const last = () => recorded[recorded.length - 1];

describe('code-intelligence tools', () => {
  test('exports exactly the four endpoints', () => {
    expect(codeIntelTools.map((t) => t.name)).toEqual([
      'code_search', 'code_context', 'code_ask', 'code_index',
    ]);
  });

  test('metadata: names and required inputs', () => {
    expect(codeSearchTool.inputSchema.required).toEqual(['q']);
    expect(codeContextTool.inputSchema.required).toEqual(['query']);
    expect(codeAskTool.inputSchema.required).toEqual(['q']);
    expect(codeIndexTool.inputSchema.required).toEqual(['repo', 'files']);
  });

  test('code_search: GET /v1/code/search with query, markdown, Bearer', async () => {
    const result = await codeSearchTool.handler({ q: 'round signer', type: 'hybrid', repo: 'lux/consensus', limit: 5 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('/v1/code/search');

    const req = last();
    expect(req.method).toBe('GET');
    expect(req.pathname).toBe('/v1/code/search');
    expect(req.query.get('q')).toBe('round signer');
    expect(req.query.get('type')).toBe('hybrid');
    expect(req.query.get('repo')).toBe('lux/consensus');
    expect(req.query.get('limit')).toBe('5');
    expect(req.query.get('format')).toBe('md');
    expect(req.headers['authorization']).toBe('Bearer test-key');
    expect(req.headers['accept']).toBe('text/markdown');
  });

  test('code_search: never sends an org param', async () => {
    await codeSearchTool.handler({ q: 'anything', owner: 'evil-org', org: 'evil-org', organization: 'evil-org' });
    const req = last();
    expect(req.query.get('owner')).toBeNull();
    expect(req.query.get('org')).toBeNull();
    expect(req.query.get('organization')).toBeNull();
  });

  test('code_context: POST /v1/code/context with JSON body', async () => {
    const result = await codeContextTool.handler({ query: 'how does auth work', repo: 'hanzo/iam', budgetTokens: 8000 });
    expect(result.isError).toBeFalsy();

    const req = last();
    expect(req.method).toBe('POST');
    expect(req.pathname).toBe('/v1/code/context');
    expect(req.query.get('format')).toBe('md');
    expect(JSON.parse(req.body)).toEqual({ query: 'how does auth work', repo: 'hanzo/iam', budgetTokens: 8000 });
    expect(req.headers['authorization']).toBe('Bearer test-key');
  });

  test('code_ask: GET /v1/code/ask', async () => {
    const result = await codeAskTool.handler({ q: 'where is the principal gate', repo: 'hanzo/cloud' });
    expect(result.isError).toBeFalsy();

    const req = last();
    expect(req.method).toBe('GET');
    expect(req.pathname).toBe('/v1/code/ask');
    expect(req.query.get('q')).toBe('where is the principal gate');
    expect(req.query.get('repo')).toBe('hanzo/cloud');
    expect(req.query.get('format')).toBe('md');
  });

  test('code_index: POST /v1/code/index with files', async () => {
    const files = [{ path: 'main.go', content: 'package main' }];
    const result = await codeIndexTool.handler({ repo: 'hanzo/x', files, prune: true });
    expect(result.isError).toBeFalsy();

    const req = last();
    expect(req.method).toBe('POST');
    expect(req.pathname).toBe('/v1/code/index');
    expect(JSON.parse(req.body)).toEqual({ repo: 'hanzo/x', files, prune: true });
  });

  test('non-2xx surfaces as isError with the status', async () => {
    const result = await codeSearchTool.handler({ q: 'DENY' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('403');
  });

  test('missing required arg fails before any network call', async () => {
    const before = recorded.length;
    const result = await codeSearchTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('q required');
    expect(recorded.length).toBe(before);
  });

  test('missing token fails with a clear error', async () => {
    const saved = process.env.HANZO_API_KEY;
    delete process.env.HANZO_API_KEY;
    try {
      const before = recorded.length;
      const result = await codeAskTool.handler({ q: 'anything' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('HANZO_API_KEY required');
      expect(recorded.length).toBe(before);
    } finally {
      process.env.HANZO_API_KEY = saved;
    }
  });
});
