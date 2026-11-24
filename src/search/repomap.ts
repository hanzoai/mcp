/**
 * Dynamic Repository Map Ranked by Symbol Graph (RepoMap) — HIP-1347 / Issue #36
 *
 * Implements:
 * 1. Derived symbol/reference graph over immutable source identities (blobId / version).
 * 2. Mandatory pre-query Tenant & ACL isolation (applied BEFORE graph edges or hits are evaluated).
 * 3. Personalized PageRank (alpha=0.85) seeded by active files, stacktrace/error symbols, task query,
 *    and recent Git changes, with hub-symbol inverse-frequency dampening.
 * 4. Token-budgeted compact architectural map formatter + MCP Tool handler (`repo_map`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Tool } from '../types/index.js';

export interface SourceDocument {
  /** Relative repository path (e.g. "src/search/unified-search.ts") */
  path: string;
  /** Raw UTF-8 file contents */
  content: string;
  /** Tenant namespace owning this blob; mandatory for multi-tenant isolation */
  tenantId: string;
  /** Explicit principals/roles allowed to read this source ("*" for public repo scope) */
  acl?: readonly string[];
  /** Immutable content/git identity; computed automatically as SHA-256 prefix if omitted */
  blobId?: string;
  /** Monotonic version or commit SHA */
  version?: string;
}

export interface CallerIdentity {
  tenantId: string;
  principal: string;
  roles?: readonly string[];
}

export interface SymbolDef {
  name: string;
  kind: 'class' | 'interface' | 'type' | 'function' | 'method' | 'struct' | 'enum' | 'const';
  line: number;
  signature: string;
  file: string;
}

export interface SymbolParserAdapter {
  supports(filePath: string): boolean;
  extract(filePath: string, content: string): { defs: SymbolDef[]; refs: Set<string> };
}

export interface RepoMapRequest {
  caller: CallerIdentity;
  /** Currently open / active files in the agent session */
  activeFiles?: readonly string[];
  /** Natural-language or identifier task prompt */
  taskQuery?: string;
  /** Compiler errors, stacktraces, or failing test output */
  errorOutput?: string;
  /** Files modified in recent commits / working tree */
  recentChangedFiles?: readonly string[];
  /** Strict token ceiling for the rendered architectural map (approx 4 chars/token) */
  maxTokens?: number;
}

export interface RankedFileEntry {
  path: string;
  blobId: string;
  score: number;
  symbols: SymbolDef[];
}

export interface RepoMapResult {
  mapText: string;
  tokensUsed: number;
  rawCorpusTokens: number;
  tokenReductionPct: number;
  candidateFilesAuthorized: number;
  candidateFilesFilteredOut: number;
  rankedFiles: RankedFileEntry[];
  latencyMs: number;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'where', 'what', 'which',
  'return', 'returns', 'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'import',
  'export', 'default', 'async', 'await', 'public', 'private', 'protected', 'static', 'void',
  'string', 'number', 'boolean', 'null', 'undefined', 'true', 'false', 'self', 'none', 'def',
  'struct', 'impl', 'pub', 'crate', 'super', 'use', 'mod', 'package', 'func', 'error', 'test',
]);

export function estimateRepoMapTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Strict pre-index / pre-query tenant + ACL gate. Tenant isolation is NEVER relaxed. */
export function isAuthorized(doc: SourceDocument, caller: CallerIdentity): boolean {
  if (!caller.tenantId || doc.tenantId !== caller.tenantId) {
    return false;
  }
  if (!doc.acl || doc.acl.length === 0 || doc.acl.includes('*')) {
    return true;
  }
  if (doc.acl.includes(caller.principal)) {
    return true;
  }
  if (caller.roles) {
    for (const r of caller.roles) {
      if (doc.acl.includes(`role:${r}`) || doc.acl.includes(r)) return true;
    }
  }
  return false;
}

