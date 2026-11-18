/**
 * Dynamic Repository Map Ranked by Symbol Graph (HIP-1347 / hanzoai/mcp#36).
 *
 * Clean-room MIT TypeScript implementation inspired by Aider's RepoMap
 * (Apache-2.0 architectural reference):
 *   1. Immutable source blob identity (blobSha, commitRevision) and strict
 *      pre-index / pre-ranking tenant + RBAC/ACL access-control filtering.
 *   2. Multi-language structural symbol & reference extractor (TypeScript,
 *      JavaScript, Rust, Python, Go) plus pluggable AST / Tree-sitter adapter.
 *   3. Weighted Personalized PageRank over cross-file symbol dependency edges
 *      seeded by active files, task terms, compiler/stack-trace spans, and
 *      recent git diff changes, with hub damping for ubiquitous utilities.
 *   4. Token-budgeted compact map renderer using rank-prefix packing so agents
 *      receive top architectural files, signatures, and call edges within budget.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

export type RepoMapLanguage =
  | 'typescript'
  | 'javascript'
  | 'rust'
  | 'python'
  | 'go'
  | 'unknown';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'const';

/**
 * Canonical immutable source record. Symbol graphs and ranked maps are derived
 * representations over these identities and can be discarded and rebuilt at any time.
 */
export interface SourceBlobRecord {
  /** Workspace-relative file path. */
  filePath: string;
  /** Raw UTF-8 source text. */
  content: string;
  /** Content hash identity (computed as sha256:<hex> if omitted). */
  blobSha?: string;
  /** Git commit SHA or workspace revision identifier. */
  commitRevision?: string;
  /** Owning tenant ID for multi-tenant isolation. */
  tenantId?: string;
  /** Optional RBAC role allowlist; caller must hold at least one role when non-empty. */
  allowedRoles?: string[];
  /** Optional required clearance/scope tags; caller must hold every tag when non-empty. */
  aclTags?: string[];
  /** Explicit language override; inferred from file extension when omitted. */
  language?: RepoMapLanguage;
}

export interface NormalizedSourceBlob {
  filePath: string;
  content: string;
  blobSha: string;
  commitRevision: string;
  tenantId?: string;
  allowedRoles: string[];
  aclTags: string[];
  language: RepoMapLanguage;
}

/**
 * Access-control context evaluated BEFORE symbol extraction, graph construction,
 * Personalized PageRank propagation, or hit rendering.
 */
export interface AccessControlPolicy {
  /** Caller tenant ID. Tenant mismatches fail closed and never enter the graph. */
  tenantId?: string;
  /** Roles held by the requesting principal. */
  principalRoles?: string[];
  /** Clearance / scope tags held by the requesting principal. */
  principalAclTags?: string[];
  /**
   * When true (default whenever policy.tenantId is set), blobs without an explicit
   * matching tenantId are also rejected so unlabeled records never leak into a tenant view.
   */
  requireTenantMatch?: boolean;
  /** Workspace-relative path prefixes denied by policy (e.g. ['secrets/', '.env']). */
  deniedPathPrefixes?: string[];
}

export type AccessRejectionReason =
  | 'invalid_path'
  | 'denied_path'
  | 'tenant_mismatch'
  | 'missing_tenant'
  | 'role_denied'
  | 'acl_tag_denied';

export interface AuthorizationResult {
  authorized: NormalizedSourceBlob[];
  excludedCount: number;
  excludedByReason: Record<AccessRejectionReason, number>;
}

export interface SymbolDefinition {
  /** Deterministic derived node ID: `${filePath}#${kind}:${name}:${line}` */
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  /** 1-based declaration start line. */
  line: number;
  /** 1-based inclusive block end line. */
  endLine: number;
  exported: boolean;
  /** Compact single-line signature without implementation body. */
  signature: string;
  /** Enclosing class/struct/impl/interface name for methods. */
  parentSymbol?: string;
  /** Source blob provenance. */
  blobSha: string;
  commitRevision: string;
}

export interface ImportBinding {
  /** Raw module specifier from source (e.g. './ledger.js', 'crate::fees::calc'). */
  moduleSpecifier: string;
  /** Imported symbol identifiers ('*' for wildcard / namespace import). */
  importedSymbols: string[];
  /** Local alias -> exported name map when aliased (`import { a as b }`). */
  aliasMap?: Record<string, string>;
  /** True when re-exported (`export { ... } from` or `pub use`). */
  isReExport?: boolean;
  line: number;
}

export interface IdentifierReference {
  name: string;
  line: number;
  enclosingSymbol?: string;
  isCall: boolean;
}

export interface ExtractedFileSymbols {
  filePath: string;
  language: RepoMapLanguage;
  blobSha: string;
  commitRevision: string;
  definitions: SymbolDefinition[];
  imports: ImportBinding[];
  references: IdentifierReference[];
}

/**
 * Pluggable symbol extractor interface allowing external Tree-sitter or compiler
 * AST parsers to supply symbol definitions, imports, and references cleanly.
 */
export interface SymbolExtractorAdapter {
  readonly name: string;
  supports(language: RepoMapLanguage, filePath: string): boolean;
  extract(blob: NormalizedSourceBlob): ExtractedFileSymbols;
}

export interface SymbolGraphEdge {
  fromFile: string;
  toFile: string;
  fromSymbol?: string;
  toSymbol: string;
  kind: 'import_call' | 'import_ref' | 'symbol_call' | 'symbol_ref' | 'reexport';
  weight: number;
  callCount: number;
}

export interface SymbolGraphFileNode {
  filePath: string;
  language: RepoMapLanguage;
  blobSha: string;
  commitRevision: string;
  tenantId?: string;
  definitions: SymbolDefinition[];
  imports: ImportBinding[];
  inFileDegree: number;
  outFileDegree: number;
}

export interface SymbolGraph {
  files: Map<string, SymbolGraphFileNode>;
  edges: SymbolGraphEdge[];
  totalSourceBlobs: number;
  authorizedBlobs: number;
  excludedByAccessControl: number;
  excludedByReason: Record<AccessRejectionReason, number>;
  buildDurationMs: number;
}

export interface ErrorSpanSeed {
  filePath: string;
  line?: number;
  column?: number;
  symbolName?: string;
  message?: string;
}

export interface GitDiffFileChange {
  filePath: string;
  changedRanges: Array<{ startLine: number; endLine: number }>;
}

export interface RepoMapQueryContext {
  /** Currently open / active files in the agent's working set. */
  activeFiles?: string[];
  /** Natural-language task prompt or issue description. */
  taskQuery?: string;
  /** Structured stack-trace or compiler diagnostic spans. */
  errorSpans?: ErrorSpanSeed[];
  /** Raw compiler, test, or traceback log to parse file:line spans from. */
  diagnosticText?: string;
  /** File paths modified in git status / git diff. */
  gitDiffPaths?: string[];
  /** Raw unified git diff output used to locate modified files and hunk lines. */
  gitDiffText?: string;
  /** Explicit symbol names referenced in prompt or agent state. */
  mentionedSymbols?: string[];
  /** Access-control policy enforced prior to graph construction and ranking. */
  accessControl?: AccessControlPolicy;
}

export interface RankSymbolGraphOptions {
  /** PageRank damping factor alpha in (0, 1). Default: 0.85. */
  dampingFactor?: number;
  /** Maximum power-iteration steps. Default: 100. */
  maxIterations?: number;
  /** L1 convergence residual threshold. Default: 1e-7. */
  tolerance?: number;
  /** Weight multiplier for reverse callee->caller impact edges. Default: 0.55. */
  reverseEdgeFactor?: number;
}

export interface RankedSymbolEntry {
  symbol: SymbolDefinition;
  score: number;
  seedReasons: string[];
  outgoingTargets: Array<{ toFile: string; toSymbol: string; weight: number }>;
  incomingCallers: Array<{ fromFile: string; fromSymbol?: string; weight: number }>;
}

export interface RankedFileEntry {
  filePath: string;
  language: RepoMapLanguage;
  blobSha: string;
  commitRevision: string;
  pageRankScore: number;
  personalizationWeight: number;
  seedReasons: string[];
  symbols: RankedSymbolEntry[];
}

export interface RankedSymbolGraph {
  rankedFiles: RankedFileEntry[];
  iterations: number;
  residual: number;
  converged: boolean;
  extractedErrorSpans: ErrorSpanSeed[];
  extractedDiffChanges: GitDiffFileChange[];
  rankDurationMs: number;
}

export interface RenderRepoMapOptions {
  /** Hard upper bound on estimated tokens in the rendered output. Default: 1024. */
  maxTokens?: number;
  /** Custom token estimator (defaults to Math.ceil(chars / 4)). */
  tokenCounter?: (text: string) => number;
  /** Maximum symbols rendered per file before moving to lower-ranked tiers. Default: 8. */
  maxSymbolsPerFile?: number;
  /** Maximum cross-file call/reference edges shown per symbol. Default: 2. */
  maxEdgesPerSymbol?: number;
  /** Include compact summary header line when budget permits. Default: true. */
  includeHeader?: boolean;
  /** Include score annotations next to file headers. Default: true. */
  includeScores?: boolean;
}

export interface RepoMapMetrics {
  totalSourceFiles: number;
  authorizedFiles: number;
  excludedByAccessControl: number;
  renderedFiles: number;
  renderedSymbols: number;
  renderedEdges: number;
  estimatedTokens: number;
  maxTokens: number;
  budgetUtilization: number;
  pprIterations: number;
  pprResidual: number;
  pprConverged: boolean;
  graphBuildMs: number;
  rankMs: number;
  renderMs: number;
  totalLatencyMs: number;
}

export interface RenderedRepoMap {
  text: string;
  includedFiles: string[];
  includedSymbols: string[];
  renderedEdges: number;
  estimatedTokens: number;
  maxTokens: number;
  renderDurationMs: number;
}

export interface BuildSymbolGraphOptions {
  accessControl?: AccessControlPolicy;
  adapters?: SymbolExtractorAdapter[];
  cache?: DerivedSymbolCache;
  enableHubDamping?: boolean;
}

export interface GenerateRepoMapOptions
  extends BuildSymbolGraphOptions,
    RankSymbolGraphOptions,
    RenderRepoMapOptions {}

export interface RepoMapResult {
  text: string;
  includedFiles: string[];
  includedSymbols: string[];
  rankedFiles: RankedFileEntry[];
  graph: SymbolGraph;
  metrics: RepoMapMetrics;
}

export interface WorkspaceScanOptions {
  includePatterns?: string[];
  ignorePatterns?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  commitRevision?: string;
  tenantId?: string;
  allowedRoles?: string[];
  aclTags?: string[];
}

export interface WorkspaceRepoMapOptions
  extends WorkspaceScanOptions,
    GenerateRepoMapOptions {}

// ---------------------------------------------------------------------------
// Stable Identity, Token Estimation & Path Utilities
// ---------------------------------------------------------------------------

export function computeBlobSha(content: string): string {
  const hex = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

export function estimateRepoMapTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function normalizeRepoPath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  if (rawPath.includes('\0')) return null;
  const slash = rawPath.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (!slash) return null;
  const parts = slash.split('/').filter((segment) => segment.length > 0);
  if (parts.length === 0) return null;
  for (const seg of parts) {
    if (seg === '..') return null;
  }
  const normalized: string[] = [];
  for (const seg of parts) {
    if (seg === '.') continue;
    normalized.push(seg);
  }
  return normalized.length > 0 ? normalized.join('/') : null;
}

export function detectRepoMapLanguage(filePath: string): RepoMapLanguage {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript';
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'javascript';
  }
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.py') || lower.endsWith('.pyi')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  return 'unknown';
}

/**
 * Enforces strict source-identity and access-control filtering BEFORE any symbol
 * extraction, graph edge linking, PageRank scoring, or output rendering occurs.
 */
