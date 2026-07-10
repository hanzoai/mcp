/**
 * Code intelligence — the Hanzo Cloud /v1/code/* surface as MCP tools.
 *
 * A per-org, principal-gated code-intelligence engine (hybrid retrieval: lexical
 * + symbolic + semantic, reciprocal-rank fused). One tool per endpoint:
 *
 *   code_search  GET  /v1/code/search   ?q=&type=text|regex|symbol|semantic|hybrid&repo=&limit=
 *   code_context POST /v1/code/context  {query,budgetTokens,repo}  → budget-packed bundle (the agent primitive)
 *   code_ask     GET  /v1/code/ask      ?q=&repo=                   → cited RAG answer
 *   code_index   POST /v1/code/index    {repo,files:[{path,content}],prune}  → (re)index a corpus
 *
 * Auth mirrors hanzo-cloud.ts EXACTLY: the caller's Hanzo bearer/API key from the
 * environment. The org is minted server-side from that identity (principal gate)
 * — a client NEVER passes an org. Output is requested as markdown (?format=md):
 * the code surface re-serializes its JSON as a token-thrifty table for the LLM.
 */

import { Tool } from '../types/index.js';

// Resolved at call time (like token()) so the endpoint is overridable for tests
// and self-hosted gateways without a rebuild.
function apiBase(): string { return process.env.API_URL || 'https://api.hanzo.ai'; }
function token(): string { return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || ''; }

// code() is the ONE request path: Bearer auth + markdown negotiation. It always
// asks for markdown (?format=md AND Accept), so a successful body is the agent-
// ready table; a non-2xx throws `${status}: ${body}` exactly as hanzo-cloud's api().
async function code(path: string, opts: RequestInit = {}): Promise<string> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const url = `${apiBase()}${path}${path.includes('?') ? '&' : '?'}format=md`;
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'Accept': 'text/markdown', 'Authorization': `Bearer ${t}`, ...(opts.headers || {}) } });
  if (!r.ok) { const b = await r.text().catch(() => ''); throw new Error(`${r.status}: ${b.substring(0, 200)}`); }
  return (await r.text()).trim();
}

function ok(t: string) { return { content: [{ type: 'text' as const, text: t }] }; }
function fail(m: string) { return { content: [{ type: 'text' as const, text: `Error: ${m}` }], isError: true as const }; }

// qs builds a query string, dropping undefined/empty values.
function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// =============================================
// code_search — ranked hybrid search over the org's indexed code
// =============================================

export const codeSearchTool: Tool = {
  name: 'code_search',
  description: 'Search your org\'s indexed code (Hanzo code intelligence). Hybrid retrieval — lexical + symbolic + semantic fused. Returns ranked spans {repo,file,line,endLine,kind,symbol,snippet,score,tier}. type defaults to hybrid.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Search query — natural language or a code fragment' },
      type: { type: 'string', enum: ['text', 'regex', 'symbol', 'semantic', 'hybrid'], description: 'Retrieval strategy (default hybrid)' },
      repo: { type: 'string', description: 'Restrict to a repo label (optional)' },
      limit: { type: 'number', description: 'Max results (default 20, max 100)' },
    },
    required: ['q'],
  },
  handler: async (args) => {
    try {
      if (!args.q) return fail('q required');
      return ok(await code(`/v1/code/search${qs({ q: args.q, type: args.type, repo: args.repo, limit: args.limit })}`));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

// =============================================
// code_context — THE agent primitive: a budget-packed context bundle
// =============================================

export const codeContextTool: Tool = {
  name: 'code_context',
  description: 'Pack a budget-bounded context bundle for a task from your org\'s indexed code — THE agent primitive. Fuses the top spans and truncates to fit budgetTokens (default 4000, range 256–32000).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you need context for' },
      repo: { type: 'string', description: 'Restrict to a repo label (optional)' },
      budgetTokens: { type: 'number', description: 'Token budget for the bundle (default 4000, 256–32000)' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    try {
      if (!args.query) return fail('query required');
      return ok(await code('/v1/code/context', { method: 'POST', body: JSON.stringify({ query: args.query, repo: args.repo, budgetTokens: args.budgetTokens }) }));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

// =============================================
// code_ask — cited RAG answer grounded in the org's index
// =============================================

export const codeAskTool: Tool = {
  name: 'code_ask',
  description: 'Ask a natural-language question about your org\'s codebase and get a cited RAG answer {question,answer,citations[]} grounded in indexed spans.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Question about the codebase' },
      repo: { type: 'string', description: 'Restrict to a repo label (optional)' },
    },
    required: ['q'],
  },
  handler: async (args) => {
    try {
      if (!args.q) return fail('q required');
      return ok(await code(`/v1/code/ask${qs({ q: args.q, repo: args.repo })}`));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

// =============================================
// code_index — (re)index a corpus for the caller's org (incremental)
// =============================================

export const codeIndexTool: Tool = {
  name: 'code_index',
  description: 'Index (or incrementally re-index) a corpus into your org\'s code intelligence store. files = [{path,content}]; unchanged files are skipped by content hash. prune removes indexed files absent from the payload (full-tree reconcile). Returns index stats.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repo label to index the files under' },
      files: {
        type: 'array',
        description: 'Files to index: [{path, content}]',
        items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      },
      prune: { type: 'boolean', description: 'Remove indexed files not present in this payload (full-tree reconcile)' },
    },
    required: ['repo', 'files'],
  },
  handler: async (args) => {
    try {
      if (!args.repo) return fail('repo required');
      if (!Array.isArray(args.files) || args.files.length === 0) return fail('files required');
      return ok(await code('/v1/code/index', { method: 'POST', body: JSON.stringify({ repo: args.repo, files: args.files, prune: args.prune }) }));
    } catch (e: any) {
      return fail(e.message);
    }
  },
};

export const codeIntelTools: Tool[] = [codeSearchTool, codeContextTool, codeAskTool, codeIndexTool];