function cleanSignature(line: string): string {
  return line
    .trim()
    .replace(/\s*\{[\s\S]*$/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

/** Fast clean-room lexical/structural symbol extractor for TS/JS, Python, Rust, and Go. */
export function defaultExtractSymbols(
  filePath: string,
  content: string,
): { defs: SymbolDef[]; refs: Set<string> } {
  const defs: SymbolDef[] = [];
  const lines = content.split(/\r?\n/);
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

  const tsJs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const py = ext === '.py';
  const rs = ext === '.rs';
  const go = ext === '.go';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
      continue;
    }

    if (tsJs) {
      let m = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'class', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'interface', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'type', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'enum', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'function', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'const', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
    } else if (py) {
      let m = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'class', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (m?.[1] && (!raw.startsWith('    ') || !m[1].startsWith('_'))) {
        defs.push({
          name: m[1],
          kind: raw.startsWith(' ') ? 'method' : 'function',
          line: i + 1,
          signature: cleanSignature(raw),
          file: filePath,
        });
      }
    } else if (rs) {
      let m = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'struct', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'function', line: i + 1, signature: cleanSignature(raw), file: filePath });
      }
    } else if (go) {
      let m = trimmed.match(/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'struct', line: i + 1, signature: cleanSignature(raw), file: filePath });
        continue;
      }
      m = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(/);
      if (m?.[1]) {
        defs.push({ name: m[1], kind: 'function', line: i + 1, signature: cleanSignature(raw), file: filePath });
      }
    }
  }

  const refs = new Set<string>();
  const identMatches = content.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
  for (const id of identMatches) {
    if (!STOPWORDS.has(id.toLowerCase())) {
      refs.add(id);
    }
  }
  return { defs, refs };
}

function tokenizeSignal(text: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const raw = text.match(/[A-Za-z0-9_./$-]{3,}/g) ?? [];
  for (const tok of raw) {
    if (!STOPWORDS.has(tok.toLowerCase())) {
      out.add(tok);
      const parts = tok.split(/[/_.-]|(?=[A-Z])/).filter((p) => p.length >= 3);
      for (const p of parts) {
        if (!STOPWORDS.has(p.toLowerCase())) out.add(p.toLowerCase());
      }
    }
  }
  return out;
}

export class RepoMapEngine {
  private docs: SourceDocument[] = [];
  private adapters: SymbolParserAdapter[] = [];

  constructor(adapters: SymbolParserAdapter[] = []) {
    this.adapters = adapters;
  }

  public indexDocuments(documents: readonly SourceDocument[]): void {
    this.docs = documents.map((d) => ({
      ...d,
      path: d.path.replace(/\\/g, '/'),
      blobId: d.blobId ?? crypto.createHash('sha256').update(d.content).digest('hex').slice(0, 16),
    }));
  }

  private parseDoc(doc: SourceDocument): { defs: SymbolDef[]; refs: Set<string> } {
    for (const ad of this.adapters) {
      if (ad.supports(doc.path)) return ad.extract(doc.path, doc.content);
    }
    return defaultExtractSymbols(doc.path, doc.content);
  }