export function authorizeSourceBlobs(
  records: SourceBlobRecord[],
  policy?: AccessControlPolicy
): AuthorizationResult {
  const excludedByReason: Record<AccessRejectionReason, number> = {
    invalid_path: 0,
    denied_path: 0,
    tenant_mismatch: 0,
    missing_tenant: 0,
    role_denied: 0,
    acl_tag_denied: 0,
  };

  const deniedPrefixes = (policy?.deniedPathPrefixes ?? [])
    .map((p) => normalizeRepoPath(p))
    .filter((p): p is string => p !== null);

  const callerRoles = new Set(policy?.principalRoles ?? []);
  const callerAclTags = new Set(policy?.principalAclTags ?? []);
  const policyTenant = policy?.tenantId;
  const requireTenantMatch = policy?.requireTenantMatch ?? policyTenant !== undefined;

  const authorizedByPath = new Map<string, NormalizedSourceBlob>();
  let excludedCount = 0;

  for (const rec of records) {
    const normPath = normalizeRepoPath(rec.filePath);
    if (!normPath) {
      excludedByReason.invalid_path++;
      excludedCount++;
      continue;
    }

    if (
      deniedPrefixes.some(
        (prefix) => normPath === prefix || normPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
      )
    ) {
      excludedByReason.denied_path++;
      excludedCount++;
      continue;
    }

    // Tenant isolation: never relax tenant boundaries for speed or recall.
    if (policyTenant !== undefined) {
      if (rec.tenantId === undefined) {
        if (requireTenantMatch) {
          excludedByReason.missing_tenant++;
          excludedCount++;
          continue;
        }
      } else if (rec.tenantId !== policyTenant) {
        excludedByReason.tenant_mismatch++;
        excludedCount++;
        continue;
      }
    } else if (rec.tenantId !== undefined) {
      // Tenant-owned blob accessed without a tenant-scoped policy fails closed.
      excludedByReason.tenant_mismatch++;
      excludedCount++;
      continue;
    }

    // Role-based access control (OR-membership over allowedRoles when specified).
    if (rec.allowedRoles && rec.allowedRoles.length > 0) {
      const hasRole = rec.allowedRoles.some((role) => callerRoles.has(role));
      if (!hasRole) {
        excludedByReason.role_denied++;
        excludedCount++;
        continue;
      }
    }

    // Required ACL scope tags (AND-membership over aclTags when specified).
    if (rec.aclTags && rec.aclTags.length > 0) {
      const hasAllTags = rec.aclTags.every((tag) => callerAclTags.has(tag));
      if (!hasAllTags) {
        excludedByReason.acl_tag_denied++;
        excludedCount++;
        continue;
      }
    }

    authorizedByPath.set(normPath, {
      filePath: normPath,
      content: rec.content,
      blobSha: rec.blobSha || computeBlobSha(rec.content),
      commitRevision: rec.commitRevision || 'working-tree',
      tenantId: rec.tenantId,
      allowedRoles: rec.allowedRoles ? [...rec.allowedRoles] : [],
      aclTags: rec.aclTags ? [...rec.aclTags] : [],
      language: rec.language ?? detectRepoMapLanguage(normPath),
    });
  }

  const authorized = Array.from(authorizedByPath.values()).sort((a, b) =>
    a.filePath.localeCompare(b.filePath)
  );

  return {
    authorized,
    excludedCount,
    excludedByReason,
  };
}

// ---------------------------------------------------------------------------
// Rebuildable Derived Symbol Cache
// ---------------------------------------------------------------------------

export class DerivedSymbolCache {
  private readonly entries = new Map<string, ExtractedFileSymbols>();
  private hits = 0;
  private misses = 0;

  private makeKey(blob: NormalizedSourceBlob, adapterName: string): string {
    const tenantPart = blob.tenantId ?? '__public__';
    return `${tenantPart}::${blob.filePath}::${blob.blobSha}::${blob.commitRevision}::${adapterName}`;
  }

  getOrExtract(blob: NormalizedSourceBlob, adapter: SymbolExtractorAdapter): ExtractedFileSymbols {
    const key = this.makeKey(blob, adapter.name);
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const extracted = adapter.extract(blob);
    this.entries.set(key, extracted);
    return extracted;
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }
}

// ---------------------------------------------------------------------------
// Line-Preserving Comment & String Sanitizer
// ---------------------------------------------------------------------------

/**
 * Strips comments (and optionally string literals) while preserving exact line
 * numbers so structural regexes never match inside comments or string constants.
 */
export function sanitizeSourcePreservingLines(
  content: string,
  language: RepoMapLanguage,
  stripStrings: boolean
): string {
  const out: string[] = new Array(content.length);
  const len = content.length;
  const isPython = language === 'python';
  let i = 0;

  type LexState =
    | 'code'
    | 'line_comment'
    | 'block_comment'
    | 'single_str'
    | 'double_str'
    | 'backtick_str'
    | 'py_triple_single'
    | 'py_triple_double';

  let state: LexState = 'code';

  const pushBlank = (ch: string, idx: number) => {
    out[idx] = ch === '\n' ? '\n' : ' ';
  };

  while (i < len) {
    const ch = content[i];
    const next = i + 1 < len ? content[i + 1] : '';
    const next2 = i + 2 < len ? content[i + 2] : '';

    if (state === 'code') {
      if (isPython) {
        if (ch === '#') {
          state = 'line_comment';
          pushBlank(ch, i++);
          continue;
        }
        if (ch === "'" && next === "'" && next2 === "'") {
          state = 'py_triple_single';
          pushBlank(ch, i++);
          pushBlank(next, i++);
          pushBlank(next2, i++);
          continue;
        }
        if (ch === '"' && next === '"' && next2 === '"') {
          state = 'py_triple_double';
          pushBlank(ch, i++);
          pushBlank(next, i++);
          pushBlank(next2, i++);
          continue;
        }
      } else {
        if (ch === '/' && next === '/') {
          state = 'line_comment';
          pushBlank(ch, i++);
          pushBlank(next, i++);
          continue;
        }
        if (ch === '/' && next === '*') {
          state = 'block_comment';
          pushBlank(ch, i++);
          pushBlank(next, i++);
          continue;
        }
      }

      if (ch === "'") {
        // In Rust, lifetime tokens like `'a` or `'static` are not character strings.
        if (language === 'rust') {
          const lifetimeMatch = /^'[A-Za-z_]\w*(?!')/.exec(content.slice(i));
          if (lifetimeMatch) {
            for (let k = 0; k < lifetimeMatch[0].length; k++) {
              out[i + k] = stripStrings ? ' ' : content[i + k];
            }
            i += lifetimeMatch[0].length;
            continue;
          }
        }
        state = 'single_str';
        out[i] = stripStrings ? ' ' : ch;
        i++;
        continue;
      }

      if (ch === '"') {
        state = 'double_str';
        out[i] = stripStrings ? ' ' : ch;
        i++;
        continue;
      }

      if (!isPython && ch === '`') {
        state = 'backtick_str';
        out[i] = ' ';
        i++;
        continue;
      }

      out[i] = ch;
      i++;
      continue;
    }

    if (state === 'line_comment') {
      if (ch === '\n') {
        out[i] = '\n';
        state = 'code';
      } else {
        out[i] = ' ';
      }
      i++;
      continue;
    }

    if (state === 'block_comment') {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        state = 'code';
      } else {
        pushBlank(ch, i++);
      }
      continue;
    }

    if (state === 'py_triple_single') {
      if (ch === '\\' && i + 1 < len) {
        pushBlank(ch, i++);
        pushBlank(content[i], i++);
        continue;
      }
      if (ch === "'" && next === "'" && next2 === "'") {
        pushBlank(ch, i++);
        pushBlank(next, i++);
        pushBlank(next2, i++);
        state = 'code';
      } else {
        pushBlank(ch, i++);
      }
      continue;
    }

    if (state === 'py_triple_double') {
      if (ch === '\\' && i + 1 < len) {
        pushBlank(ch, i++);
        pushBlank(content[i], i++);
        continue;
      }
      if (ch === '"' && next === '"' && next2 === '"') {
        pushBlank(ch, i++);
        pushBlank(next, i++);
        pushBlank(next2, i++);
        state = 'code';
      } else {
        pushBlank(ch, i++);
      }
      continue;
    }

    if (state === 'single_str') {
      if (ch === '\\' && i + 1 < len) {
        out[i] = stripStrings ? ' ' : ch;
        out[i + 1] = content[i + 1] === '\n' ? '\n' : stripStrings ? ' ' : content[i + 1];
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '\n') {
        out[i] = ch === '\n' ? '\n' : stripStrings ? ' ' : ch;
        state = 'code';
      } else {
        out[i] = stripStrings ? ' ' : ch;
      }
      i++;
      continue;
    }

    if (state === 'double_str') {
      if (ch === '\\' && i + 1 < len) {
        out[i] = stripStrings ? ' ' : ch;
        out[i + 1] = content[i + 1] === '\n' ? '\n' : stripStrings ? ' ' : content[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"' || ch === '\n') {
        out[i] = ch === '\n' ? '\n' : stripStrings ? ' ' : ch;
        state = 'code';
      } else {
        out[i] = stripStrings ? ' ' : ch;
      }
      i++;
      continue;
    }

    if (state === 'backtick_str') {
      if (ch === '\\' && i + 1 < len) {
        pushBlank(ch, i++);
        pushBlank(content[i], i++);
      } else if (ch === '`') {
        out[i] = ' ';
        state = 'code';
        i++;
      } else {
        pushBlank(ch, i++);
      }
      continue;
    }
  }

  return out.join('');
}

// ---------------------------------------------------------------------------
// Multi-Language Structural Symbol Extractor
// ---------------------------------------------------------------------------

const STOP_IDENTIFIERS = new Set([
  // JS / TS keywords & common globals
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'instanceof',
  'void', 'in', 'of', 'var', 'let', 'const', 'function', 'class', 'interface', 'type',
  'enum', 'extends', 'implements', 'export', 'import', 'from', 'as', 'async', 'await',
  'yield', 'static', 'public', 'private', 'protected', 'readonly', 'abstract', 'override',
  'declare', 'namespace', 'module', 'super', 'this', 'true', 'false', 'null', 'undefined',
  'NaN', 'Infinity', 'string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'unknown',
  'never', 'any', 'Promise', 'Array', 'Map', 'Set', 'Record', 'Partial', 'Required',
  'Readonly', 'Pick', 'Omit', 'Error', 'Object', 'String', 'Number', 'Boolean', 'Math',
  'JSON', 'Date', 'RegExp', 'Buffer', 'console', 'process', 'require', 'constructor',
  // Rust keywords & prelude primitives
  'fn', 'pub', 'crate', 'mod', 'use', 'struct', 'trait', 'impl', 'where', 'mut', 'ref',
  'move', 'match', 'loop', 'Self', 'self', 'Some', 'None', 'Ok', 'Err', 'Result', 'Option',
  'Vec', 'Box', 'Arc', 'Rc', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'u8', 'u16',
  'u32', 'u64', 'u128', 'usize', 'i8', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'f32',
  'f64', 'bool', 'str', 'char', 'unsafe', 'extern', 'dyn', 'macro_rules',
  // Python keywords & builtins
  'def', 'pass', 'lambda', 'with', 'assert', 'elif', 'except', 'raise', 'global',
  'nonlocal', 'True', 'False', 'cls', 'int', 'float', 'dict', 'list', 'tuple', 'set',
  'bytes', 'Optional', 'List', 'Dict', 'Tuple', 'Any', 'Union', 'Callable', 'print', 'len',
  'range', 'enumerate', 'isinstance', '__init__', '__name__', '__main__',
  // Go keywords & builtins
  'func', 'package', 'defer', 'go', 'chan', 'select', 'fallthrough', 'map', 'make',
  'append', 'copy', 'close', 'panic', 'recover', 'nil', 'byte', 'rune', 'error', 'int64',
  'int32', 'uint64', 'uint32', 'float64', 'context', 'ctx', 'err',
]);

