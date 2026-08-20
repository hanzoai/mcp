/**
 * fetch — Unified network tool (HIP-0300)
 *
 * One tool for the HTTP/API axis.
 * Actions: request, download, open
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../types/index.js';

const execAsync = promisify(exec);

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'fetch', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'fetch' } }, null, 2) }], isError: true };
}

/**
 * Parse an HTTP 402 response into the x402 payment-required envelope.
 * Best-effort: surfaces whatever the server returned (JSON `accepts` array
 * per x402.org spec, or raw `WWW-Authenticate`/`X-Accept-Payment` headers
 * for older variants) so the calling agent can decide how to fund the call.
 */
async function parsePaymentRequired(resp: Response) {
  const headers = Object.fromEntries(resp.headers.entries());
  let body: any = null;
  try {
    const ct = resp.headers.get('content-type') || '';
    body = ct.includes('json') ? await resp.json() : await resp.text();
  } catch {
    body = null;
  }
  const accepts = body && typeof body === 'object' && Array.isArray(body.accepts)
    ? body.accepts
    : null;
  return {
    status: 402,
    payment_required: {
      x402_version: headers['x402-version'] || (body && body.x402Version) || null,
      accepts,
      www_authenticate: headers['www-authenticate'] || null,
      raw_body: accepts ? null : body,
    },
    headers,
  };
}

function paymentHeader(payment: any): Record<string, string> {
  if (!payment) return {};
  // x402 spec uses base64-encoded JSON in the X-PAYMENT header. Accept either
  // a pre-encoded string (`payment` is a string) or a JSON object we encode.
  if (typeof payment === 'string') return { 'X-PAYMENT': payment };
  if (typeof payment === 'object') {
    return { 'X-PAYMENT': Buffer.from(JSON.stringify(payment), 'utf8').toString('base64') };
  }
  return {};
}