  public buildRepoMap(req: RepoMapRequest): RepoMapResult {
    const t0 = performance.now();
    const maxTokens = req.maxTokens ?? 1024;

    // 1. MANDATORY PRE-FILTER: Enforce tenant & ACL isolation BEFORE building any symbol/edge index.
    const authorizedDocs: SourceDocument[] = [];
    let filteredOut = 0;
    for (const d of this.docs) {
      if (isAuthorized(d, req.caller)) {
        authorizedDocs.push(d);
      } else {
        filteredOut++;
      }
    }

    const n = authorizedDocs.length;
    if (n === 0) {
      return {
        mapText: '',
        tokensUsed: 0,
        rawCorpusTokens: 0,
        tokenReductionPct: 0,
        candidateFilesAuthorized: 0,
        candidateFilesFilteredOut: filteredOut,
        rankedFiles: [],
        latencyMs: Number((performance.now() - t0).toFixed(3)),
      };
    }

    const rawCorpusTokens = authorizedDocs.reduce((acc, d) => acc + estimateRepoMapTokens(d.content), 0);

    // 2. Parse symbols & references per authorized file
    const fileDefs: SymbolDef[][] = new Array(n);
    const fileRefs: Set<string>[] = new Array(n);
    const symbolProviders = new Map<string, number[]>();

    for (let i = 0; i < n; i++) {
      const parsed = this.parseDoc(authorizedDocs[i]!);
      fileDefs[i] = parsed.defs;
      fileRefs[i] = parsed.refs;
      for (const def of parsed.defs) {
        const arr = symbolProviders.get(def.name) ?? [];
        if (!arr.includes(i)) arr.push(i);
        symbolProviders.set(def.name, arr);
      }
    }

    // 3. Build personalization vector from active files, stacktraces/errors, task query, & recent diffs
    const activeList = (req.activeFiles ?? []).map((p) => p.replace(/\\/g, '/'));
    const activeSet = new Set(activeList);
    const activeExts = new Set(activeList.map((p) => p.slice(p.lastIndexOf('.')).toLowerCase()));
    const activeDirs = new Set(
      activeList.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')),
    );
    const recentSet = new Set((req.recentChangedFiles ?? []).map((p) => p.replace(/\\/g, '/')));
    const queryTokens = tokenizeSignal(req.taskQuery);
    const errorTokens = tokenizeSignal(req.errorOutput);

    const personalization = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const doc = authorizedDocs[i]!;
      const docExt = doc.path.slice(doc.path.lastIndexOf('.')).toLowerCase();
      const docDir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
      let w = 0.02;
      if (activeSet.has(doc.path)) w += 8.0;
      if (recentSet.has(doc.path)) w += 2.0;
      if (activeDirs.size > 0 && activeDirs.has(docDir)) w += 0.6;

      if (req.errorOutput && req.errorOutput.includes(doc.path)) w += 8.0;
      const baseName = doc.path
        .slice(doc.path.lastIndexOf('/') + 1)
        .replace(/\.[^.]+$/, '')
        .toLowerCase();
      if (baseName.length >= 3 && queryTokens.has(baseName)) w += 2.5;
      if (baseName.length >= 3 && errorTokens.has(baseName)) w += 4.0;

      let symScore = 0;
      for (const def of fileDefs[i]!) {
        const lower = def.name.toLowerCase();
        // Exact case-sensitive identifier match outweighs generic lowercase substring tokens
        if (errorTokens.has(def.name)) {
          symScore += 5.5;
        } else if (def.name.length >= 5 && errorTokens.has(lower)) {
          symScore += 2.5;
        }
        if (queryTokens.has(def.name)) {
          symScore += 4.0;
        } else if (def.name.length >= 6 && queryTokens.has(lower)) {
          symScore += 1.2;
        }
      }
      const langFactor = activeExts.size === 0 || activeExts.has(docExt) ? 1.0 : 0.35;
      w += Math.min(symScore, 12.0) * langFactor;
      personalization[i] = w;
    }

    let pSum = 0;
    for (let i = 0; i < n; i++) pSum += personalization[i]!;
    for (let i = 0; i < n; i++) personalization[i] = personalization[i]! / (pSum || 1);