const CONTROL_METHOD_DENYLIST = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'typeof', 'delete', 'await',
]);

function formatCompactSignature(rawLines: string[], startIdx: number): string {
  const parts: string[] = [];
  for (let i = startIdx; i < Math.min(rawLines.length, startIdx + 4); i++) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) break;
    parts.push(trimmed);
    if (trimmed.includes('{') || trimmed.endsWith(';') || trimmed.endsWith(':')) {
      break;
    }
  }
  let combined = parts.join(' ').replace(/\s+/g, ' ');
  const braceIdx = combined.indexOf('{');
  if (braceIdx > 0 && !combined.startsWith('export {') && !combined.startsWith('import {')) {
    combined = combined.slice(0, braceIdx).trim();
  }
  if (combined.endsWith(';')) {
    combined = combined.slice(0, -1).trim();
  }
  if (combined.length > 140) {
    combined = `${combined.slice(0, 137)}...`;
  }
  return combined;
}

function findBraceBlockEndLine(codeLines: string[], startIdx: number): number {
  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < codeLines.length; i++) {
    const line = codeLines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
        if (opened && depth <= 0) {
          return i + 1;
        }
      }
    }
    if (!opened && i > startIdx + 4) {
      return startIdx + 1;
    }
    if (!opened && line.trim().endsWith(';')) {
      return i + 1;
    }
  }
  return opened ? codeLines.length : startIdx + 1;
}

function findPythonBlockEndLine(codeLines: string[], startIdx: number): number {
  const headerLine = codeLines[startIdx];
  const indentMatch = /^(\s*)/.exec(headerLine);
  const baseIndent = indentMatch ? indentMatch[1].length : 0;
  let lastContentLine = startIdx + 1;

  for (let i = startIdx + 1; i < codeLines.length; i++) {
    const line = codeLines[i];
    if (line.trim().length === 0) continue;
    const curIndent = /^(\s*)/.exec(line)?.[1].length ?? 0;
    if (curIndent <= baseIndent) {
      return lastContentLine;
    }
    lastContentLine = i + 1;
  }
  return lastContentLine;
}

function parseNamedList(rawInner: string): { names: string[]; aliasMap: Record<string, string> } {
  const names: string[] = [];
  const aliasMap: Record<string, string> = {};
  for (const rawPart of rawInner.split(',')) {
    const cleaned = rawPart.replace(/\btype\b/g, '').trim();
    if (!cleaned) continue;
    const asMatch = /^([A-Za-z_$][\w$]*|\*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(cleaned);
    if (asMatch) {
      const exportedName = asMatch[1];
      const localAlias = asMatch[2];
      names.push(exportedName);
      aliasMap[localAlias] = exportedName;
    } else if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) {
      names.push(cleaned);
      aliasMap[cleaned] = cleaned;
    }
  }
  return { names, aliasMap };
}

export class DefaultStructuralExtractor implements SymbolExtractorAdapter {
  readonly name = 'default-structural-v1';

  supports(language: RepoMapLanguage): boolean {
    return language !== 'unknown';
  }

  extract(blob: NormalizedSourceBlob): ExtractedFileSymbols {
    const rawLines = blob.content.split(/\r?\n/);
    const commentStripped = sanitizeSourcePreservingLines(blob.content, blob.language, false);
    const codeStripped = sanitizeSourcePreservingLines(blob.content, blob.language, true);
    const importLines = commentStripped.split(/\r?\n/);
    const codeLines = codeStripped.split(/\r?\n/);

    const imports = this.extractImports(commentStripped, importLines, blob.language);
    const definitions = this.extractDefinitions(blob, rawLines, codeLines);
    const references = this.extractReferences(codeLines, definitions);

    return {
      filePath: blob.filePath,
      language: blob.language,
      blobSha: blob.blobSha,
      commitRevision: blob.commitRevision,
      definitions,
      imports,
      references,
    };
  }

  private extractImports(
    commentStripped: string,
    importLines: string[],
    language: RepoMapLanguage
  ): ImportBinding[] {
    const imports: ImportBinding[] = [];

    if (language === 'typescript' || language === 'javascript') {
      const esImportRe =
        /(?:^|\n)\s*(import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = esImportRe.exec(commentStripped)) !== null) {
        const keyword = match[1];
        const clause = match[2].trim();
        const spec = match[3].trim();
        const line = commentStripped.slice(0, match.index).split('\n').length;
        const importedSymbols: string[] = [];
        const aliasMap: Record<string, string> = {};

        if (clause === '*') {
          importedSymbols.push('*');
        } else {
          const nsMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
          if (nsMatch) {
            importedSymbols.push('*');
            aliasMap[nsMatch[1]] = '*';
          } else {
            const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
            if (braceMatch) {
              const parsed = parseNamedList(braceMatch[1]);
              importedSymbols.push(...parsed.names);
              Object.assign(aliasMap, parsed.aliasMap);
            }
            const beforeBrace = clause.split('{')[0].replace(/,/g, '').trim();
            if (beforeBrace && /^[A-Za-z_$][\w$]*$/.test(beforeBrace)) {
              importedSymbols.push('default');
              aliasMap[beforeBrace] = 'default';
            }
          }
        }

        imports.push({
          moduleSpecifier: spec,
          importedSymbols: importedSymbols.length > 0 ? importedSymbols : ['*'],
          aliasMap,
          isReExport: keyword === 'export',
          line,
        });
      }

      for (let i = 0; i < importLines.length; i++) {
        const line = importLines[i];
        const reqMatch = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
        if (reqMatch) {
          imports.push({
            moduleSpecifier: reqMatch[1],
            importedSymbols: ['*'],
            line: i + 1,
          });
        }
      }
      return imports;
    }

