/**
 * Tests for the unified `fetch` tool (HIP-0300).
 *
 * Covers the standard 200 path plus the new x402 (HTTP 402 Payment Required)
 * surfacing — the calling agent should receive a structured `payment_required`
 * envelope on 402, and supplying a `payment` argument should re-issue the
 * request with the `X-PAYMENT` header.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import * as http from 'http';
import { AddressInfo } from 'net';
import { fetchTool } from '../../../src/tools/unified/fetch.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let baseUrl: string;
const recorded: RecordedRequest[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      recorded.push({
        method: req.method || '',
        url: req.url || '',
        headers: req.headers,
        body,
      });

      // /paid — gates on X-PAYMENT, otherwise 402 with x402 envelope.
      if (req.url?.startsWith('/paid')) {
        if (req.headers['x-payment']) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, paid: true }));
          return;
        }
        const envelope = {
          x402Version: 1,
          accepts: [{
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '1000',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x0000000000000000000000000000000000000001',
            resource: 'https://example.test/paid',
            description: 'kcolbchain test resource',
            mimeType: 'application/json',
          }],
        };
        res.writeHead(402, {
          'content-type': 'application/json',
          'x402-version': '1',
          'www-authenticate': 'x402',
        });
        res.end(JSON.stringify(envelope));
        return;
      }

      // /ok — plain 200 JSON.
      if (req.url?.startsWith('/ok')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function parseResult(result: any) {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text);
}

describe('fetchTool', () => {
  test('has expected metadata', () => {
    expect(fetchTool.name).toBe('fetch');
    expect(fetchTool.inputSchema.required).toContain('action');
  });

  test('request returns body for 200 JSON', async () => {
    const result = await fetchTool.handler({ action: 'request', url: `${baseUrl}/ok` });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe(200);
    expect(parsed.data.body).toEqual({ hello: 'world' });
  });

  test('head returns headers for 200', async () => {
    const result = await fetchTool.handler({ action: 'head', url: `${baseUrl}/ok` });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe(200);
  });

  test('request surfaces x402 payment_required envelope on 402', async () => {
    const result = await fetchTool.handler({ action: 'request', url: `${baseUrl}/paid` });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe(402);
    expect(parsed.data.payment_required).toBeDefined();
    expect(parsed.data.payment_required.x402_version).toBe('1');
    expect(parsed.data.payment_required.www_authenticate).toBe('x402');
    expect(parsed.data.payment_required.accepts).toHaveLength(1);
    expect(parsed.data.payment_required.accepts[0].network).toBe('base-sepolia');
  });

  test('fetch surfaces x402 payment_required envelope on 402', async () => {
    const result = await fetchTool.handler({ action: 'fetch', url: `${baseUrl}/paid` });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe(402);
    expect(parsed.data.payment_required.accepts[0].asset)
      .toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  test('payment object is base64-encoded into X-PAYMENT and unlocks the resource', async () => {
    const before = recorded.length;
    const payment = { scheme: 'exact', network: 'base-sepolia', signature: '0xdeadbeef' };
    const result = await fetchTool.handler({
      action: 'request',
      url: `${baseUrl}/paid`,
      payment,
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe(200);
    expect(parsed.data.body).toEqual({ ok: true, paid: true });

    const last = recorded[recorded.length - 1];
    const sent = last.headers['x-payment'] as string | undefined;
    expect(sent).toBeDefined();
    const decoded = JSON.parse(Buffer.from(sent!, 'base64').toString('utf8'));
    expect(decoded).toEqual(payment);
    expect(recorded.length).toBeGreaterThan(before);
  });

  test('payment string is forwarded verbatim as X-PAYMENT', async () => {
    const presigned = 'eyJzaWduYXR1cmUiOiJ0ZXN0In0=';
    const result = await fetchTool.handler({
      action: 'request',
      url: `${baseUrl}/paid`,
      payment: presigned,
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe(200);
    const last = recorded[recorded.length - 1];
    expect(last.headers['x-payment']).toBe(presigned);
  });
});