    // 4. Construct weighted directed adjacency:
    //    (a) Explicit relative / scoped workspace imports
    //    (b) Symbol reference u -> provider v weighted by hub-dampened IDF * queryBoost
    const outEdges: Array<Map<number, number>> = Array.from({ length: n }, () => new Map<number, number>());
    const pathToIndex = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const p = authorizedDocs[i]!.path;
      pathToIndex.set(p, i);
      pathToIndex.set(p.replace(/\.[^.]+$/, ''), i);
    }

    for (let u = 0; u < n; u++) {
      const doc = authorizedDocs[u]!;
      const uDir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
      const uExt = doc.path.slice(doc.path.lastIndexOf('.'));

      const impMatches = doc.content.matchAll(/from\s+["']([^"']+)["']/g);
      for (const m of impMatches) {
        const spec = m[1];
        if (!spec) continue;
        let resolvedIdx: number | undefined;
        if (spec.startsWith('.')) {
          const parts = (uDir ? `${uDir}/${spec}` : spec).split('/');
          const stack: string[] = [];
          for (const part of parts) {
            if (!part || part === '.') continue;
            if (part === '..') stack.pop();
            else stack.push(part);
          }
          const norm = stack.join('/').replace(/\.(js|mjs|cjs)$/, '');
          resolvedIdx = pathToIndex.get(norm) ?? pathToIndex.get(`${norm}/index`);
        } else if (spec.startsWith('@') && spec.includes('/')) {
          const sub = spec.split('/').slice(1);
          const pkg = sub[0];
          const entry = sub[1] ?? 'index';
          if (pkg) {
            resolvedIdx =
              pathToIndex.get(`packages/${pkg}/src/${entry}`) ??
              pathToIndex.get(`src/${pkg}/${entry}`);
          }
        }
        if (resolvedIdx !== undefined && resolvedIdx !== u) {
          outEdges[u]!.set(resolvedIdx, (outEdges[u]!.get(resolvedIdx) ?? 0) + 32.0);
          outEdges[resolvedIdx]!.set(u, (outEdges[resolvedIdx]!.get(u) ?? 0) + 8.0);
        }
      }

      const refs = fileRefs[u]!;
      for (const sym of refs) {
        if (sym.length < 4) continue;
        const providers = symbolProviders.get(sym);
        if (!providers || providers.length === 0 || providers.length > 16) continue;
        // Hub dampening: symbols defined in many files get 1 / providers.length^1.6
        const idfWeight = 1.0 / Math.pow(providers.length, 1.6);
        const queryBoost = errorTokens.has(sym)
          ? 5.0
          : queryTokens.has(sym)
            ? 4.0
            : queryTokens.has(sym.toLowerCase())
              ? 1.8
              : 1.0;

        for (const v of providers) {
          if (u === v) continue;
          const vExt = authorizedDocs[v]!.path.slice(authorizedDocs[v]!.path.lastIndexOf('.'));
          const sameLang = uExt === vExt ? 1.8 : 0.12;
          const edgeW = idfWeight * queryBoost * sameLang;
          outEdges[u]!.set(v, (outEdges[u]!.get(v) ?? 0) + edgeW);
          outEdges[v]!.set(u, (outEdges[v]!.get(u) ?? 0) + edgeW * 0.35);
        }
      }
    }

    // 5. Power-iteration Personalized PageRank (alpha = 0.85, 25 iterations)
    const alpha = 0.85;
    let ranks = new Float64Array(personalization);
    const outWeightSums = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const w of outEdges[i]!.values()) s += w;
      outWeightSums[i] = s;
    }

    for (let iter = 0; iter < 25; iter++) {
      const next = new Float64Array(n);
      let danglingMass = 0;
      for (let u = 0; u < n; u++) {
        if (outWeightSums[u]! === 0) {
          danglingMass += ranks[u]!;
        } else {
          const factor = (alpha * ranks[u]!) / outWeightSums[u]!;
          for (const [v, w] of outEdges[u]!.entries()) {
            next[v] += factor * w;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        next[i] += (1 - alpha + alpha * danglingMass) * personalization[i]!;
      }
      ranks = next;
    }

    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => ranks[b]! - ranks[a]!);

    const rankedFiles: RankedFileEntry[] = order.map((idx) => ({
      path: authorizedDocs[idx]!.path,
      blobId: authorizedDocs[idx]!.blobId ?? '',
      score: Number(ranks[idx]!.toFixed(6)),
      symbols: fileDefs[idx]!,
    }));

    // 6. Token-budgeted map rendering
    const blocks: string[] = [];
    let usedTokens = 0;

    for (const entry of rankedFiles) {
      if (entry.symbols.length === 0 && !activeSet.has(entry.path)) continue;
      const sortedSyms = [...entry.symbols].sort((a, b) => {
        const aHit = (errorTokens.has(a.name) ? 2 : 0) + (queryTokens.has(a.name) ? 1 : 0);
        const bHit = (errorTokens.has(b.name) ? 2 : 0) + (queryTokens.has(b.name) ? 1 : 0);
        return bHit - aHit || a.line - b.line;
      });
      const topSyms = sortedSyms.slice(0, 12);
      const header = `${entry.path}:`;
      const symLines = topSyms.map((s) => `  L${s.line}: ${s.signature}`);
      const candidateBlock = [header, ...symLines].join('\n');
      const blockTokens = estimateRepoMapTokens(candidateBlock + '\n');

      if (usedTokens + blockTokens > maxTokens) {
        const miniBlock = [header, ...symLines.slice(0, 3)].join('\n');
        const miniTokens = estimateRepoMapTokens(miniBlock + '\n');
        if (symLines.length > 0 && usedTokens + miniTokens <= maxTokens) {
          blocks.push(miniBlock);
          usedTokens += miniTokens;
        }
        if (usedTokens >= maxTokens * 0.9) break;
        continue;
      }

      blocks.push(candidateBlock);
      usedTokens += blockTokens;
    }

    const mapText = blocks.join('\n\n');
    const finalTokens = estimateRepoMapTokens(mapText);
    const reduction =
      rawCorpusTokens > 0 ? Number(((1 - finalTokens / rawCorpusTokens) * 100).toFixed(2)) : 0;

    return {
      mapText,
      tokensUsed: finalTokens,
      rawCorpusTokens,
      tokenReductionPct: reduction,
      candidateFilesAuthorized: n,
      candidateFilesFilteredOut: filteredOut,
      rankedFiles,
      latencyMs: Number((performance.now() - t0).toFixed(3)),
    };
  }
}

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  'target',
  '__pycache__',
]);