    if (language === 'rust') {
      for (let i = 0; i < importLines.length; i++) {
        const line = importLines[i].trim();
        const useMatch = /^(pub\s+)?use\s+([^;]+);/.exec(line);
        if (useMatch) {
          const isPub = Boolean(useMatch[1]);
          const expr = useMatch[2].trim();
          const groupMatch = /^([\w:]+)::\{([^}]+)\}$/.exec(expr);
          if (groupMatch) {
            const base = groupMatch[1];
            const items = groupMatch[2]
              .split(',')
              .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
              .filter((s) => s && s !== 'self');
            imports.push({
              moduleSpecifier: base,
              importedSymbols: items.length > 0 ? items : ['*'],
              isReExport: isPub,
              line: i + 1,
            });
          } else {
            const parts = expr.split('::');
            const tail = parts[parts.length - 1]?.split(/\s+as\s+/)[0].trim() || '*';
            const modSpec = parts.length > 1 ? parts.slice(0, -1).join('::') : expr;
            imports.push({
              moduleSpecifier: modSpec,
              importedSymbols: [tail === '*' ? '*' : tail],
              isReExport: isPub,
              line: i + 1,
            });
          }
        }
      }
      return imports;
    }

    if (language === 'python') {
      for (let i = 0; i < importLines.length; i++) {
        const line = importLines[i].trim();
        const fromMatch = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
        if (fromMatch) {
          const spec = fromMatch[1];
          const rawNames = fromMatch[2].replace(/[()]/g, '');
          const parsed = parseNamedList(rawNames);
          imports.push({
            moduleSpecifier: spec,
            importedSymbols: parsed.names.length > 0 ? parsed.names : ['*'],
            aliasMap: parsed.aliasMap,
            line: i + 1,
          });
          continue;
        }
        const impMatch = /^import\s+([.\w]+)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(line);
        if (impMatch) {
          imports.push({
            moduleSpecifier: impMatch[1],
            importedSymbols: ['*'],
            aliasMap: impMatch[2] ? { [impMatch[2]]: '*' } : undefined,
            line: i + 1,
          });
        }
      }
      return imports;
    }

    if (language === 'go') {
      let inImportBlock = false;
      for (let i = 0; i < importLines.length; i++) {
        const line = importLines[i].trim();
        if (/^import\s*\(/.test(line)) {
          inImportBlock = true;
          continue;
        }
        if (inImportBlock) {
          if (line.startsWith(')')) {
            inImportBlock = false;
            continue;
          }
          const pkgMatch = /^(?:([A-Za-z_.]\w*)\s+)?"([^"]+)"/.exec(line);
          if (pkgMatch) {
            imports.push({
              moduleSpecifier: pkgMatch[2],
              importedSymbols: ['*'],
              line: i + 1,
            });
          }
          continue;
        }
        const singleMatch = /^import\s+(?:([A-Za-z_.]\w*)\s+)?"([^"]+)"/.exec(line);
        if (singleMatch) {
          imports.push({
            moduleSpecifier: singleMatch[2],
            importedSymbols: ['*'],
            line: i + 1,
          });
        }
      }
    }

    return imports;
  }

  private extractDefinitions(
    blob: NormalizedSourceBlob,
    rawLines: string[],
    codeLines: string[]
  ): SymbolDefinition[] {
    const defs: SymbolDefinition[] = [];
    const pushDef = (
      name: string,
      kind: SymbolKind,
      lineIdx: number,
      endLine: number,
      exported: boolean,
      parentSymbol?: string
    ) => {
      const line = lineIdx + 1;
      defs.push({
        id: `${blob.filePath}#${kind}:${parentSymbol ? `${parentSymbol}.` : ''}${name}:${line}`,
        name,
        kind,
        filePath: blob.filePath,
        line,
        endLine: Math.max(line, endLine),
        exported,
        signature: formatCompactSignature(rawLines, lineIdx),
        parentSymbol,
        blobSha: blob.blobSha,
        commitRevision: blob.commitRevision,
      });
    };

    if (blob.language === 'typescript' || blob.language === 'javascript') {
      let activeContainer: { name: string; endLine: number; exported: boolean } | null = null;

      for (let i = 0; i < codeLines.length; i++) {
        const lineNum = i + 1;
        if (activeContainer && lineNum > activeContainer.endLine) {
          activeContainer = null;
        }
        const line = codeLines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        const isExported = /^export\b/.test(trimmed);

        const fnMatch =
          /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/.exec(
            trimmed
          );
        if (fnMatch) {
          pushDef(fnMatch[1], 'function', i, findBraceBlockEndLine(codeLines, i), isExported);
          continue;
        }

        const classMatch =
          /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/.exec(
            trimmed
          );
        if (classMatch) {
          const endLine = findBraceBlockEndLine(codeLines, i);
          pushDef(classMatch[1], 'class', i, endLine, isExported);
          activeContainer = { name: classMatch[1], endLine, exported: isExported };
          continue;
        }

        const ifaceMatch =
          /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\b/.exec(
            trimmed
          );
        if (ifaceMatch) {
          const endLine = findBraceBlockEndLine(codeLines, i);
          pushDef(ifaceMatch[1], 'interface', i, endLine, isExported);
          continue;
        }

        const typeMatch =
          /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/.exec(trimmed);
        if (typeMatch) {
          pushDef(typeMatch[1], 'type', i, findBraceBlockEndLine(codeLines, i), isExported);
          continue;
        }

        const enumMatch =
          /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/.exec(trimmed);
        if (enumMatch) {
          pushDef(enumMatch[1], 'enum', i, findBraceBlockEndLine(codeLines, i), isExported);
          continue;
        }

        if (!activeContainer) {
          const arrowOrConstMatch =
            /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(
              trimmed
            );
          if (arrowOrConstMatch) {
            pushDef(
              arrowOrConstMatch[1],
              'function',
              i,
              findBraceBlockEndLine(codeLines, i),
              isExported
            );
            continue;
          }

          const exportedConstMatch =
            /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(trimmed);
          if (exportedConstMatch) {
            pushDef(
              exportedConstMatch[1],
              'const',
              i,
              findBraceBlockEndLine(codeLines, i),
              true
            );
            continue;
          }
        } else {
          const methodMatch =
            /^(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::[^{;]+)?\{/.exec(
              trimmed
            );
          if (
            methodMatch &&
            methodMatch[1] !== 'constructor' &&
            !CONTROL_METHOD_DENYLIST.has(methodMatch[1])
          ) {
            const isPrivate = /^private\b/.test(trimmed) || methodMatch[1].startsWith('#');
            pushDef(
              methodMatch[1],
              'method',
              i,
              findBraceBlockEndLine(codeLines, i),
              activeContainer.exported && !isPrivate,
              activeContainer.name
            );
          }
        }
      }

      return defs;
    }

    if (blob.language === 'rust') {
      let activeImpl: { name: string; endLine: number } | null = null;

      for (let i = 0; i < codeLines.length; i++) {
        const lineNum = i + 1;
        if (activeImpl && lineNum > activeImpl.endLine) {
          activeImpl = null;
        }
        const trimmed = codeLines[i].trim();
        if (!trimmed) continue;

        const implMatch =
          /^impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>]*\s+for\s+)?([A-Za-z_]\w*)/.exec(trimmed);
        if (implMatch) {
          activeImpl = { name: implMatch[1], endLine: findBraceBlockEndLine(codeLines, i) };
          continue;
        }

        const isPub = /^pub(?:\s*\([^)]*\))?\s+/.test(trimmed);

        const fnMatch =
          /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+|extern\s+)*fn\s+([A-Za-z_]\w*)\b/.exec(
            trimmed
          );
        if (fnMatch) {
          pushDef(
            fnMatch[1],
            activeImpl ? 'method' : 'function',
            i,
            findBraceBlockEndLine(codeLines, i),
            isPub,
            activeImpl?.name
          );
          continue;
        }

        const structMatch = /^(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\b/.exec(trimmed);
        if (structMatch) {
          pushDef(structMatch[1], 'struct', i, findBraceBlockEndLine(codeLines, i), isPub);
          continue;
        }

        const enumMatch = /^(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\b/.exec(trimmed);
        if (enumMatch) {
          pushDef(enumMatch[1], 'enum', i, findBraceBlockEndLine(codeLines, i), isPub);
          continue;
        }

        const traitMatch = /^(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/.exec(trimmed);
        if (traitMatch) {
          pushDef(traitMatch[1], 'trait', i, findBraceBlockEndLine(codeLines, i), isPub);
          continue;
        }

        const typeMatch = /^(?:pub(?:\s*\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\b/.exec(trimmed);
        if (typeMatch) {
          pushDef(typeMatch[1], 'type', i, i + 1, isPub);
          continue;
        }

        const constMatch =
          /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)\s*:/.exec(trimmed);
        if (constMatch) {
          pushDef(constMatch[1], 'const', i, i + 1, isPub);
        }
      }
      return defs;
    }

    if (blob.language === 'python') {
      let activeClass: { name: string; indent: number; endLine: number; exported: boolean } | null =
        null;

      for (let i = 0; i < codeLines.length; i++) {
        const lineNum = i + 1;
        const line = codeLines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
        if (activeClass && (lineNum > activeClass.endLine || indent <= activeClass.indent)) {
          activeClass = null;
        }

        const classMatch = /^class\s+([A-Za-z_]\w*)\b/.exec(trimmed);
        if (classMatch) {
          const name = classMatch[1];
          const endLine = findPythonBlockEndLine(codeLines, i);
          const exported = !name.startsWith('_');
          pushDef(name, 'class', i, endLine, exported);
          activeClass = { name, indent, endLine, exported };
          continue;
        }

        const defMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed);
        if (defMatch) {
          const name = defMatch[1];
          const endLine = findPythonBlockEndLine(codeLines, i);
          if (activeClass && indent > activeClass.indent) {
            if (name !== '__init__') {
              pushDef(
                name,
                'method',
                i,
                endLine,
                activeClass.exported && !name.startsWith('_'),
                activeClass.name
              );
            }
          } else {
            pushDef(name, 'function', i, endLine, !name.startsWith('_'));
          }
          continue;
        }

        if (indent === 0) {
          const constMatch = /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/.exec(trimmed);
          if (constMatch) {
            pushDef(constMatch[1], 'const', i, i + 1, !constMatch[1].startsWith('_'));
          }
        }
      }
      return defs;
    }

    if (blob.language === 'go') {
      for (let i = 0; i < codeLines.length; i++) {
        const trimmed = codeLines[i].trim();
        if (!trimmed) continue;

        const methodMatch =
          /^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*[([]/.exec(
            trimmed
          );
        if (methodMatch) {
          const recv = methodMatch[1];
          const name = methodMatch[2];
          pushDef(
            name,
            'method',
            i,
            findBraceBlockEndLine(codeLines, i),
            /^[A-Z]/.test(name),
            recv
          );
          continue;
        }

        const fnMatch = /^func\s+([A-Za-z_]\w*)\s*[([]/.exec(trimmed);
        if (fnMatch) {
          const name = fnMatch[1];
          pushDef(name, 'function', i, findBraceBlockEndLine(codeLines, i), /^[A-Z]/.test(name));
          continue;
        }

        const structOrIfaceMatch = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(trimmed);
        if (structOrIfaceMatch) {
          const name = structOrIfaceMatch[1];
          const kind = structOrIfaceMatch[2] === 'interface' ? 'interface' : 'struct';
          pushDef(name, kind, i, findBraceBlockEndLine(codeLines, i), /^[A-Z]/.test(name));
          continue;
        }

        const typeAliasMatch = /^type\s+([A-Za-z_]\w*)\b/.exec(trimmed);
        if (typeAliasMatch) {
          const name = typeAliasMatch[1];
          pushDef(name, 'type', i, i + 1, /^[A-Z]/.test(name));
        }
      }
    }

    return defs;
  }

  private extractReferences(
    codeLines: string[],
    definitions: SymbolDefinition[]
  ): IdentifierReference[] {
    const refs: IdentifierReference[] = [];
    const defOnLine = new Map<number, Set<string>>();
    for (const def of definitions) {
      let set = defOnLine.get(def.line);
      if (!set) {
        set = new Set();
        defOnLine.set(def.line, set);
      }
      set.add(def.name);
    }

    const sortedDefs = [...definitions].sort(
      (a, b) => a.endLine - a.line - (b.endLine - b.line)
    );

    const findEnclosing = (lineNum: number): string | undefined => {
      for (const d of sortedDefs) {
        if (lineNum >= d.line && lineNum <= d.endLine) {
          return d.name;
        }
      }
      return undefined;
    };

    const identRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

    for (let i = 0; i < codeLines.length; i++) {
      const lineNum = i + 1;
      const line = codeLines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^(?:import\b|from\s+[.\w]+\s+import\b|use\s+[\w:{},\s*]+;|package\s+\w+)/.test(trimmed)) {
        continue;
      }

      const enclosing = findEnclosing(lineNum);
      const declaredHere = defOnLine.get(lineNum);

      identRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = identRe.exec(line)) !== null) {
        const name = match[1];
        if (name.length < 2 || STOP_IDENTIFIERS.has(name)) continue;
        if (declaredHere?.has(name)) {
          declaredHere.delete(name);
          continue;
        }
        const afterIdx = match.index + name.length;
        const tail = line.slice(afterIdx);
        const isCall = /^\s*(?:<[^>]{1,60}>)?\s*\(/.test(tail) || /^::/.test(tail);
        refs.push({
          name,
          line: lineNum,
          enclosingSymbol: enclosing,
          isCall,
        });
      }
    }

    return refs;
  }
}

export const defaultStructuralExtractor = new DefaultStructuralExtractor();

// ---------------------------------------------------------------------------
// Module Resolution & Symbol Graph Construction
// ---------------------------------------------------------------------------

function resolveModuleCandidates(
  fromFile: string,
  specifier: string,
  language: RepoMapLanguage,
  knownFiles: Set<string>,
  filesByDir: Map<string, string[]>
): string[] {
  const fromDir = path.posix.dirname(fromFile);
  const candidates: string[] = [];

  const tryBase = (base: string) => {
    const clean = normalizeRepoPath(base);
    if (!clean) return;
    const strippedExt = clean.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
    const probes = [
      clean,
      `${strippedExt}.ts`,
      `${strippedExt}.tsx`,
      `${strippedExt}.js`,
      `${strippedExt}.jsx`,
      `${strippedExt}.mjs`,
      `${strippedExt}/index.ts`,
      `${strippedExt}/index.tsx`,
      `${strippedExt}/index.js`,
      `${clean}.py`,
      `${clean}/__init__.py`,
      `${clean}.rs`,
      `${clean}/mod.rs`,
    ];
    for (const p of probes) {
      if (knownFiles.has(p) && !candidates.includes(p)) {
        candidates.push(p);
      }
    }
  };

  if (language === 'typescript' || language === 'javascript') {
    if (specifier.startsWith('.')) {
      tryBase(path.posix.join(fromDir, specifier));
      return candidates;
    }
    const bare = specifier.replace(/^@[^/]+\//, '');
    const pkgParts = bare.split('/');
    const pkgName = pkgParts[0];
    const subPath = pkgParts.slice(1).join('/');
    const prefixes = [
      `packages/${pkgName}/src`,
      `packages/${pkgName}`,
      `crates/${pkgName}/src`,
      `apps/${pkgName}/src`,
      `libs/${pkgName}/src`,
      `src/${pkgName}`,
    ];
    for (const pref of prefixes) {
      tryBase(subPath ? `${pref}/${subPath}` : `${pref}/index`);
    }
    return candidates;
  }

  if (language === 'rust') {
    const crateRoot = fromFile.includes('/src/')
      ? `${fromFile.slice(0, fromFile.indexOf('/src/'))}/src`
      : 'src';
    if (specifier.startsWith('crate::')) {
      const rel = specifier.slice('crate::'.length).replace(/::/g, '/');
      tryBase(`${crateRoot}/${rel}`);
    } else if (specifier.startsWith('super::')) {
      const rel = specifier.slice('super::'.length).replace(/::/g, '/');
      tryBase(path.posix.join(fromDir, '..', rel));
    } else if (specifier.startsWith('self::')) {
      const rel = specifier.slice('self::'.length).replace(/::/g, '/');
      tryBase(path.posix.join(fromDir, rel));
    } else {
      const rel = specifier.replace(/::/g, '/');
      const crateName = specifier.split('::')[0].replace(/_/g, '-');
      tryBase(`${crateRoot}/${rel}`);
      tryBase(`crates/${crateName}/src/lib`);
      if (specifier.includes('::')) {
        const sub = specifier.split('::').slice(1).join('/');
        tryBase(`crates/${crateName}/src/${sub}`);
      }
    }
    return candidates;
  }

  if (language === 'python') {
    const dotMatch = /^(\.+)(.*)$/.exec(specifier);
    if (dotMatch) {
      const upCount = Math.max(0, dotMatch[1].length - 1);
      const ups = Array.from({ length: upCount }, () => '..').join('/');
      const rest = dotMatch[2].replace(/\./g, '/');
      tryBase(path.posix.join(fromDir, ups || '.', rest));
    } else {
      const rel = specifier.replace(/\./g, '/');
      tryBase(rel);
      tryBase(`src/${rel}`);
      const parts = specifier.split('.');
      if (parts.length > 1) {
        tryBase(`packages/${parts[0]}/${parts.slice(1).join('/')}`);
        tryBase(`packages/${parts[0]}/src/${parts.join('/')}`);
      }
    }
    return candidates;
  }

  if (language === 'go') {
    const segments = specifier.split('/');
    for (let suffixLen = Math.min(segments.length, 4); suffixLen >= 1; suffixLen--) {
      const dirSuffix = segments.slice(segments.length - suffixLen).join('/');
      for (const [dir, dirFiles] of filesByDir.entries()) {
        if (dir === dirSuffix || dir.endsWith(`/${dirSuffix}`)) {
          for (const f of dirFiles) {
            if (f.endsWith('.go') && !f.endsWith('_test.go') && !candidates.includes(f)) {
              candidates.push(f);
            }
          }
        }
      }
      if (candidates.length > 0) break;
    }
  }

  return candidates;
}

function identifierSpecificityMultiplier(name: string): number {
  if (name.length <= 3) return 0.55;
  const hasCompoundCase =
    (/[a-z][A-Z]/.test(name) || name.includes('_')) && name.length >= 8;
  return hasCompoundCase ? 1.25 : 1.0;
}

export function buildSymbolGraph(
  records: SourceBlobRecord[],
  options: BuildSymbolGraphOptions = {}
): SymbolGraph {
  const startedAt = performance.now();
  const auth = authorizeSourceBlobs(records, options.accessControl);
  const customAdapters = options.adapters ?? [];
  const cache = options.cache;
  const enableHubDamping = options.enableHubDamping !== false;

  const extractedByFile = new Map<string, ExtractedFileSymbols>();
  const files = new Map<string, SymbolGraphFileNode>();
  const knownFiles = new Set<string>();
  const filesByDir = new Map<string, string[]>();

  for (const blob of auth.authorized) {
    knownFiles.add(blob.filePath);
    const dir = path.posix.dirname(blob.filePath);
    const list = filesByDir.get(dir) ?? [];
    list.push(blob.filePath);
    filesByDir.set(dir, list);

    const adapter =
      customAdapters.find((a) => a.supports(blob.language, blob.filePath)) ??
      defaultStructuralExtractor;
    const extracted = cache
      ? cache.getOrExtract(blob, adapter)
      : adapter.extract(blob);

    extractedByFile.set(blob.filePath, extracted);
    files.set(blob.filePath, {
      filePath: blob.filePath,
      language: blob.language,
      blobSha: blob.blobSha,
      commitRevision: blob.commitRevision,
      tenantId: blob.tenantId,
      definitions: extracted.definitions,
      imports: extracted.imports,
      inFileDegree: 0,
      outFileDegree: 0,
    });
  }

  const globalExportedBySymbol = new Map<string, SymbolDefinition[]>();
  const defsByFileAndName = new Map<string, Map<string, SymbolDefinition[]>>();

  for (const [filePath, ext] of extractedByFile.entries()) {
    const localMap = new Map<string, SymbolDefinition[]>();
    for (const def of ext.definitions) {
      const arr = localMap.get(def.name) ?? [];
      arr.push(def);
      localMap.set(def.name, arr);

      if (def.exported) {
        const gArr = globalExportedBySymbol.get(def.name) ?? [];
        gArr.push(def);
        globalExportedBySymbol.set(def.name, gArr);
      }
    }
    defsByFileAndName.set(filePath, localMap);
  }

  const reExportTargetsByFile = new Map<
    string,
    Array<{ targetFile: string; exportedSymbols: Set<string>; wildcard: boolean }>
  >();

  for (const [filePath, ext] of extractedByFile.entries()) {
    const entries: Array<{ targetFile: string; exportedSymbols: Set<string>; wildcard: boolean }> =
      [];
    for (const imp of ext.imports) {
      if (!imp.isReExport) continue;
      const targets = resolveModuleCandidates(
        filePath,
        imp.moduleSpecifier,
        ext.language,
        knownFiles,
        filesByDir
      );
      const wildcard = imp.importedSymbols.includes('*');
      const symSet = new Set(imp.importedSymbols.filter((s) => s !== '*'));
      for (const targetFile of targets) {
        if (targetFile !== filePath) {
          entries.push({ targetFile, exportedSymbols: symSet, wildcard });
        }
      }
    }
    if (entries.length > 0) {
      reExportTargetsByFile.set(filePath, entries);
    }
  }

  const expandImportedSymbolTargets = (
    candidateFiles: string[],
    symbolName: string
  ): SymbolDefinition[] => {
    const resolved: SymbolDefinition[] = [];
    const visited = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = candidateFiles.map((f) => ({
      file: f,
      depth: 0,
    }));

    while (queue.length > 0) {
      const { file, depth } = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const fileDefs = defsByFileAndName.get(file)?.get(symbolName);
      if (fileDefs && fileDefs.length > 0) {
        resolved.push(...fileDefs);
      } else if (symbolName === 'default') {
        const exportedDefs = extractedByFile
          .get(file)
          ?.definitions.filter((d) => d.exported);
        if (exportedDefs && exportedDefs.length > 0) {
          resolved.push(exportedDefs[0]);
        }
      }

      if (depth < 2) {
        const reExports = reExportTargetsByFile.get(file) ?? [];
        for (const re of reExports) {
          if (re.wildcard || re.exportedSymbols.has(symbolName)) {
            queue.push({ file: re.targetFile, depth: depth + 1 });
          }
        }
      }
    }

    return resolved;
  };

  const rawEdgeMap = new Map<string, SymbolGraphEdge>();
  const recordEdge = (
    fromFile: string,
    toFile: string,
    fromSymbol: string | undefined,
    toSymbol: string,
    kind: SymbolGraphEdge['kind'],
    baseWeight: number
  ) => {
    if (fromFile === toFile) return;
    const key = `${fromFile}=>${toFile}::${fromSymbol ?? '*'}::${toSymbol}`;
    const existing = rawEdgeMap.get(key);
    if (existing) {
      existing.callCount += 1;
      existing.weight += baseWeight * 0.35;
      if (kind === 'import_call' && existing.kind !== 'import_call') {
        existing.kind = 'import_call';
      }
    } else {
      rawEdgeMap.set(key, {
        fromFile,
        toFile,
        fromSymbol,
        toSymbol,
        kind,
        weight: baseWeight,
        callCount: 1,
      });
    }
  };

  for (const [fromFile, reList] of reExportTargetsByFile.entries()) {
    for (const re of reList) {
      const targetDefs = extractedByFile.get(re.targetFile)?.definitions.filter((d) => d.exported) ?? [];
      if (re.wildcard) {
        for (const d of targetDefs.slice(0, 12)) {
          recordEdge(fromFile, re.targetFile, undefined, d.name, 'reexport', 1.6);
        }
      } else {
        for (const sym of re.exportedSymbols) {
          recordEdge(fromFile, re.targetFile, undefined, sym, 'reexport', 2.0);
        }
      }
    }
  }

  for (const [fromFile, ext] of extractedByFile.entries()) {
    const localDefs = defsByFileAndName.get(fromFile) ?? new Map();
    const fromDir = path.posix.dirname(fromFile);

    const explicitImportMap = new Map<
      string,
      { targetFiles: string[]; exportedName: string }
    >();
    const wildcardImportFiles = new Set<string>();

    for (const imp of ext.imports) {
      const targetFiles = resolveModuleCandidates(
        fromFile,
        imp.moduleSpecifier,
        ext.language,
        knownFiles,
        filesByDir
      );
      if (targetFiles.length === 0) continue;

      if (imp.importedSymbols.includes('*')) {
        for (const tf of targetFiles) wildcardImportFiles.add(tf);
      }

      if (imp.aliasMap && Object.keys(imp.aliasMap).length > 0) {
        for (const [localAlias, exportedName] of Object.entries(imp.aliasMap)) {
          if (exportedName === '*') {
            for (const tf of targetFiles) wildcardImportFiles.add(tf);
          } else {
            explicitImportMap.set(localAlias, { targetFiles, exportedName });
            const resolvedDefs = expandImportedSymbolTargets(targetFiles, exportedName);
            for (const def of resolvedDefs) {
              recordEdge(fromFile, def.filePath, undefined, def.name, 'import_ref', 1.4);
            }
          }
        }
      } else {
        for (const sym of imp.importedSymbols) {
          if (sym === '*') continue;
          explicitImportMap.set(sym, { targetFiles, exportedName: sym });
          const resolvedDefs = expandImportedSymbolTargets(targetFiles, sym);
          for (const def of resolvedDefs) {
            recordEdge(fromFile, def.filePath, undefined, def.name, 'import_ref', 1.4);
          }
        }
      }
    }

    for (const ref of ext.references) {
      const specificity = identifierSpecificityMultiplier(ref.name);

      const explicit = explicitImportMap.get(ref.name);
      if (explicit) {
        const defs = expandImportedSymbolTargets(explicit.targetFiles, explicit.exportedName);
        for (const def of defs) {
          recordEdge(
            fromFile,
            def.filePath,
            ref.enclosingSymbol,
            def.name,
            ref.isCall ? 'import_call' : 'import_ref',
            (ref.isCall ? 3.2 : 1.9) * specificity
          );
        }
        continue;
      }

      if (localDefs.has(ref.name)) continue;

      if (wildcardImportFiles.size > 0) {
        const wcDefs = expandImportedSymbolTargets(Array.from(wildcardImportFiles), ref.name);
        if (wcDefs.length > 0) {
          for (const def of wcDefs) {
            recordEdge(
              fromFile,
              def.filePath,
              ref.enclosingSymbol,
              def.name,
              ref.isCall ? 'import_call' : 'import_ref',
              (ref.isCall ? 2.8 : 1.6) * specificity
            );
          }
          continue;
        }
      }

      const globalCandidates = globalExportedBySymbol.get(ref.name);
      if (!globalCandidates || globalCandidates.length === 0) continue;

      const sameDirCandidates = globalCandidates.filter(
        (d) => d.filePath !== fromFile && path.posix.dirname(d.filePath) === fromDir
      );
      if (sameDirCandidates.length > 0) {
        for (const def of sameDirCandidates) {
          recordEdge(
            fromFile,
            def.filePath,
            ref.enclosingSymbol,
            def.name,
            ref.isCall ? 'symbol_call' : 'symbol_ref',
            (ref.isCall ? 2.4 : 1.4) * specificity
          );
        }
        continue;
      }

      if (ref.name.length >= 5 && globalCandidates.length <= 6) {
        const ambiguityPenalty = 1 / globalCandidates.length;
        for (const def of globalCandidates) {
          if (def.filePath === fromFile) continue;
          recordEdge(
            fromFile,
            def.filePath,
            ref.enclosingSymbol,
            def.name,
            ref.isCall ? 'symbol_call' : 'symbol_ref',
            (ref.isCall ? 1.5 : 0.85) * specificity * ambiguityPenalty
          );
        }
      }
    }
  }

  const edges = Array.from(rawEdgeMap.values());
  const inFilesByTargetFile = new Map<string, Set<string>>();
  const outFilesBySourceFile = new Map<string, Set<string>>();
  const callerFilesByTargetSymbol = new Map<string, Set<string>>();

  for (const edge of edges) {
    const inSet = inFilesByTargetFile.get(edge.toFile) ?? new Set();
    inSet.add(edge.fromFile);
    inFilesByTargetFile.set(edge.toFile, inSet);

    const outSet = outFilesBySourceFile.get(edge.fromFile) ?? new Set();
    outSet.add(edge.toFile);
    outFilesBySourceFile.set(edge.fromFile, outSet);

    const symKey = `${edge.toFile}#${edge.toSymbol}`;
    const symCallers = callerFilesByTargetSymbol.get(symKey) ?? new Set();
    symCallers.add(edge.fromFile);
    callerFilesByTargetSymbol.set(symKey, symCallers);
  }

  for (const [fp, node] of files.entries()) {
    node.inFileDegree = inFilesByTargetFile.get(fp)?.size ?? 0;
    node.outFileDegree = outFilesBySourceFile.get(fp)?.size ?? 0;
  }

  const totalFiles = Math.max(1, files.size);
  if (enableHubDamping && totalFiles >= 5) {
    for (const edge of edges) {
      const targetInDegree = inFilesByTargetFile.get(edge.toFile)?.size ?? 1;
      const symCallerCount =
        callerFilesByTargetSymbol.get(`${edge.toFile}#${edge.toSymbol}`)?.size ?? 1;

      const ubiquityRatio = targetInDegree / totalFiles;
      const idfFactor = Math.log(1 + totalFiles / (1 + targetInDegree)) / Math.log(1 + totalFiles);
      const extraHubPenalty = ubiquityRatio > 0.25 ? 1 / (1 + 4 * (ubiquityRatio - 0.25)) : 1.0;
      const symBreadthPenalty = symCallerCount > 4 ? 1 / Math.sqrt(symCallerCount / 3) : 1.0;

      edge.weight = Number(
        (edge.weight * Math.max(0.08, idfFactor * extraHubPenalty * symBreadthPenalty)).toFixed(6)
      );
    }
  }

  edges.sort((a, b) =>
    a.fromFile !== b.fromFile
      ? a.fromFile.localeCompare(b.fromFile)
      : a.toFile !== b.toFile
        ? a.toFile.localeCompare(b.toFile)
        : a.toSymbol.localeCompare(b.toSymbol)
  );

  return {
    files,
    edges,
    totalSourceBlobs: records.length,
    authorizedBlobs: auth.authorized.length,
    excludedByAccessControl: auth.excludedCount,
    excludedByReason: auth.excludedByReason,
    buildDurationMs: performance.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic Stack-Trace & Git Diff Context Parsers
// ---------------------------------------------------------------------------

export function extractDiagnosticSpans(diagnosticText?: string): ErrorSpanSeed[] {
  if (!diagnosticText) return [];
  const spans: ErrorSpanSeed[] = [];
  const seen = new Set<string>();

  const addSpan = (rawFile: string, lineStr?: string, colStr?: string, message?: string) => {
    const cleaned = rawFile.replace(/^['"(]+|['")]+$/g, '').replace(/\\/g, '/');
    if (cleaned.startsWith('node:') || cleaned.includes('node_modules/')) return;
    const norm = normalizeRepoPath(cleaned) ?? cleaned;
    const line = lineStr ? Number.parseInt(lineStr, 10) : undefined;
    const column = colStr ? Number.parseInt(colStr, 10) : undefined;
    const key = `${norm}:${line ?? 0}:${column ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push({
      filePath: norm,
      line: Number.isFinite(line) ? line : undefined,
      column: Number.isFinite(column) ? column : undefined,
      message,
    });
  };

  const lines = diagnosticText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const pyMatch = /File\s+"([^"]+\.pyi?)",\s*line\s+(\d+)/.exec(line);
    if (pyMatch) {
      addSpan(pyMatch[1], pyMatch[2], undefined, line);
      continue;
    }

    const rustMatch = /-->\s+([^\s:]+\.rs):(\d+)(?::(\d+))?/.exec(line);
    if (rustMatch) {
      addSpan(rustMatch[1], rustMatch[2], rustMatch[3], line);
      continue;
    }

    const tscParenMatch = /([A-Za-z0-9_./\\-]+\.[A-Za-z]{1,5})\((\d+),(\d+)\)/.exec(line);
    if (tscParenMatch) {
      addSpan(tscParenMatch[1], tscParenMatch[2], tscParenMatch[3], line);
      continue;
    }

    const colonRe = /([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go)):(\d+)(?::(\d+))?/g;
    let m: RegExpExecArray | null;
    while ((m = colonRe.exec(line)) !== null) {
      addSpan(m[1], m[2], m[3], line);
    }
  }

  return spans;
}

export function extractGitDiffChanges(gitDiffText?: string): GitDiffFileChange[] {
  if (!gitDiffText) return [];
  const changesByFile = new Map<string, Array<{ startLine: number; endLine: number }>>();
  let currentFile: string | null = null;

  for (const rawLine of gitDiffText.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ ')) {
      const rawPath = rawLine.slice(4).trim();
      if (rawPath === '/dev/null') {
        currentFile = null;
        continue;
      }
      const stripped = rawPath.replace(/^b\//, '');
      currentFile = normalizeRepoPath(stripped);
      if (currentFile && !changesByFile.has(currentFile)) {
        changesByFile.set(currentFile, []);
      }
      continue;
    }

    if (currentFile && rawLine.startsWith('@@ ')) {
      const hunkMatch = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(rawLine);
      if (hunkMatch) {
        const startLine = Number.parseInt(hunkMatch[1], 10);
        const count = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
        const endLine = Math.max(startLine, startLine + Math.max(1, count) - 1);
        changesByFile.get(currentFile)!.push({ startLine, endLine });
      }
    }
  }

  return Array.from(changesByFile.entries()).map(([filePath, changedRanges]) => ({
    filePath,
    changedRanges,
  }));
}

// ---------------------------------------------------------------------------
// Tokenization & Seed Matching Helpers
// ---------------------------------------------------------------------------

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'where', 'what',
  'which', 'while', 'should', 'would', 'could', 'have', 'does', 'need', 'make', 'fix',
  'bug', 'issue', 'error', 'fail', 'fails', 'failing', 'test', 'tests', 'update', 'add',
  'remove', 'change', 'refactor', 'implement', 'file', 'files', 'code', 'function',
  'method', 'class', 'module', 'package', 'service', 'handler', 'index', 'main', 'src',
]);

export function splitIdentifierSubtokens(raw: string): string[] {
  const expanded = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase();
  return expanded
    .split(/\s+/)
    .filter(
      (tok) =>
        (tok.length >= 3 || /^\d{2,}$/.test(tok)) && !QUERY_STOPWORDS.has(tok)
    );
}

function matchGraphFilePath(rawCandidate: string, knownFiles: string[]): string[] {
  const cleaned = rawCandidate.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (!cleaned) return [];
  const exact = knownFiles.filter((f) => f === cleaned);
  if (exact.length > 0) return exact;
  return knownFiles.filter((f) => f.endsWith(`/${cleaned}`) || cleaned.endsWith(`/${f}`));
}

function isTestFilePath(filePath: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|__tests__|spec|fixtures|bench)\//.test(filePath) ||
    /\.(?:test|spec)\.[A-Za-z]+$/.test(filePath) ||
    filePath.endsWith('_test.go')
  );
}

// ---------------------------------------------------------------------------
// Personalized PageRank Symbol Graph Ranker
// ---------------------------------------------------------------------------

export function rankSymbolGraph(
  graph: SymbolGraph,
  context: RepoMapQueryContext = {},
  options: RankSymbolGraphOptions = {}
): RankedSymbolGraph {
  const startedAt = performance.now();
  const alpha = options.dampingFactor ?? 0.85;
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error(`Invalid dampingFactor ${alpha}: must lie strictly in (0, 1).`);
  }
  const maxIterations = Math.max(1, options.maxIterations ?? 100);
  const tolerance = options.tolerance ?? 1e-7;
  const reverseEdgeFactor = options.reverseEdgeFactor ?? 0.55;

  const fileList = Array.from(graph.files.keys()).sort((a, b) => a.localeCompare(b));
  const numFiles = fileList.length;
  const parsedDiagnosticSpans = extractDiagnosticSpans(context.diagnosticText);
  const allErrorSpans = [...(context.errorSpans ?? []), ...parsedDiagnosticSpans];
  const parsedDiffChanges = extractGitDiffChanges(context.gitDiffText);

  if (numFiles === 0) {
    return {
      rankedFiles: [],
      iterations: 0,
      residual: 0,
      converged: true,
      extractedErrorSpans: allErrorSpans,
      extractedDiffChanges: parsedDiffChanges,
      rankDurationMs: performance.now() - startedAt,
    };
  }

  const fileIdx = new Map<string, number>();
  fileList.forEach((fp, idx) => fileIdx.set(fp, idx));

  const rawPersonalization = new Float64Array(numFiles);
  const seedReasonsByFile = new Map<string, Set<string>>();
  const explicitlySeededFiles = new Set<string>();
  const directSymbolBoost = new Map<string, { boost: number; reasons: Set<string> }>();

  const addFileReason = (fp: string, reason: string) => {
    let set = seedReasonsByFile.get(fp);
    if (!set) {
      set = new Set();
      seedReasonsByFile.set(fp, set);
    }
    set.add(reason);
  };

  const addSymBoost = (symId: string, delta: number, reason: string) => {
    const cur = directSymbolBoost.get(symId);
    if (cur) {
      cur.boost += delta;
      cur.reasons.add(reason);
    } else {
      directSymbolBoost.set(symId, { boost: delta, reasons: new Set([reason]) });
    }
  };

  // 1. Active open files seed
  for (const rawActive of context.activeFiles ?? []) {
    for (const fp of matchGraphFilePath(rawActive, fileList)) {
      const idx = fileIdx.get(fp)!;
      rawPersonalization[idx] += 10.0;
      explicitlySeededFiles.add(fp);
      addFileReason(fp, 'active_file');
    }
  }

  // 2. Stack-trace / compiler diagnostic error spans seed
  for (const span of allErrorSpans) {
    for (const fp of matchGraphFilePath(span.filePath, fileList)) {
      const idx = fileIdx.get(fp)!;
      rawPersonalization[idx] += 14.0;
      explicitlySeededFiles.add(fp);
      addFileReason(fp, span.line ? `error_span:${span.line}` : 'error_span');

      const node = graph.files.get(fp)!;
      for (const def of node.definitions) {
        if (
          (span.line !== undefined && span.line >= def.line && span.line <= def.endLine) ||
          (span.symbolName && def.name === span.symbolName)
        ) {
          addSymBoost(def.id, 8.0, `error_line:${span.line ?? def.line}`);
        }
      }
    }
  }

  // 3. Recent git diff paths & modified line hunks seed
  const diffPathSet = new Set<string>();
  for (const rawDiffPath of context.gitDiffPaths ?? []) {
    for (const fp of matchGraphFilePath(rawDiffPath, fileList)) {
      diffPathSet.add(fp);
    }
  }
  const diffRangesByFile = new Map<string, Array<{ startLine: number; endLine: number }>>();
  for (const change of parsedDiffChanges) {
    for (const fp of matchGraphFilePath(change.filePath, fileList)) {
      diffPathSet.add(fp);
      diffRangesByFile.set(fp, change.changedRanges);
    }
  }
  for (const fp of diffPathSet) {
    const idx = fileIdx.get(fp)!;
    rawPersonalization[idx] += 8.0;
    explicitlySeededFiles.add(fp);
    addFileReason(fp, 'git_diff');

    const ranges = diffRangesByFile.get(fp);
    if (ranges && ranges.length > 0) {
      const node = graph.files.get(fp)!;
      for (const def of node.definitions) {
        const overlaps = ranges.some(
          (r) => r.startLine <= def.endLine && r.endLine >= def.line
        );
        if (overlaps) {
          addSymBoost(def.id, 5.0, 'git_diff_hunk');
        }
      }
    }
  }

  // 4. Explicit mentioned symbols + identifiers inside taskQuery
  const explicitSymbols = new Set<string>(context.mentionedSymbols ?? []);
  if (context.taskQuery) {
    const camelOrSnakeMatches =
      context.taskQuery.match(
        /\b(?:[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g
      ) ?? [];
    for (const tok of camelOrSnakeMatches) {
      explicitSymbols.add(tok);
    }
  }

  if (explicitSymbols.size > 0) {
    for (const symName of explicitSymbols) {
      const matchingFiles: string[] = [];
      for (const [fp, node] of graph.files.entries()) {
        if (node.definitions.some((d) => d.name === symName)) {
          matchingFiles.push(fp);
        }
      }
      if (matchingFiles.length > 0) {
        const specificityBoost = 9.0 / Math.sqrt(matchingFiles.length);
        for (const fp of matchingFiles) {
          rawPersonalization[fileIdx.get(fp)!] += specificityBoost;
          addFileReason(fp, `symbol:${symName}`);
          for (const def of graph.files.get(fp)!.definitions) {
            if (def.name === symName) {
              addSymBoost(def.id, 6.0, `mentioned:${symName}`);
            }
          }
        }
      }
    }
  }

  // 5. Task description sub-token IDF matching over file paths and symbol names
  const querySubtokens = Array.from(new Set(splitIdentifierSubtokens(context.taskQuery ?? '')));
  if (querySubtokens.length > 0) {
    const fileSubtokens: Array<Set<string>> = fileList.map((fp) => {
      const node = graph.files.get(fp)!;
      const bag = new Set<string>(splitIdentifierSubtokens(fp));
      for (const def of node.definitions) {
        for (const t of splitIdentifierSubtokens(def.name)) bag.add(t);
      }
      return bag;
    });

    const docFreq = new Map<string, number>();
    for (const qTok of querySubtokens) {
      let df = 0;
      for (const bag of fileSubtokens) {
        if (bag.has(qTok)) df++;
      }
      docFreq.set(qTok, df);
    }

    for (let i = 0; i < numFiles; i++) {
      const fp = fileList[i];
      const bag = fileSubtokens[i];
      let lexicalScore = 0;
      for (const qTok of querySubtokens) {
        const df = docFreq.get(qTok) ?? 0;
        if (df > 0 && bag.has(qTok)) {
          const idf = Math.log(1 + numFiles / df);
          lexicalScore += idf;
        }
      }
      if (lexicalScore > 0) {
        rawPersonalization[i] += Math.min(6.5, lexicalScore * 1.35);
        addFileReason(fp, 'task_terms');

        const node = graph.files.get(fp)!;
        for (const def of node.definitions) {
          const defToks = splitIdentifierSubtokens(def.name);
          let symLex = 0;
          for (const t of defToks) {
            if (querySubtokens.includes(t)) {
              const df = Math.max(1, docFreq.get(t) ?? 1);
              symLex += Math.log(1 + numFiles / df);
            }
          }
          if (symLex > 0) {
            addSymBoost(def.id, Math.min(4.0, symLex), 'task_term');
          }
        }
      }
    }
  }

  for (let i = 0; i < numFiles; i++) {
    const fp = fileList[i];
    if (!explicitlySeededFiles.has(fp) && isTestFilePath(fp)) {
      rawPersonalization[i] *= 0.55;
    }
  }

  const personalization = new Float64Array(numFiles);
  let totalSeedMass = 0;
  for (let i = 0; i < numFiles; i++) totalSeedMass += rawPersonalization[i];

  if (totalSeedMass > 0) {
    for (let i = 0; i < numFiles; i++) {
      personalization[i] = rawPersonalization[i] / totalSeedMass;
    }
  } else {
    const uniform = 1 / numFiles;
    for (let i = 0; i < numFiles; i++) personalization[i] = uniform;
  }

  // Stochastic hub-retention factor: ubiquitous non-seed utility files (imported by
  // >15% of workspace files and >=4 callers) retain 1/(1 + inFileDegree) of incoming
  // walk mass and teleport the remainder back to context seeds, conserving total mass 1.0.
  const nodeRetention = new Float64Array(numFiles);
  for (let i = 0; i < numFiles; i++) {
    const fp = fileList[i];
    const node = graph.files.get(fp)!;
    if (
      !explicitlySeededFiles.has(fp) &&
      numFiles >= 5 &&
      node.inFileDegree >= 4 &&
      node.inFileDegree / numFiles > 0.15
    ) {
      nodeRetention[i] = 1 / (1 + node.inFileDegree);
    } else {
      nodeRetention[i] = 1.0;
    }
  }

  const adjMaps: Array<Map<number, number>> = Array.from({ length: numFiles }, () => new Map());
  const outWeights = new Float64Array(numFiles);

  const addDirectedWeight = (u: number, v: number, w: number) => {
    if (u === v || w <= 0) return;
    const prev = adjMaps[u].get(v) ?? 0;
    adjMaps[u].set(v, prev + w);
    outWeights[u] += w;
  };

  for (const edge of graph.edges) {
    const u = fileIdx.get(edge.fromFile);
    const v = fileIdx.get(edge.toFile);
    if (u === undefined || v === undefined) continue;

    let contextEdgeMultiplier = 1.0;
    if (edge.fromSymbol) {
      const fromNode = graph.files.get(edge.fromFile);
      const matchingSourceDef = fromNode?.definitions.find((d) => d.name === edge.fromSymbol);
      if (matchingSourceDef && directSymbolBoost.has(matchingSourceDef.id)) {
        contextEdgeMultiplier = 2.2;
      }
    }

    const forwardW = edge.weight * contextEdgeMultiplier;
    addDirectedWeight(u, v, forwardW);
    if (reverseEdgeFactor > 0) {
      const targetTestPenalty =
        !explicitlySeededFiles.has(edge.fromFile) && isTestFilePath(edge.fromFile) ? 0.35 : 1.0;
      addDirectedWeight(v, u, edge.weight * reverseEdgeFactor * targetTestPenalty);
    }
  }

  let scores = new Float64Array(personalization);
  let nextScores = new Float64Array(numFiles);
  let iterations = 0;
  let residual = 1.0;
  let converged = false;

  while (iterations < maxIterations) {
    iterations++;

    let danglingMass = 0;
    for (let i = 0; i < numFiles; i++) {
      if (outWeights[i] === 0) {
        danglingMass += scores[i];
      }
    }

    nextScores.fill(0);
    let hubTeleportMass = 0;

    for (let u = 0; u < numFiles; u++) {
      const totalOut = outWeights[u];
      if (totalOut <= 0) continue;
      const scale = (alpha * scores[u]) / totalOut;
      for (const [v, w] of adjMaps[u].entries()) {
        const rawFlow = scale * w;
        const retained = rawFlow * nodeRetention[v];
        nextScores[v] += retained;
        hubTeleportMass += rawFlow - retained;
      }
    }

    const teleportFactor = 1 - alpha + alpha * danglingMass + hubTeleportMass;
    for (let i = 0; i < numFiles; i++) {
      nextScores[i] += teleportFactor * personalization[i];
    }

    let l1Diff = 0;
    for (let i = 0; i < numFiles; i++) {
      l1Diff += Math.abs(nextScores[i] - scores[i]);
    }
    residual = l1Diff;

    const swap = scores;
    scores = nextScores;
    nextScores = swap;

    if (l1Diff < tolerance) {
      converged = true;
      break;
    }
  }

  const incomingByFileAndSym = new Map<string, SymbolGraphEdge[]>();
  const outgoingByFileAndSym = new Map<string, SymbolGraphEdge[]>();

  for (const edge of graph.edges) {
    const inKey = `${edge.toFile}#${edge.toSymbol}`;
    const inArr = incomingByFileAndSym.get(inKey) ?? [];
    inArr.push(edge);
    incomingByFileAndSym.set(inKey, inArr);

    const outKey = `${edge.fromFile}#${edge.fromSymbol ?? '*'}`;
    const outArr = outgoingByFileAndSym.get(outKey) ?? [];
    outArr.push(edge);
    outgoingByFileAndSym.set(outKey, outArr);
  }

  const rankedFiles: RankedFileEntry[] = fileList.map((fp, i) => {
    const node = graph.files.get(fp)!;
    const filePr = scores[i];
    const fileReasons = Array.from(seedReasonsByFile.get(fp) ?? []);

    const rankedSyms: RankedSymbolEntry[] = node.definitions.map((def) => {
      const incoming = incomingByFileAndSym.get(`${fp}#${def.name}`) ?? [];
      const outgoing = outgoingByFileAndSym.get(`${fp}#${def.name}`) ?? [];

      let incomingPrContribution = 0;
      for (const edge of incoming) {
        const callerPr = scores[fileIdx.get(edge.fromFile)!] ?? 0;
        incomingPrContribution += callerPr * edge.weight;
      }

      let outgoingPrContribution = 0;
      for (const edge of outgoing) {
        const calleePr = scores[fileIdx.get(edge.toFile)!] ?? 0;
        outgoingPrContribution += calleePr * edge.weight * 0.65;
      }

      const direct = directSymbolBoost.get(def.id);
      const exportMultiplier = def.exported ? 1.2 : 0.85;
      const symScore =
        (filePr * (1.0 + (direct ? direct.boost * 0.35 : 0)) +
          incomingPrContribution * 1.4 +
          outgoingPrContribution * 0.9) *
        exportMultiplier;

      const sortedOutgoing = [...outgoing]
        .sort((a, b) => {
          const scoreB = (scores[fileIdx.get(b.toFile)!] ?? 0) * b.weight;
          const scoreA = (scores[fileIdx.get(a.toFile)!] ?? 0) * a.weight;
          return scoreB !== scoreA ? scoreB - scoreA : a.toFile.localeCompare(b.toFile);
        })
        .map((e) => ({ toFile: e.toFile, toSymbol: e.toSymbol, weight: e.weight }));

      const sortedIncoming = [...incoming]
        .sort((a, b) => {
          const scoreB = (scores[fileIdx.get(b.fromFile)!] ?? 0) * b.weight;
          const scoreA = (scores[fileIdx.get(a.fromFile)!] ?? 0) * a.weight;
          return scoreB !== scoreA ? scoreB - scoreA : a.fromFile.localeCompare(b.fromFile);
        })
        .map((e) => ({ fromFile: e.fromFile, fromSymbol: e.fromSymbol, weight: e.weight }));

      return {
        symbol: def,
        score: symScore,
        seedReasons: direct ? Array.from(direct.reasons) : [],
        outgoingTargets: sortedOutgoing,
        incomingCallers: sortedIncoming,
      };
    });

    rankedSyms.sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.symbol.line !== b.symbol.line
          ? a.symbol.line - b.symbol.line
          : a.symbol.name.localeCompare(b.symbol.name)
    );

    return {
      filePath: fp,
      language: node.language,
      blobSha: node.blobSha,
      commitRevision: node.commitRevision,
      pageRankScore: filePr,
      personalizationWeight: personalization[i],
      seedReasons: fileReasons,
      symbols: rankedSyms,
    };
  });

  rankedFiles.sort((a, b) =>
    b.pageRankScore !== a.pageRankScore
      ? b.pageRankScore - a.pageRankScore
      : a.filePath.localeCompare(b.filePath)
  );

  return {
    rankedFiles,
    iterations,
    residual,
    converged,
    extractedErrorSpans: allErrorSpans,
    extractedDiffChanges: parsedDiffChanges,
    rankDurationMs: performance.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Token-Budgeted Compact RepoMap Renderer (Binary Search + Rank-Prefix Packing)
// ---------------------------------------------------------------------------

interface CandidateRenderAtom {
  filePath: string;
  fileHeader: string;
  symbolId?: string;
  symbolBlock?: string;
  edgeCount: number;
  priority: number;
}

export function renderRepoMap(
  ranked: RankedSymbolGraph,
  options: RenderRepoMapOptions = {}
): RenderedRepoMap {
  const startedAt = performance.now();
  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? 1024));
  const countTokens = options.tokenCounter ?? estimateRepoMapTokens;
  const maxSymbolsPerFile = Math.max(1, options.maxSymbolsPerFile ?? 8);
  const rawMaxEdges = Math.max(0, options.maxEdgesPerSymbol ?? 2);
  const maxEdgesPerSymbol = maxTokens <= 160 ? Math.min(rawMaxEdges, 1) : rawMaxEdges;
  const includeHeader = options.includeHeader !== false;
  const includeScores = options.includeScores !== false;

  if (ranked.rankedFiles.length === 0) {
    return {
      text: '',
      includedFiles: [],
      includedSymbols: [],
      renderedEdges: 0,
      estimatedTokens: 0,
      maxTokens,
      renderDurationMs: performance.now() - startedAt,
    };
  }

  const atoms: CandidateRenderAtom[] = [];

  for (let fIdx = 0; fIdx < ranked.rankedFiles.length; fIdx++) {
    const file = ranked.rankedFiles[fIdx];
    const scoreTag = includeScores ? ` [score=${file.pageRankScore.toFixed(3)}]` : '';
    const seedTag =
      file.seedReasons.length > 0 ? ` (${file.seedReasons.slice(0, 2).join(', ')})` : '';
    const fileHeader = `${file.filePath}${scoreTag}${seedTag}`;

    const topSymbols = file.symbols.slice(0, maxSymbolsPerFile);
    if (topSymbols.length === 0) {
      atoms.push({
        filePath: file.filePath,
        fileHeader,
        edgeCount: 0,
        priority: file.pageRankScore * 0.6,
      });
      continue;
    }

    const maxSymScore = Math.max(1e-12, topSymbols[0].score);

    for (let sIdx = 0; sIdx < topSymbols.length; sIdx++) {
      const entry = topSymbols[sIdx];
      const tierDecay = 1 / (1 + sIdx * 0.5);
      const relSymWeight = Math.min(1, Math.max(0, entry.score / maxSymScore));
      const lines: string[] = [`  ${entry.symbol.line}: ${entry.symbol.signature}`];
      let edgeCount = 0;

      if (maxEdgesPerSymbol > 0) {
        const seenEdges = new Set<string>();
        for (const out of entry.outgoingTargets) {
          if (edgeCount >= maxEdgesPerSymbol) break;
          const label = `-> ${out.toFile}#${out.toSymbol}`;
          if (seenEdges.has(label)) continue;
          seenEdges.add(label);
          lines.push(`      ${label}`);
          edgeCount++;
        }
        for (const inc of entry.incomingCallers) {
          if (edgeCount >= maxEdgesPerSymbol) break;
          const callerSuffix = inc.fromSymbol ? `#${inc.fromSymbol}` : '';
          const label = `<- ${inc.fromFile}${callerSuffix}`;
          if (seenEdges.has(label)) continue;
          seenEdges.add(label);
          lines.push(`      ${label}`);
          edgeCount++;
        }
      }

      atoms.push({
        filePath: file.filePath,
        fileHeader,
        symbolId: entry.symbol.id,
        symbolBlock: lines.join('\n'),
        edgeCount,
        priority: file.pageRankScore * tierDecay * (0.75 + 0.25 * relSymWeight),
      });
    }
  }

  atoms.sort((a, b) =>
    b.priority !== a.priority
      ? b.priority - a.priority
      : a.filePath !== b.filePath
        ? a.filePath.localeCompare(b.filePath)
        : (a.symbolId ?? '').localeCompare(b.symbolId ?? '')
  );

  const fileRankOrder = new Map<string, number>();
  ranked.rankedFiles.forEach((f, idx) => fileRankOrder.set(f.filePath, idx));

  const assembleSubset = (selectedIndices: Set<number>): {
    text: string;
    files: string[];
    symbols: string[];
    edges: number;
  } => {
    const byFile = new Map<
      string,
      { header: string; blocks: string[]; symbolIds: string[]; edges: number }
    >();

    for (let idx = 0; idx < atoms.length; idx++) {
      if (!selectedIndices.has(idx)) continue;
      const atom = atoms[idx];
      let group = byFile.get(atom.filePath);
      if (!group) {
        group = { header: atom.fileHeader, blocks: [], symbolIds: [], edges: 0 };
        byFile.set(atom.filePath, group);
      }
      if (atom.symbolBlock && atom.symbolId) {
        group.blocks.push(atom.symbolBlock);
        group.symbolIds.push(atom.symbolId);
      }
      group.edges += atom.edgeCount;
    }

    const orderedFiles = Array.from(byFile.keys()).sort(
      (a, b) => (fileRankOrder.get(a) ?? 0) - (fileRankOrder.get(b) ?? 0)
    );

    const sections: string[] = [];
    const allSymbols: string[] = [];
    let totalEdges = 0;

    for (const fp of orderedFiles) {
      const g = byFile.get(fp)!;
      if (g.blocks.length > 0) {
        sections.push(`${g.header}\n${g.blocks.join('\n')}`);
      } else {
        sections.push(g.header);
      }
      allSymbols.push(...g.symbolIds);
      totalEdges += g.edges;
    }

    const body = sections.join('\n\n');
    if (!body) {
      return { text: '', files: [], symbols: [], edges: 0 };
    }

    if (includeHeader) {
      const header = `# RepoMap (${orderedFiles.length}/${ranked.rankedFiles.length} files, ${allSymbols.length} symbols)`;
      const withHeader = `${header}\n${body}`;
      if (countTokens(withHeader) <= maxTokens) {
        return { text: withHeader, files: orderedFiles, symbols: allSymbols, edges: totalEdges };
      }
    }

    return { text: body, files: orderedFiles, symbols: allSymbols, edges: totalEdges };
  };

  let lo = 0;
  let hi = atoms.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const prefixSet = new Set<number>();
    for (let i = 0; i < mid; i++) prefixSet.add(i);
    const candidate = assembleSubset(prefixSet);
    if (countTokens(candidate.text) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const chosen = new Set<number>();
  for (let i = 0; i < lo; i++) chosen.add(i);

  let bestRender = assembleSubset(chosen);
  for (let i = lo; i < atoms.length; i++) {
    if (chosen.size === 0 && i > 12) break;
    chosen.add(i);
    const nextRender = assembleSubset(chosen);
    if (countTokens(nextRender.text) <= maxTokens) {
      bestRender = nextRender;
    } else {
      chosen.delete(i);
    }
  }

  if (bestRender.files.length === 0 && ranked.rankedFiles.length > 0) {
    const topPath = ranked.rankedFiles[0].filePath;
    let fallback = topPath;
    while (fallback.length > 0 && countTokens(fallback) > maxTokens) {
      fallback = fallback.slice(0, Math.max(0, fallback.length - 4));
    }
    const estimated = countTokens(fallback);
    return {
      text: fallback,
      includedFiles: fallback.length > 0 ? [topPath] : [],
      includedSymbols: [],
      renderedEdges: 0,
      estimatedTokens: estimated,
      maxTokens,
      renderDurationMs: performance.now() - startedAt,
    };
  }

  return {
    text: bestRender.text,
    includedFiles: bestRender.files,
    includedSymbols: bestRender.symbols,
    renderedEdges: bestRender.edges,
    estimatedTokens: countTokens(bestRender.text),
    maxTokens,
    renderDurationMs: performance.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// End-to-End RepoMap Pipeline & Filesystem Workspace Scanner
// ---------------------------------------------------------------------------

export function generateRepoMap(
  records: SourceBlobRecord[],
  context: RepoMapQueryContext = {},
  options: GenerateRepoMapOptions = {}
): RepoMapResult {
  const totalStart = performance.now();
  const effectiveAcl = context.accessControl ?? options.accessControl;

  const graph = buildSymbolGraph(records, {
    accessControl: effectiveAcl,
    adapters: options.adapters,
    cache: options.cache,
    enableHubDamping: options.enableHubDamping,
  });

  const ranked = rankSymbolGraph(graph, context, {
    dampingFactor: options.dampingFactor,
    maxIterations: options.maxIterations,
    tolerance: options.tolerance,
    reverseEdgeFactor: options.reverseEdgeFactor,
  });

  const rendered = renderRepoMap(ranked, {
    maxTokens: options.maxTokens,
    tokenCounter: options.tokenCounter,
    maxSymbolsPerFile: options.maxSymbolsPerFile,
    maxEdgesPerSymbol: options.maxEdgesPerSymbol,
    includeHeader: options.includeHeader,
    includeScores: options.includeScores,
  });

  const totalLatencyMs = performance.now() - totalStart;

  return {
    text: rendered.text,
    includedFiles: rendered.includedFiles,
    includedSymbols: rendered.includedSymbols,
    rankedFiles: ranked.rankedFiles,
    graph,
    metrics: {
      totalSourceFiles: graph.totalSourceBlobs,
      authorizedFiles: graph.authorizedBlobs,
      excludedByAccessControl: graph.excludedByAccessControl,
      renderedFiles: rendered.includedFiles.length,
      renderedSymbols: rendered.includedSymbols.length,
      renderedEdges: rendered.renderedEdges,
      estimatedTokens: rendered.estimatedTokens,
      maxTokens: rendered.maxTokens,
      budgetUtilization:
        rendered.maxTokens > 0
          ? Number((rendered.estimatedTokens / rendered.maxTokens).toFixed(4))
          : 0,
      pprIterations: ranked.iterations,
      pprResidual: ranked.residual,
      pprConverged: ranked.converged,
      graphBuildMs: graph.buildDurationMs,
      rankMs: ranked.rankDurationMs,
      renderMs: rendered.renderDurationMs,
      totalLatencyMs,
    },
  };
}

const DEFAULT_INCLUDE_GLOBS = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.rs',
  '**/*.py',
  '**/*.go',
];

const DEFAULT_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.git/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.d.ts',
];

export async function scanWorkspaceSourceBlobs(
  rootDir: string,
  options: WorkspaceScanOptions = {}
): Promise<SourceBlobRecord[]> {
  const resolvedRoot = path.resolve(rootDir);
  const includePatterns = options.includePatterns ?? DEFAULT_INCLUDE_GLOBS;
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_GLOBS;
  const maxFiles = options.maxFiles ?? 2000;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;

  const matchedPaths = new Set<string>();
  for (const pat of includePatterns) {
    const found = await glob(pat, {
      cwd: resolvedRoot,
      ignore: ignorePatterns,
      nodir: true,
      posix: true,
    });
    for (const rel of found) {
      matchedPaths.add(rel);
      if (matchedPaths.size >= maxFiles) break;
    }
    if (matchedPaths.size >= maxFiles) break;
  }

  const sortedRelPaths = Array.from(matchedPaths).sort((a, b) => a.localeCompare(b));
  const blobs: SourceBlobRecord[] = [];
  const realRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);

  for (const relPath of sortedRelPaths) {
    const norm = normalizeRepoPath(relPath);
    if (!norm) continue;
    const absPath = path.join(resolvedRoot, norm);
    const realFile = await fs.realpath(absPath).catch(() => null);
    if (!realFile || (!realFile.startsWith(`${realRoot}${path.sep}`) && realFile !== realRoot)) {
      continue;
    }

    const stat = await fs.stat(realFile).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > maxFileBytes) continue;

    const content = await fs.readFile(realFile, 'utf8').catch(() => null);
    if (content === null) continue;

    blobs.push({
      filePath: norm,
      content,
      blobSha: computeBlobSha(content),
      commitRevision: options.commitRevision ?? 'working-tree',
      tenantId: options.tenantId,
      allowedRoles: options.allowedRoles,
      aclTags: options.aclTags,
    });
  }

  return blobs;
}

export async function generateWorkspaceRepoMap(
  rootDir: string,
  context: RepoMapQueryContext = {},
  options: WorkspaceRepoMapOptions = {}
): Promise<RepoMapResult> {
  const blobs = await scanWorkspaceSourceBlobs(rootDir, options);
  return generateRepoMap(blobs, context, options);
}
