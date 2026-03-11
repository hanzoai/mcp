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
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'request': {
          const opts: RequestInit = {
            method: args.method || 'GET',
            headers: args.headers || {},
            signal: AbortSignal.timeout(args.timeout || 30000),
          };
          if (args.body) opts.body = args.body;
          const resp = await fetch(args.url, opts);
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
            headers: args.headers || {},
            signal: AbortSignal.timeout(args.timeout || 30000),
          };
          if (args.body) opts.body = args.body;
          const resp = await fetch(args.url, opts);
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
            headers: args.headers || {},
            signal: AbortSignal.timeout(args.timeout || 30000),
          });
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
          // Use DuckDuckGo HTML search (no API key needed)
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
          const searchResp = await fetch(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HanzoBot/1.0)' },
            signal: AbortSignal.timeout(args.timeout || 15000),
          });
          const searchHtml = await searchResp.text();
          // Extract results with regex (no DOM parser in Node by default)
          const resultRe = /class="result__title"[^>]*>[\s\S]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\//g;
          const results: any[] = [];
          let match;
          const maxResults = args.limit || 10;
          while ((match = resultRe.exec(searchHtml)) !== null && results.length < maxResults) {
            results.push({
              url: match[1].replace(/&amp;/g, '&'),
              title: match[2].replace(/<[^>]+>/g, '').trim(),
              snippet: match[3].replace(/<[^>]+>/g, '').trim(),
            });
          }
          return envelope({ query: args.query, results, count: results.length }, 'search');
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