const DEFAULT_CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go']);

/** Load source documents from a local workspace directory under a caller's tenant scope. */
export function loadWorkspaceDocuments(
  rootDir: string,
  tenantId: string,
  acl: readonly string[] = ['*'],
): SourceDocument[] {
  const out: SourceDocument[] = [];
  const resolvedRoot = path.resolve(rootDir);

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (DEFAULT_IGNORED_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (DEFAULT_CODE_EXTS.has(path.extname(ent.name).toLowerCase())) {
        try {
          const stat = fs.statSync(full);
          if (stat.size > 512 * 1024) continue;
          const rel = path.relative(resolvedRoot, full).replace(/\\/g, '/');
          const content = fs.readFileSync(full, 'utf8');
          out.push({ path: rel, content, tenantId, acl });
        } catch {
          // Ignore unreadable files
        }
      }
    }
  }

  walk(resolvedRoot);
  return out;
}

/** MCP Tool definition for `@hanzo/mcp` */
export const repoMapTool: Tool = {
  name: 'repo_map',
  description:
    'Generate a token-budgeted architectural repository map ranked by symbol-graph Personalized PageRank over active files, task query, stacktraces, and recent Git changes, with strict pre-query tenant & ACL isolation.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Workspace root path to index (defaults to current working directory).',
      },
      tenantId: {
        type: 'string',
        description: 'Mandatory tenant namespace ID.',
      },
      principal: {
        type: 'string',
        description: 'Authenticated caller principal.',
      },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional caller roles for ACL evaluation.',
      },
      activeFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Currently active/open relative file paths.',
      },
      taskQuery: {
        type: 'string',
        description: 'Task prompt or symbol query.',
      },
      errorOutput: {
        type: 'string',
        description: 'Compiler error or stacktrace output.',
      },
      recentChangedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recently modified relative file paths.',
      },
      maxTokens: {
        type: 'number',
        default: 1024,
        description: 'Maximum token budget for the rendered repository map.',
      },
    },
    required: ['tenantId', 'principal'],
  },
  handler: async (args: Record<string, any>) => {
    if (!args.tenantId || !args.principal) {
      return {
        content: [{ type: 'text', text: 'Error: tenantId and principal are required' }],
        isError: true,
      };
    }
    const rootDir = typeof args.projectPath === 'string' && args.projectPath ? args.projectPath : process.cwd();
    const docs = loadWorkspaceDocuments(rootDir, String(args.tenantId));
    const engine = new RepoMapEngine();
    engine.indexDocuments(docs);
    const result = engine.buildRepoMap({
      caller: {
        tenantId: String(args.tenantId),
        principal: String(args.principal),
        roles: Array.isArray(args.roles) ? args.roles.map(String) : undefined,
      },
      activeFiles: Array.isArray(args.activeFiles) ? args.activeFiles.map(String) : undefined,
      taskQuery: typeof args.taskQuery === 'string' ? args.taskQuery : undefined,
      errorOutput: typeof args.errorOutput === 'string' ? args.errorOutput : undefined,
      recentChangedFiles: Array.isArray(args.recentChangedFiles)
        ? args.recentChangedFiles.map(String)
        : undefined,
      maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : 1024,
    });
    return {
      content: [
        {
          type: 'text',
          text: result.mapText || '(no matching symbols within token budget)',
        },
      ],
    };
  },
};