export const fetchTool: Tool = {
  name: 'fetch',
  description: 'Network operations: request, fetch, head, download, open, search, crawl',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['request', 'fetch', 'head', 'download', 'open', 'search', 'crawl'], description: 'Network action' },
      url: { type: 'string', description: 'URL' },
      method: { type: 'string', description: 'HTTP method', default: 'GET' },
      headers: { type: 'object', description: 'HTTP headers' },
      body: { type: 'string', description: 'Request body' },
      output: { type: 'string', description: 'Output file for download' },
      timeout: { type: 'number', default: 30000 },
      query: { type: 'string', description: 'Search query' },
      depth: { type: 'number', description: 'Crawl depth', default: 2 },
      limit: { type: 'number', description: 'Max results/pages', default: 10 },
      payment: { description: 'x402 payment payload — base64 string sent as-is via X-PAYMENT, or a JSON object that will be base64-encoded' },
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'request': {
          const opts: RequestInit = {
            method: args.method || 'GET',
            headers: { ...(args.headers || {}), ...paymentHeader(args.payment) },
            signal: AbortSignal.timeout(args.timeout || 30000),
          };
          if (args.body) opts.body = args.body;
          const resp = await fetch(args.url, opts);
          if (resp.status === 402) {
            return envelope(await parsePaymentRequired(resp), 'request');
          }
          const contentType = resp.headers.get('content-type') || '';
          let data: any;
          if (contentType.includes('json')) {
            data = await resp.json();
          } else {
            data = await resp.text();
          }
          return envelope({
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            body: typeof data === 'string' ? data.substring(0, 50000) : data,
          }, 'request');
        }

        case 'fetch': {
          const opts: RequestInit = {
            method: args.method || 'GET',
            headers: { ...(args.headers || {}), ...paymentHeader(args.payment) },
            signal: AbortSignal.timeout(args.timeout || 30000),
          };
          if (args.body) opts.body = args.body;
          const resp = await fetch(args.url, opts);
          if (resp.status === 402) {
            return envelope(await parsePaymentRequired(resp), 'fetch');
          }
          const contentType = resp.headers.get('content-type') || '';
          let data: any;
          if (contentType.includes('json')) {
            data = await resp.json();
          } else {
            data = await resp.text();
          }
          return envelope({
            text: typeof data === 'string' ? data.substring(0, 50000) : JSON.stringify(data),
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
          }, 'fetch');
        }

        case 'head': {
          const resp = await fetch(args.url, {
            method: 'HEAD',
            headers: { ...(args.headers || {}), ...paymentHeader(args.payment) },
            signal: AbortSignal.timeout(args.timeout || 30000),
          });
          if (resp.status === 402) {
            return envelope(await parsePaymentRequired(resp), 'head');
          }
          return envelope({
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
          }, 'head');
        }

        case 'download': {
          if (!args.output) return fail('INVALID_PARAMS', 'output path required');
          const resp = await fetch(args.url, { signal: AbortSignal.timeout(args.timeout || 60000) });
          if (!resp.ok) return fail('HTTP_ERROR', `${resp.status} ${resp.statusText}`);
          const buffer = Buffer.from(await resp.arrayBuffer());
          await fs.mkdir(path.dirname(args.output), { recursive: true });
          await fs.writeFile(args.output, buffer);
          return envelope({ url: args.url, output: args.output, size: buffer.length, status: resp.status }, 'download');
        }

        case 'open': {
          const platform = process.platform;
          const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
          await execAsync(`${cmd} "${args.url}"`);
          return envelope({ url: args.url, opened: true }, 'open');
        }

        case 'search': {
          if (!args.query) return fail('INVALID_PARAMS', 'query required');
          /**
           * OUR OWN SEARCH, not a scrape of somebody else's results page.
           *
           * This used to GET html.duckduckgo.com and pull results out with a
           * regex over `class="result__title"`. Measured 2026-08-20, that
           * returns HTTP 202 — DuckDuckGo's anti-bot challenge — and the markup
           * carries no `result__title` at all, so the regex matched nothing and
           * the tool answered `{results: [], count: 0}`: BLIND rendered as
           * EMPTY, for every query, with no way for a caller to tell the two
           * apart. A scraper of a third party's HTML is one class rename away
           * from that on any day, which is the argument for our own endpoint
           * rather than a better regex.
           *
           * Hanzo Cloud serves this at POST /v1/websearch — the same meta-search
           * the product uses — so the tool now asks the API we ship. Credential
           * and base URL come from the same env the tracker tool reads, so the
           * MCP has ONE way to reach cloud rather than a second one here.
           */
          const base = process.env.API_URL || 'https://api.hanzo.ai';
          const key =
            process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || '';
          // Refuse LOUDLY without a credential. Returning an empty result list
          // here would reproduce the exact defect this replaced: the caller
          // cannot distinguish "the web has nothing" from "we never asked".
          if (!key) {
            return fail(
              'NO_CREDENTIAL',
              'web search needs a Hanzo API key: set HANZO_API_KEY (pk- or sk-). Cloud refuses anonymous search.',
            );
          }
          const searchResp = await fetch(`${base}/v1/websearch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({ q: args.query }),
            signal: AbortSignal.timeout(args.timeout || 15000),
          });
          const searchText = await searchResp.text();
          if (!searchResp.ok) {
            // Cloud's own words reach the agent verbatim — "sign in to search the
            // web" is a different problem from a 500, and flattening both into
            // "search failed" is what makes an outage look like a bad query.
            return fail('SEARCH_FAILED', `${searchResp.status}: ${searchText.substring(0, 200)}`);
          }
          let payload: any;
          try {
            payload = JSON.parse(searchText);
          } catch {
            return fail('SEARCH_FAILED', `unreadable response from ${base}/v1/websearch`);
          }
          const maxResults = args.limit || 10;
          const results = (Array.isArray(payload?.results) ? payload.results : [])
            .slice(0, maxResults)
            .map((r: any) => ({ url: r?.url ?? '', title: r?.title ?? '', snippet: r?.content ?? r?.snippet ?? '' }));
          return envelope(
            {
              query: payload?.query ?? args.query,
              results,
              count: results.length,
              // Which engines answered. A zero-result search with engines listed
              // is a real empty; one with none is a search that did not happen.
              engines: Array.isArray(payload?.engines) ? payload.engines : [],
              total: payload?.number_of_results ?? null,
            },
            'search',
          );
        }

        case 'crawl': {
          if (!args.url) return fail('INVALID_PARAMS', 'url required');
          if (!args.output) return fail('INVALID_PARAMS', 'output directory required');
          const maxDepth = args.depth || 2;
          const maxPages = args.limit || 100;
          const startUrl = new URL(args.url);
          const visited = new Set<string>();
          const pages: string[] = [];
          const queue: Array<{ url: string; depth: number }> = [{ url: args.url, depth: 0 }];

          await fs.mkdir(args.output, { recursive: true });

          while (queue.length > 0 && pages.length < maxPages) {
            const item = queue.shift()!;
            if (visited.has(item.url) || item.depth > maxDepth) continue;
            try {
              const pageUrl = new URL(item.url);
              if (pageUrl.hostname !== startUrl.hostname) continue;
            } catch { continue; }
            visited.add(item.url);

            try {
              const resp = await fetch(item.url, { signal: AbortSignal.timeout(10000) });
              const body = await resp.text();
              const parsed = new URL(item.url);
              let filePath = parsed.pathname.replace(/\/$/, '/index.html');
              if (!path.extname(filePath)) filePath += '.html';
              const fullPath = path.join(args.output, filePath);
              await fs.mkdir(path.dirname(fullPath), { recursive: true });
              await fs.writeFile(fullPath, body);
              pages.push(fullPath);

              // Extract links
              if (resp.headers.get('content-type')?.includes('html')) {
                const linkRe = /href=["']([^"']+)["']/g;
                let lm;
                while ((lm = linkRe.exec(body)) !== null) {
                  try {
                    const absUrl = new URL(lm[1], item.url).href;
                    if (!visited.has(absUrl)) {
                      queue.push({ url: absUrl, depth: item.depth + 1 });
                    }
                  } catch {}
                }
              }
            } catch {}
          }

          return envelope({ pages, count: pages.length, dest: args.output, depth: maxDepth }, 'crawl');
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
