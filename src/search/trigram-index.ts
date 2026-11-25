/**
 * Clean-room incremental trigram code search engine (HIP-1347).
 *
 * Design references (clean-room TypeScript implementation; no third-party code copied):
 * - Zoekt (Apache-2.0): trigram inverted index, branch-shared content postings,
 *   filename/symbol/regex literal planning, exact-match fast path.
 * - Tantivy (MIT): rebuildable derived inverted-index architecture over immutable
 *   canonical source records.
 *
 * Shared retrieval invariants enforced here:
 * 1. Canonical source blobs carry stable `(tenantId, repoId, branch, path, blobSha256, version)`.
 *    All trigram, path, and symbol indexes are DERIVED representations that can be wiped
 *    and rebuilt bit-identically from canonical blobs without losing source records.
 * 2. Tenant & ACL filters (`TrigramAccessContext`) are applied BEFORE reading file content,
 *    counting candidates, or returning any hit. Tenant isolation is never relaxed for speed.
 * 3. Exact literal and exact symbol queries always keep an exact-match fast path at rank #1;
 *    optional hybrid semantic scoring only breaks ties within lower lexical/IDF bands.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SupportedSearchLanguage =
  | 'typescript'
  | 'javascript'
  | 'rust'
  | 'go'
  | 'python'
  | 'cuda'
  | 'yaml'
  | 'toml'
  | 'markdown'
  | 'text';

export type TrigramQueryKind = 'exact' | 'regex' | 'symbol' | 'path' | 'hybrid';

export type TrigramHitMark = 'exact' | 'regex' | 'definition' | 'reference' | 'path' | 'hybrid';

/** Stable identity & version of a canonical source blob. */
export interface TrigramBlobIdentity {
  readonly tenantId: string;
  readonly repoId: string;
  readonly branch: string;
  readonly path: string;
  readonly blobSha256: string;
  readonly version: number;
  readonly aclScope: readonly string[];
  readonly language: SupportedSearchLanguage;
}

/** Input payload for indexing or upserting a source blob. */
export interface TrigramSourceBlobInput {
  tenantId: string;
  repoId: string;
  branch: string;
  path: string;
  content: string;
  aclScope?: string[];
  version?: number;
  language?: SupportedSearchLanguage;
  blobSha256?: string;
}

/** Canonical stored blob record; derived index state is always rebuildable from this. */
export interface CanonicalTrigramBlob extends TrigramBlobIdentity {
  readonly content: string;
  readonly lineCount: number;
  readonly byteLength: number;
}

/** Mandatory access-control context evaluated BEFORE any hit or count is computed. */
export interface TrigramAccessContext {
  readonly tenantId: string;
  readonly allowedScopes: readonly string[];
  readonly allowedRepos?: readonly string[];
  readonly branch?: string;
}

export interface TrigramSymbolSpan {
  readonly name: string;
  readonly lowerName: string;
  readonly kind: 'function' | 'class' | 'struct' | 'interface' | 'type' | 'enum' | 'const' | 'macro' | 'key';
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

export interface TrigramQueryOptions {
  readonly query: string;
  readonly kind?: TrigramQueryKind;
  readonly caseSensitive?: boolean;
  readonly pathGlob?: string;
  readonly languages?: readonly SupportedSearchLanguage[];
  readonly contextLines?: number;
  readonly limit?: number;
  readonly perFileLimit?: number;
  readonly semanticBoostWeight?: number;
  readonly access: TrigramAccessContext;
}

export interface TrigramSearchHit {
  readonly tenantId: string;
  readonly repoId: string;
  readonly branch: string;
  readonly path: string;
  readonly blobSha256: string;
  readonly version: number;
  readonly language: SupportedSearchLanguage;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
  readonly mark: TrigramHitMark;
  readonly score: number;
  readonly exactMatch: boolean;
  readonly symbolKind?: TrigramSymbolSpan['kind'];
}

export interface TrigramQueryPlan {
  readonly mode: 'and' | 'or' | 'scan_fallback';
  readonly selective: boolean;
  readonly branches: readonly (readonly string[])[];
  readonly trigramCount: number;
  readonly reason: string;
}

export interface TrigramQueryStats {
  readonly elapsedMs: number;
  readonly authorizedDocs: number;
  readonly candidateDocs: number;
  readonly verifiedDocs: number;
  readonly totalHitsBeforeLimit: number;
  readonly usedFastPath: boolean;
  readonly plan: TrigramQueryPlan;
}

export interface TrigramSearchResponse {
  readonly hits: readonly TrigramSearchHit[];
  readonly stats: TrigramQueryStats;
}

export interface IncrementalUpdateResult {
  readonly action: 'inserted' | 'updated' | 'unchanged';
  readonly docId: number;
  readonly blobSha256: string;
  readonly trigramsIndexed: number;
  readonly symbolsIndexed: number;
  readonly elapsedMs: number;
}

export interface BranchDeltaInput {
  readonly tenantId: string;
  readonly repoId: string;
  readonly baseBranch: string;
  readonly targetBranch: string;
  readonly upserts: readonly Omit<TrigramSourceBlobInput, 'tenantId' | 'repoId' | 'branch'>[];
  readonly deletes: readonly string[];
}

export interface BranchDeltaResult {
  readonly targetBranch: string;
  readonly carriedUnchanged: number;
  readonly upserted: number;
  readonly deleted: number;
  readonly elapsedMs: number;
}

export interface IndexDirectoryOptions {
  readonly tenantId: string;
  readonly repoId: string;
  readonly branch: string;
  readonly aclScope?: string[];
  readonly maxFileBytes?: number;
  readonly skipDirs?: readonly string[];
}

export interface IndexDirectoryStats {
  readonly resolvedRoot: string;
  readonly filesIndexed: number;
  readonly filesUnchanged: number;
  readonly filesSkipped: number;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly elapsedMs: number;
}

export interface RebuildStats {
  readonly blobsRebuilt: number;
  readonly uniqueContentTrigrams: number;
  readonly uniquePathTrigrams: number;
  readonly totalSymbols: number;
  readonly elapsedMs: number;
  readonly digest: string;
}

export interface IndexMemoryStats {
  readonly canonicalBlobCount: number;
  readonly indexedDocCount: number;
  readonly uniqueContentTrigrams: number;
  readonly uniquePathTrigrams: number;
  readonly totalPostingEntries: number;
  readonly totalSymbols: number;
  readonly derivedIntact: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EXCERPT_CHARS = 500;
const DEFAULT_PER_FILE_LIMIT = 100;
const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.turbo',
  'coverage',
  '.venv',
  '__pycache__',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf',
  '.zip', '.tar', '.gz', '.tgz', '.xz', '.7z', '.rar',
  '.wasm', '.o', '.a', '.so', '.dylib', '.dll', '.exe',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav',
  '.sqlite', '.db', '.bin', '.dat', '.lockb',
]);

/** Compute deterministic lowercase hex SHA-256 of UTF-8 text or Buffer. */
export function computeBlobSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Normalize a repository-relative path to clean POSIX form with no leading slash or traversal. */
export function normalizeIndexPath(rawPath: string): string {
  const replaced = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const segment of replaced.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Infer language from file extension. */
export function inferSearchLanguage(filePath: string): SupportedSearchLanguage {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.rs':
      return 'rust';
    case '.go':
      return 'go';
    case '.py':
    case '.pyi':
      return 'python';
    case '.cu':
    case '.cuh':
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
    case '.h':
    case '.c':
      return 'cuda';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.toml':
      return 'toml';
    case '.md':
    case '.mdx':
      return 'markdown';
    default:
      return 'text';
  }
}

/** Escape regex metacharacters so a literal string compiles safely. */
export function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert a simple glob pattern (`*.ts`, `src/**\/*.cu`, `**\/config.toml`) into a RegExp. */
export function compilePathGlob(globPattern: string): RegExp {
  const normalized = globPattern.replace(/\\/g, '/').trim();
  const effective = normalized.includes('/') ? normalized : `**/${normalized}`;
  let regexStr = '^';
  let i = 0;
  while (i < effective.length) {
    const ch = effective[i];
    if (ch === '*') {
      if (effective[i + 1] === '*') {
        if (effective[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const close = effective.indexOf('}', i + 1);
      if (close !== -1) {
        const alts = effective
          .slice(i + 1, close)
          .split(',')
          .map(s => escapeRegExpLiteral(s));
        regexStr += `(?:${alts.join('|')})`;
        i = close + 1;
      } else {
        regexStr += '\\{';
        i += 1;
      }
    } else {
      regexStr += escapeRegExpLiteral(ch);
      i += 1;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function truncateExcerpt(line: string): string {
  return line.length > MAX_EXCERPT_CHARS ? line.slice(0, MAX_EXCERPT_CHARS) : line;
}

function packAsciiTrigram(c0: number, c1: number, c2: number): number {
  if ((c0 | c1 | c2) >= 128) return -1;
  return (c0 << 16) | (c1 << 8) | c2;
}

/** Extract all unique lowercased trigrams from text, split into fast ASCII keys and Unicode keys. */
export function extractUniqueTrigrams(text: string): {
  ascii: Set<number>;
  unicode: Set<string>;
} {
  const ascii = new Set<number>();
  const unicode = new Set<string>();
  const lower = text.toLowerCase();
  const len = lower.length;
  if (len < 3) return { ascii, unicode };

  let c0 = lower.charCodeAt(0);
  let c1 = lower.charCodeAt(1);
  for (let i = 2; i < len; i++) {
    const c2 = lower.charCodeAt(i);
    if (c0 !== 10 && c0 !== 13 && c1 !== 10 && c1 !== 13 && c2 !== 10 && c2 !== 13) {
      const packed = packAsciiTrigram(c0, c1, c2);
      if (packed >= 0) {
        ascii.add(packed);
      } else {
        unicode.add(lower.slice(i - 2, i + 1));
      }
    }
    c0 = c1;
    c1 = c2;
  }
  return { ascii, unicode };
}

/**
 * Sound regex required-literal extractor.
 *
 * Extracts required literal substrings of length >= 3 from a regular expression so the
 * trigram index can prune candidate documents with ZERO false negatives.
 */
export function planRegexTrigrams(pattern: string): TrigramQueryPlan {
  const topBranches = splitTopLevelAlternation(pattern);
  const branchLiterals: string[][] = [];

  for (const branch of topBranches) {
    const lits = extractRequiredLiteralsFromConcat(branch);
    if (lits.length === 0) {
      return {
        mode: 'scan_fallback',
        selective: false,
        branches: [],
        trigramCount: 0,
        reason: topBranches.length > 1
          ? 'At least one regex alternation branch lacks a >=3-char literal'
          : 'Regex lacks any required literal substring of length >= 3',
      };
    }
    branchLiterals.push(lits);
  }

  let trigramCount = 0;
  for (const lits of branchLiterals) {
    const seen = new Set<string>();
    for (const lit of lits) {
      const lower = lit.toLowerCase();
      for (let i = 0; i <= lower.length - 3; i++) {
        seen.add(lower.slice(i, i + 3));
      }
    }
    trigramCount += seen.size;
  }

  if (trigramCount === 0) {
    return {
      mode: 'scan_fallback',
      selective: false,
      branches: [],
      trigramCount: 0,
      reason: 'No selective trigrams extracted',
    };
  }

  return {
    mode: branchLiterals.length > 1 ? 'or' : 'and',
    selective: true,
    branches: branchLiterals,
    trigramCount,
    reason: branchLiterals.length > 1
      ? `Selective OR-of-AND trigram plan across ${branchLiterals.length} alternation branches`
      : `Selective AND trigram plan over ${branchLiterals[0].length} required literal(s)`,
  };
}

function splitTopLevelAlternation(pattern: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === '|' && depth === 0) {
      branches.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(pattern.slice(start));
  return branches;
}

function parseQuantifierAt(pattern: string, index: number): { end: number; minCount: number } | null {
  if (index >= pattern.length) return null;
  const ch = pattern[index];
  if (ch === '?' || ch === '*') {
    const next = pattern[index + 1] === '?' ? index + 2 : index + 1;
    return { end: next, minCount: 0 };
  }
  if (ch === '+') {
    const next = pattern[index + 1] === '?' ? index + 2 : index + 1;
    return { end: next, minCount: 1 };
  }
  if (ch === '{') {
    const match = /^\{(\d+)(?:,(\d*))?\}\??/.exec(pattern.slice(index));
    if (match) {
      return {
        end: index + match[0].length,
        minCount: Number.parseInt(match[1], 10),
      };
    }
  }
  return null;
}

function findMatchingParen(pattern: string, openIndex: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = openIndex; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractRequiredLiteralsFromConcat(expr: string): string[] {
  const literals: string[] = [];
  let current = '';

  const flush = () => {
    if (current.length >= 3) {
      literals.push(current);
    }
    current = '';
  };

  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];

    if (ch === '^' || ch === '$') {
      flush();
      i += 1;
      continue;
    }

    if (ch === '[') {
      flush();
      i += 1;
      if (i < expr.length && expr[i] === '^') i += 1;
      if (i < expr.length && expr[i] === ']') i += 1;
      while (i < expr.length && expr[i] !== ']') {
        if (expr[i] === '\\') i += 2;
        else i += 1;
      }
      if (i < expr.length) i += 1;
      const quant = parseQuantifierAt(expr, i);
      if (quant) i = quant.end;
      continue;
    }

    if (ch === '(') {
      const close = findMatchingParen(expr, i);
      if (close === -1) {
        flush();
        break;
      }
      const quant = parseQuantifierAt(expr, close + 1);
      const nextIndex = quant ? quant.end : close + 1;
      const minCount = quant ? quant.minCount : 1;

      let innerStart = i + 1;
      let isLookaround = false;
      if (expr[innerStart] === '?') {
        if (expr[innerStart + 1] === ':') {
          innerStart += 2;
        } else if (expr[innerStart + 1] === '<' && expr[innerStart + 2] !== '=' && expr[innerStart + 2] !== '!') {
          const gt = expr.indexOf('>', innerStart + 2);
          if (gt !== -1 && gt < close) innerStart = gt + 1;
          else isLookaround = true;
        } else {
          isLookaround = true;
        }
      }

      if (minCount === 0 || isLookaround) {
        flush();
        i = nextIndex;
        continue;
      }

      const inner = expr.slice(innerStart, close);
      const innerBranches = splitTopLevelAlternation(inner);
      if (innerBranches.length === 1) {
        const innerLits = extractRequiredLiteralsFromConcat(inner);
        flush();
        for (const lit of innerLits) literals.push(lit);
      } else {
        flush();
      }
      i = nextIndex;
      continue;
    }

    if (ch === '.') {
      flush();
      i += 1;
      const quant = parseQuantifierAt(expr, i);
      if (quant) i = quant.end;
      continue;
    }

    if (ch === '\\') {
      if (i + 1 >= expr.length) {
        flush();
        break;
      }
      const nextCh = expr[i + 1];
      let atomEnd = i + 2;
      let literalChar: string | null = null;

      if ('dDwWsSbB0123456789pPkcxu'.includes(nextCh)) {
        if (nextCh === 'x' && /^[0-9a-fA-F]{2}/.test(expr.slice(i + 2, i + 4))) {
          literalChar = String.fromCharCode(Number.parseInt(expr.slice(i + 2, i + 4), 16));
          atomEnd = i + 4;
        } else if (nextCh === 'u' && /^[0-9a-fA-F]{4}/.test(expr.slice(i + 2, i + 6))) {
          literalChar = String.fromCharCode(Number.parseInt(expr.slice(i + 2, i + 6), 16));
          atomEnd = i + 6;
        } else if (nextCh === 'p' || nextCh === 'P') {
          const braceEnd = expr.indexOf('}', i + 2);
          atomEnd = braceEnd !== -1 ? braceEnd + 1 : i + 2;
        }
      } else if (nextCh === 'n' || nextCh === 'r') {
        literalChar = null;
      } else if (nextCh === 't') {
        literalChar = '\t';
      } else {
        literalChar = nextCh;
      }

      const quant = parseQuantifierAt(expr, atomEnd);
      const nextIndex = quant ? quant.end : atomEnd;
      const minCount = quant ? quant.minCount : 1;

      if (literalChar !== null && literalChar !== '\n' && literalChar !== '\r') {
        if (minCount === 0) {
          flush();
        } else {
          current += literalChar;
          if (quant && quant.minCount !== 1) {
            flush();
          }
        }
      } else {
        flush();
      }
      i = nextIndex;
      continue;
    }

    const quant = parseQuantifierAt(expr, i + 1);
    const nextIndex = quant ? quant.end : i + 1;
    const minCount = quant ? quant.minCount : 1;

    if (minCount === 0) {
      flush();
    } else if (quant) {
      current += ch.repeat(Math.min(minCount, 4));
      flush();
    } else {
      current += ch;
    }
    i = nextIndex;
  }

  flush();
  return literals;
}

/** Language-aware symbol definition extractor for TS/JS/Rust/Go/Python/CUDA/YAML/TOML. */
export function extractSymbolsFromContent(
  content: string,
  language: SupportedSearchLanguage
): TrigramSymbolSpan[] {
  const symbols: TrigramSymbolSpan[] = [];
  const rawLines = content.split('\n');

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = stripTrailingCR(rawLines[idx]);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    const lineNum = idx + 1;
    let match: RegExpExecArray | null = null;
    let kind: TrigramSymbolSpan['kind'] | null = null;
    let name: string | null = null;

    if (language === 'typescript' || language === 'javascript') {
      match = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
      if (match) {
        const kw = match[1];
        name = match[2];
        if (kw === 'function') kind = 'function';
        else if (kw === 'class') kind = 'class';
        else if (kw === 'interface') kind = 'interface';
        else if (kw === 'type') kind = 'type';
        else if (kw === 'enum') kind = 'enum';
        else kind = 'const';
      }
    } else if (language === 'rust') {
      match = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|type|const|static|mod|macro_rules!)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
      if (match) {
        const kw = match[1];
        name = match[2];
        if (kw === 'fn') kind = 'function';
        else if (kw === 'struct') kind = 'struct';
        else if (kw === 'enum') kind = 'enum';
        else if (kw === 'trait') kind = 'interface';
        else if (kw === 'type') kind = 'type';
        else if (kw === 'macro_rules!') kind = 'macro';
        else kind = 'const';
      }
    } else if (language === 'go') {
      match = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
      if (match) {
        name = match[1];
        kind = 'function';
      } else {
        match = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface|\S+)/.exec(trimmed);
        if (match) {
          name = match[1];
          kind = match[2] === 'struct' ? 'struct' : match[2] === 'interface' ? 'interface' : 'type';
        } else {
          match = /^(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
          if (match) {
            name = match[1];
            kind = 'const';
          }
        }
      }
    } else if (language === 'python') {
      if (trimmed.startsWith('#')) continue;
      match = /^(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
      if (match) {
        kind = match[1] === 'def' ? 'function' : 'class';
        name = match[2];
      } else if (!line.startsWith(' ') && !line.startsWith('\t')) {
        match = /^([A-Z][A-Z0-9_]{2,})\s*=/.exec(trimmed);
        if (match) {
          kind = 'const';
          name = match[1];
        }
      }
    } else if (language === 'cuda') {
      if (trimmed.startsWith('#')) {
        match = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
        if (match) {
          name = match[1];
          kind = 'macro';
        }
      } else {
        match = /^(?:typedef\s+)?(struct|class|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
        if (match) {
          name = match[2];
          kind = match[1] === 'class' ? 'class' : match[1] === 'enum' ? 'enum' : 'struct';
        } else {
          match = /^(?:(?:__global__|__device__|__host__|static|inline|extern|constexpr|const)\s+)+[A-Za-z_][A-Za-z0-9_:<>*&\s]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|=)/.exec(trimmed);
          if (match) {
            name = match[1];
            kind = trimmed.includes('(') ? 'function' : 'const';
          }
        }
      }
    } else if (language === 'yaml' || language === 'toml') {
      if (trimmed.startsWith('#')) continue;
      match = language === 'yaml'
        ? /^([A-Za-z_][A-Za-z0-9_.-]{2,})\s*:/.exec(trimmed)
        : /^([A-Za-z_][A-Za-z0-9_.-]{2,})\s*=/.exec(trimmed);
      if (match) {
        name = match[1];
        kind = 'key';
      }
    }

    if (name && kind) {
      const col = line.indexOf(name);
      symbols.push({
        name,
        lowerName: name.toLowerCase(),
        kind,
        line: lineNum,
        column: col >= 0 ? col + 1 : 1,
        excerpt: truncateExcerpt(line),
      });
    }
  }

  return symbols;
}

/** Check whether a caller's AccessContext is permitted to read a document. */
export function isDocumentAuthorized(
  doc: Pick<TrigramBlobIdentity, 'tenantId' | 'repoId' | 'aclScope'> & { branch?: string; branches?: ReadonlySet<string> },
  access: TrigramAccessContext
): boolean {
  if (!access.tenantId || doc.tenantId !== access.tenantId) {
    return false;
  }
  if (access.branch !== undefined) {
    if (doc.branches !== undefined) {
      if (!doc.branches.has(access.branch)) return false;
    } else if (doc.branch !== access.branch) {
      return false;
    }
  }
  if (access.allowedRepos !== undefined && !access.allowedRepos.includes(doc.repoId)) {
    return false;
  }
  if (doc.aclScope.length === 0) {
    return false;
  }
  for (const scope of doc.aclScope) {
    if (scope === 'public' || access.allowedScopes.includes(scope)) {
      return true;
    }
  }
  return false;
}

/**
 * Zoekt-style content-addressed indexed document.
 * Identical `(tenantId, repoId, path, blobSha256, aclScope)` blobs across multiple branches
 * share a single posting entry and track membership in `branches: Set<string>`, making
 * `applyBranchDelta` O(changed files) instead of re-indexing unchanged files!
 */
interface IndexedDocState {
  readonly docId: number;
  readonly contentKey: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly path: string;
  readonly blobSha256: string;
  readonly aclScope: readonly string[];
  readonly language: SupportedSearchLanguage;
  readonly content: string;
  readonly lowerContent: string;
  readonly lineCount: number;
  readonly byteLength: number;
  /** Branch -> version for every branch currently referencing this immutable blob. */
  readonly branchVersions: Map<string, number>;
  readonly branches: Set<string>;
  readonly asciiContentTrigrams: Set<number>;
  readonly unicodeContentTrigrams: Set<string>;
  readonly asciiPathTrigrams: Set<number>;
  readonly unicodePathTrigrams: Set<string>;
  readonly symbols: readonly TrigramSymbolSpan[];
  readonly tokenFreqs: Map<string, number>;
}

/**
 * Clean-room incremental trigram inverted index with Zoekt-style branch-shared postings,
 * symbol indexing, sound regex literal planning, hybrid tie-breaking, and strict
 * pre-return multi-tenant ACL filtering.
 */
export class TrigramCodeIndex {
  /** Canonical source record store (source of truth; survives derived index wipe). */
  private readonly canonicalBlobs = new Map<string, CanonicalTrigramBlob>();

  /** Derived state (completely rebuildable from canonicalBlobs). */
  private nextDocId = 1;
  private derivedIntact = true;
  private readonly docsById = new Map<number, IndexedDocState>();
  /** `(tenantId, repoId, branch, path)` -> docId */
  private readonly branchPathToDocId = new Map<string, number>();
  /** Content-addressed `(tenantId, repoId, path, blobSha256, aclScope)` -> docId */
  private readonly contentKeyToDocId = new Map<string, number>();

  /** Tenant/branch partition sets for O(tenant) pre-return ACL filtering. */
  private readonly tenantDocIds = new Map<string, Set<number>>();
  private readonly tenantBranchDocIds = new Map<string, Set<number>>();

  /** Content trigram inverted postings (ASCII packed 24-bit int + Unicode fallback). */
  private readonly contentAsciiPostings = new Map<number, Set<number>>();
  private readonly contentUnicodePostings = new Map<string, Set<number>>();

  /** Path trigram inverted postings for fast filename/path queries. */
  private readonly pathAsciiPostings = new Map<number, Set<number>>();
  private readonly pathUnicodePostings = new Map<string, Set<number>>();

  /** Symbol inverted postings: lowercased symbol name -> docId -> spans. */
  private readonly symbolExactPostings = new Map<string, Map<number, TrigramSymbolSpan[]>>();

  /** Document frequency for lightweight lexical/IDF hybrid tie-breaking. */
  private readonly tokenDocFreq = new Map<string, number>();

  private makeCanonicalKey(tenantId: string, repoId: string, branch: string, normPath: string): string {
    return `${tenantId}\0${repoId}\0${branch}\0${normPath}`;
  }

  private makeContentKey(
    tenantId: string,
    repoId: string,
    normPath: string,
    blobSha256: string,
    aclScope: readonly string[]
  ): string {
    return `${tenantId}\0${repoId}\0${normPath}\0${blobSha256}\0${aclScope.join(',')}`;
  }

  private makeTenantBranchKey(tenantId: string, branch: string): string {
    return `${tenantId}\0${branch}`;
  }

  /** Upsert a canonical source blob and incrementally update derived postings in O(changed trigrams). */
  upsertFile(input: TrigramSourceBlobInput): IncrementalUpdateResult {
    const t0 = performance.now();
    const normPath = normalizeIndexPath(input.path);
    const canonicalKey = this.makeCanonicalKey(input.tenantId, input.repoId, input.branch, normPath);
    const blobSha256 = input.blobSha256 ?? computeBlobSha256(input.content);
    const aclScope = input.aclScope && input.aclScope.length > 0 ? [...input.aclScope] : ['default'];
    const language = input.language ?? inferSearchLanguage(normPath);
    const contentKey = this.makeContentKey(input.tenantId, input.repoId, normPath, blobSha256, aclScope);

    const existingBranchDocId = this.branchPathToDocId.get(canonicalKey);
    if (existingBranchDocId !== undefined) {
      const existing = this.docsById.get(existingBranchDocId);
      if (existing && existing.contentKey === contentKey) {
        return {
          action: 'unchanged',
          docId: existingBranchDocId,
          blobSha256,
          trigramsIndexed: existing.asciiContentTrigrams.size + existing.unicodeContentTrigrams.size,
          symbolsIndexed: existing.symbols.length,
          elapsedMs: performance.now() - t0,
        };
      }
      this.detachBranchDoc(canonicalKey, input.tenantId, input.branch, existingBranchDocId);
    }

    const prevCanonical = this.canonicalBlobs.get(canonicalKey);
    const version = input.version ?? (prevCanonical ? prevCanonical.version + 1 : 1);
    const lineCount = input.content.length === 0 ? 0 : input.content.split('\n').length;
    const canonical: CanonicalTrigramBlob = {
      tenantId: input.tenantId,
      repoId: input.repoId,
      branch: input.branch,
      path: normPath,
      blobSha256,
      version,
      aclScope,
      language,
      content: input.content,
      lineCount,
      byteLength: Buffer.byteLength(input.content, 'utf8'),
    };
    this.canonicalBlobs.set(canonicalKey, canonical);

    const docId = this.attachCanonicalBlob(canonicalKey, contentKey, canonical);
    const state = this.docsById.get(docId)!;

    return {
      action: existingBranchDocId !== undefined ? 'updated' : 'inserted',
      docId,
      blobSha256,
      trigramsIndexed: state.asciiContentTrigrams.size + state.unicodeContentTrigrams.size,
      symbolsIndexed: state.symbols.length,
      elapsedMs: performance.now() - t0,
    };
  }

  /** Delete a file from canonical storage and detach it from the branch's derived index. */
  deleteFile(tenantId: string, repoId: string, branch: string, filePath: string): boolean {
    const normPath = normalizeIndexPath(filePath);
    const canonicalKey = this.makeCanonicalKey(tenantId, repoId, branch, normPath);
    const existed = this.canonicalBlobs.delete(canonicalKey);
    const docId = this.branchPathToDocId.get(canonicalKey);
    if (docId !== undefined) {
      this.detachBranchDoc(canonicalKey, tenantId, branch, docId);
    }
    return existed;
  }

  /**
   * Create or refresh a branch snapshot in O(changed files) by sharing unchanged
   * content-addressed docIds from `baseBranch` and indexing only the delta (`upserts` & `deletes`).
   */
  applyBranchDelta(delta: BranchDeltaInput): BranchDeltaResult {
    const t0 = performance.now();
    const deleteSet = new Set(delta.deletes.map(p => normalizeIndexPath(p)));
    const upsertMap = new Map<string, Omit<TrigramSourceBlobInput, 'tenantId' | 'repoId' | 'branch'>>();
    for (const u of delta.upserts) {
      upsertMap.set(normalizeIndexPath(u.path), u);
    }

    let carriedUnchanged = 0;
    let upserted = 0;
    let deleted = 0;
    const countedDeletes = new Set<string>();

    // Locate baseBranch docs directly via the tenant-branch partition set (O(branch files))
    const baseBranchKey = this.makeTenantBranchKey(delta.tenantId, delta.baseBranch);
    const baseDocIds = [...(this.tenantBranchDocIds.get(baseBranchKey) ?? [])];

    for (const baseDocId of baseDocIds) {
      const state = this.docsById.get(baseDocId);
      if (!state || state.repoId !== delta.repoId) continue;

      if (deleteSet.has(state.path)) {
        this.deleteFile(delta.tenantId, delta.repoId, delta.targetBranch, state.path);
        if (!countedDeletes.has(state.path)) {
          countedDeletes.add(state.path);
          deleted += 1;
        }
        continue;
      }
      if (upsertMap.has(state.path)) {
        continue;
      }

      // Fast O(1) branch carry: attach existing content-addressed docId to targetBranch!
      const targetCanonicalKey = this.makeCanonicalKey(
        delta.tenantId,
        delta.repoId,
        delta.targetBranch,
        state.path
      );
      const baseVersion = state.branchVersions.get(delta.baseBranch) ?? 1;

      const existingTargetDocId = this.branchPathToDocId.get(targetCanonicalKey);
      if (existingTargetDocId === baseDocId) {
        carriedUnchanged += 1;
        continue;
      }
      if (existingTargetDocId !== undefined) {
        this.detachBranchDoc(targetCanonicalKey, delta.tenantId, delta.targetBranch, existingTargetDocId);
      }

      // Record canonical entry for deterministic rebuildability
      this.canonicalBlobs.set(targetCanonicalKey, {
        tenantId: state.tenantId,
        repoId: state.repoId,
        branch: delta.targetBranch,
        path: state.path,
        blobSha256: state.blobSha256,
        version: baseVersion,
        aclScope: [...state.aclScope],
        language: state.language,
        content: state.content,
        lineCount: state.lineCount,
        byteLength: state.byteLength,
      });

      state.branches.add(delta.targetBranch);
      state.branchVersions.set(delta.targetBranch, baseVersion);
      this.branchPathToDocId.set(targetCanonicalKey, baseDocId);
      addToSetMap(this.tenantBranchDocIds, this.makeTenantBranchKey(delta.tenantId, delta.targetBranch), baseDocId);
      carriedUnchanged += 1;
    }

    // Apply explicit deletions on targetBranch (for paths only on targetBranch)
    for (const delPath of deleteSet) {
      if (countedDeletes.has(delPath)) continue;
      if (this.deleteFile(delta.tenantId, delta.repoId, delta.targetBranch, delPath)) {
        countedDeletes.add(delPath);
        deleted += 1;
      }
    }

    // Index only changed/new delta files
    for (const [normPath, item] of upsertMap.entries()) {
      const res = this.upsertFile({
        tenantId: delta.tenantId,
        repoId: delta.repoId,
        branch: delta.targetBranch,
        path: normPath,
        content: item.content,
        aclScope: item.aclScope,
        version: item.version,
        language: item.language,
        blobSha256: item.blobSha256,
      });
      if (res.action !== 'unchanged') {
        upserted += 1;
      }
    }

    return {
      targetBranch: delta.targetBranch,
      carriedUnchanged,
      upserted,
      deleted,
      elapsedMs: performance.now() - t0,
    };
  }

  /**
   * Index an on-disk directory tree, resolving the workspace root via `fs.realpathSync`
   * so symlinked `TMPDIR` roots (e.g. macOS `/var` -> `/private/var`) work identically.
   */
  indexDirectory(rootDir: string, options: IndexDirectoryOptions): IndexDirectoryStats {
    const t0 = performance.now();
    const resolvedRoot = fs.realpathSync(rootDir);
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const skipDirs = options.skipDirs ? new Set(options.skipDirs) : DEFAULT_SKIP_DIRS;

    let filesIndexed = 0;
    let filesUnchanged = 0;
    let filesSkipped = 0;
    let totalLines = 0;
    let totalBytes = 0;

    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext)) {
            filesSkipped += 1;
            continue;
          }
          const stat = fs.statSync(fullPath);
          if (stat.size > maxFileBytes) {
            filesSkipped += 1;
            continue;
          }
          const raw = fs.readFileSync(fullPath);
          const probeLen = Math.min(raw.length, 4096);
          let isBinary = false;
          for (let i = 0; i < probeLen; i++) {
            if (raw[i] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) {
            filesSkipped += 1;
            continue;
          }

          const relPath = normalizeIndexPath(path.relative(resolvedRoot, fullPath));
          const content = raw.toString('utf8');
          const res = this.upsertFile({
            tenantId: options.tenantId,
            repoId: options.repoId,
            branch: options.branch,
            path: relPath,
            content,
            aclScope: options.aclScope,
          });
          if (res.action === 'unchanged') {
            filesUnchanged += 1;
          } else {
            filesIndexed += 1;
          }
          totalBytes += raw.length;
          totalLines += content.length === 0 ? 0 : content.split('\n').length;
        }
      }
    };

    walk(resolvedRoot);

    return {
      resolvedRoot,
      filesIndexed,
      filesUnchanged,
      filesSkipped,
      totalLines,
      totalBytes,
      elapsedMs: performance.now() - t0,
    };
  }

  /**
   * Wipe all derived index structures while preserving canonical source blobs.
   */
  wipeDerivedIndex(): void {
    this.nextDocId = 1;
    this.docsById.clear();
    this.branchPathToDocId.clear();
    this.contentKeyToDocId.clear();
    this.tenantDocIds.clear();
    this.tenantBranchDocIds.clear();
    this.contentAsciiPostings.clear();
    this.contentUnicodePostings.clear();
    this.pathAsciiPostings.clear();
    this.pathUnicodePostings.clear();
    this.symbolExactPostings.clear();
    this.tokenDocFreq.clear();
    this.derivedIntact = false;
  }

  /**
   * Rebuild the entire derived trigram, path, and symbol index deterministically
   * from canonical source records (in canonical key order).
   */
  rebuildFromCanonicalSources(): RebuildStats {
    const t0 = performance.now();
    this.wipeDerivedIndex();
    const sortedKeys = [...this.canonicalBlobs.keys()].sort();
    for (const canonicalKey of sortedKeys) {
      const blob = this.canonicalBlobs.get(canonicalKey)!;
      const contentKey = this.makeContentKey(
        blob.tenantId,
        blob.repoId,
        blob.path,
        blob.blobSha256,
        blob.aclScope
      );
      this.attachCanonicalBlob(canonicalKey, contentKey, blob);
    }
    this.derivedIntact = true;

    let totalSymbols = 0;
    for (const doc of this.docsById.values()) {
      totalSymbols += doc.symbols.length;
    }

    return {
      blobsRebuilt: sortedKeys.length,
      uniqueContentTrigrams: this.contentAsciiPostings.size + this.contentUnicodePostings.size,
      uniquePathTrigrams: this.pathAsciiPostings.size + this.pathUnicodePostings.size,
      totalSymbols,
      elapsedMs: performance.now() - t0,
      digest: this.computeIndexDigest(),
    };
  }

  /** Wipe both canonical store and derived index, then rebuild from an external list of blobs. */
  rebuildFromBlobs(blobs: readonly TrigramSourceBlobInput[]): RebuildStats {
    this.canonicalBlobs.clear();
    this.wipeDerivedIndex();
    const sorted = [...blobs].sort((a, b) => {
      const ka = this.makeCanonicalKey(a.tenantId, a.repoId, a.branch, normalizeIndexPath(a.path));
      const kb = this.makeCanonicalKey(b.tenantId, b.repoId, b.branch, normalizeIndexPath(b.path));
      return ka.localeCompare(kb);
    });
    for (const input of sorted) {
      this.upsertFile(input);
    }
    this.derivedIntact = true;
    return this.rebuildFromCanonicalSources();
  }

  /** Compute a deterministic SHA-256 digest of the derived index for rebuildability verification. */
  computeIndexDigest(): string {
    const hash = crypto.createHash('sha256');
    const sortedDocs = [...this.docsById.values()].sort((a, b) => a.contentKey.localeCompare(b.contentKey));
    for (const d of sortedDocs) {
      const branchesStr = [...d.branches].sort().map(br => `${br}@v${d.branchVersions.get(br) ?? 1}`).join(',');
      hash.update(`DOC:${d.contentKey}:${branchesStr}\n`);
    }
    const sortedAscii = [...this.contentAsciiPostings.keys()].sort((a, b) => a - b);
    for (const tri of sortedAscii) {
      const keys = [...this.contentAsciiPostings.get(tri)!]
        .map(id => this.docsById.get(id)!.contentKey)
        .sort();
      hash.update(`TRI:${tri}:${keys.join('|')}\n`);
    }
    const sortedSyms = [...this.symbolExactPostings.keys()].sort();
    for (const sym of sortedSyms) {
      const docMap = this.symbolExactPostings.get(sym)!;
      const entries = [...docMap.entries()]
        .map(([id, spans]) => `${this.docsById.get(id)!.contentKey}@${spans.map(s => s.line).join(',')}`)
        .sort();
      hash.update(`SYM:${sym}:${entries.join('|')}\n`);
    }
    return hash.digest('hex');
  }

  /** Return canonical source blob count and derived memory/posting metrics. */
  getStats(): IndexMemoryStats {
    let totalPostingEntries = 0;
    for (const set of this.contentAsciiPostings.values()) totalPostingEntries += set.size;
    for (const set of this.contentUnicodePostings.values()) totalPostingEntries += set.size;
    for (const set of this.pathAsciiPostings.values()) totalPostingEntries += set.size;
    for (const set of this.pathUnicodePostings.values()) totalPostingEntries += set.size;

    let totalSymbols = 0;
    for (const doc of this.docsById.values()) totalSymbols += doc.symbols.length;

    return {
      canonicalBlobCount: this.canonicalBlobs.size,
      indexedDocCount: this.docsById.size,
      uniqueContentTrigrams: this.contentAsciiPostings.size + this.contentUnicodePostings.size,
      uniquePathTrigrams: this.pathAsciiPostings.size + this.pathUnicodePostings.size,
      totalPostingEntries,
      totalSymbols,
      derivedIntact: this.derivedIntact,
    };
  }

  /**
   * Execute an exact, regex, symbol, path, or hybrid search with strict pre-return ACL filtering.
   */
  search(options: TrigramQueryOptions): TrigramSearchResponse {
    const t0 = performance.now();
    const kind: TrigramQueryKind = options.kind ?? 'exact';
    const caseSensitive = options.caseSensitive ?? (kind === 'exact');
    const limit = options.limit ?? 50;
    const perFileLimit = options.perFileLimit ?? DEFAULT_PER_FILE_LIMIT;
    const contextLines = options.contextLines ?? 0;
    const semanticBoostWeight = options.semanticBoostWeight ?? (kind === 'hybrid' ? 0.15 : 0);
    const pathGlobRegex = options.pathGlob ? compilePathGlob(options.pathGlob) : null;
    const langSet = options.languages && options.languages.length > 0 ? new Set(options.languages) : null;

    if (!options.query || !this.derivedIntact) {
      return {
        hits: [],
        stats: {
          elapsedMs: performance.now() - t0,
          authorizedDocs: 0,
          candidateDocs: 0,
          verifiedDocs: 0,
          totalHitsBeforeLimit: 0,
          usedFastPath: false,
          plan: {
            mode: 'scan_fallback',
            selective: false,
            branches: [],
            trigramCount: 0,
            reason: !options.query ? 'Empty query' : 'Derived index wiped; rebuild required',
          },
        },
      };
    }

    // STEP 1: STRICT PRE-RETURN TENANT & ACL PARTITIONING
    const partitionPool = options.access.branch !== undefined
      ? this.tenantBranchDocIds.get(this.makeTenantBranchKey(options.access.tenantId, options.access.branch))
      : this.tenantDocIds.get(options.access.tenantId);

    if (!partitionPool || partitionPool.size === 0) {
      return {
        hits: [],
        stats: {
          elapsedMs: performance.now() - t0,
          authorizedDocs: 0,
          candidateDocs: 0,
          verifiedDocs: 0,
          totalHitsBeforeLimit: 0,
          usedFastPath: true,
          plan: {
            mode: 'and',
            selective: true,
            branches: [],
            trigramCount: 0,
            reason: 'No documents in caller tenant/branch partition',
          },
        },
      };
    }

    const authorizedSet = new Set<number>();
    for (const docId of partitionPool) {
      const doc = this.docsById.get(docId);
      if (!doc) continue;
      if (!isDocumentAuthorized(doc, options.access)) continue;
      if (langSet && !langSet.has(doc.language)) continue;
      if (pathGlobRegex && !pathGlobRegex.test(doc.path)) continue;
      authorizedSet.add(docId);
    }

    if (authorizedSet.size === 0) {
      return {
        hits: [],
        stats: {
          elapsedMs: performance.now() - t0,
          authorizedDocs: 0,
          candidateDocs: 0,
          verifiedDocs: 0,
          totalHitsBeforeLimit: 0,
          usedFastPath: true,
          plan: {
            mode: 'and',
            selective: true,
            branches: [],
            trigramCount: 0,
            reason: 'No authorized documents matched ACL/language/glob filters',
          },
        },
      };
    }

    // STEP 2: BUILD TRIGRAM CANDIDATE PLAN & INTERSECT AGAINST AUTHORIZED DOCS ONLY
    let plan: TrigramQueryPlan;
    let candidateIds: number[];

    if (kind === 'path') {
      const lit = options.query.trim();
      if (lit.length >= 3) {
        const matched = this.intersectLiteralPostings(lit, this.pathAsciiPostings, this.pathUnicodePostings, authorizedSet);
        plan = {
          mode: 'and',
          selective: true,
          branches: [[lit]],
          trigramCount: Math.max(1, lit.length - 2),
          reason: 'Path trigram fast path',
        };
        candidateIds = matched;
      } else {
        plan = {
          mode: 'scan_fallback',
          selective: false,
          branches: [],
          trigramCount: 0,
          reason: 'Path query shorter than 3 characters',
        };
        candidateIds = [...authorizedSet];
      }
    } else if (kind === 'regex') {
      plan = planRegexTrigrams(options.query);
      if (plan.selective) {
        candidateIds = this.executePlanPostings(plan, authorizedSet);
      } else {
        candidateIds = [...authorizedSet];
      }
    } else if (kind === 'symbol') {
      const symName = options.query.trim();
      const lowerSym = symName.toLowerCase();
      const exactSymDocs = this.symbolExactPostings.get(lowerSym);
      if (symName.length >= 3) {
        const trigramCandidates = this.intersectLiteralPostings(
          symName,
          this.contentAsciiPostings,
          this.contentUnicodePostings,
          authorizedSet
        );
        const merged = new Set<number>(trigramCandidates);
        if (exactSymDocs) {
          for (const docId of exactSymDocs.keys()) {
            if (authorizedSet.has(docId)) merged.add(docId);
          }
        }
        plan = {
          mode: 'and',
          selective: true,
          branches: [[symName]],
          trigramCount: Math.max(1, symName.length - 2),
          reason: 'Symbol table + content trigram fast path',
        };
        candidateIds = [...merged];
      } else {
        plan = {
          mode: 'scan_fallback',
          selective: false,
          branches: [],
          trigramCount: 0,
          reason: 'Symbol query shorter than 3 characters',
        };
        candidateIds = [...authorizedSet];
      }
    } else {
      const lit = options.query;
      if (lit.length >= 3) {
        const exactCandidates = this.intersectLiteralPostings(
          lit,
          this.contentAsciiPostings,
          this.contentUnicodePostings,
          authorizedSet
        );
        if (kind === 'hybrid' && exactCandidates.length < limit) {
          const merged = new Set<number>(exactCandidates);
          const qTokens = tokenizeForHybrid(lit);
          for (const tok of qTokens) {
            if (tok.length >= 3) {
              for (const docId of this.intersectLiteralPostings(tok, this.contentAsciiPostings, this.contentUnicodePostings, authorizedSet)) {
                merged.add(docId);
              }
            }
          }
          candidateIds = [...merged];
        } else {
          candidateIds = exactCandidates;
        }
        plan = {
          mode: 'and',
          selective: true,
          branches: [[lit]],
          trigramCount: Math.max(1, lit.length - 2),
          reason: kind === 'hybrid' ? 'Exact trigram fast path with hybrid lexical fusion' : 'Exact literal trigram fast path',
        };
      } else {
        plan = {
          mode: 'scan_fallback',
          selective: false,
          branches: [],
          trigramCount: 0,
          reason: 'Literal query shorter than 3 characters; safe full scan fallback',
        };
        candidateIds = [...authorizedSet];
      }
    }

    // STEP 3: VERIFY CANDIDATES (WITH FAST PRE-SPLIT CHECK) & SCORE HITS
    const queryTokens = semanticBoostWeight > 0 || kind === 'hybrid' ? tokenizeForHybrid(options.query) : [];
    const hits: TrigramSearchHit[] = [];
    let verifiedDocs = 0;

    let compiledRegex: RegExp | null = null;
    if (kind === 'regex') {
      try {
        compiledRegex = new RegExp(options.query, caseSensitive ? '' : 'i');
      } catch {
        return {
          hits: [],
          stats: {
            elapsedMs: performance.now() - t0,
            authorizedDocs: authorizedSet.size,
            candidateDocs: candidateIds.length,
            verifiedDocs: 0,
            totalHitsBeforeLimit: 0,
            usedFastPath: plan.selective,
            plan: { ...plan, reason: 'Invalid regular expression' },
          },
        };
      }
    } else if (kind === 'symbol') {
      compiledRegex = new RegExp(`\\b${escapeRegExpLiteral(options.query.trim())}\\b`, caseSensitive ? '' : 'i');
    }

    const needle = caseSensitive ? options.query : options.query.toLowerCase();

    for (const docId of candidateIds) {
      const doc = this.docsById.get(docId);
      if (!doc) continue;
      verifiedDocs += 1;

      const effectiveBranch = options.access.branch ?? [...doc.branches][0] ?? 'main';
      const effectiveVersion = doc.branchVersions.get(effectiveBranch) ?? 1;

      const semanticBonus = semanticBoostWeight > 0 && queryTokens.length > 0
        ? this.computeLexicalSemanticScore(doc, queryTokens, authorizedSet.size) * semanticBoostWeight * 80
        : 0;

      if (kind === 'path') {
        const haystackPath = caseSensitive ? doc.path : doc.path.toLowerCase();
        const pos = haystackPath.indexOf(needle);
        if (pos !== -1) {
          const baseName = path.posix.basename(doc.path);
          const exactBase = (caseSensitive ? baseName : baseName.toLowerCase()) === needle;
          const score = (exactBase ? 1300 : 1000) + Math.max(0, 100 - doc.path.length) + semanticBonus;
          hits.push({
            tenantId: doc.tenantId,
            repoId: doc.repoId,
            branch: effectiveBranch,
            path: doc.path,
            blobSha256: doc.blobSha256,
            version: effectiveVersion,
            language: doc.language,
            line: 1,
            column: pos + 1,
            excerpt: doc.path,
            contextBefore: [],
            contextAfter: [],
            mark: 'path',
            score,
            exactMatch: true,
          });
        }
        continue;
      }

      if (kind === 'symbol') {
        if (!compiledRegex!.test(doc.content)) continue;
        const symQuery = options.query.trim();
        const lowerSym = symQuery.toLowerCase();
        const defLines = new Map<number, TrigramSymbolSpan>();
        const docDefs = this.symbolExactPostings.get(lowerSym)?.get(docId);
        if (docDefs) {
          for (const span of docDefs) {
            if (!caseSensitive || span.name === symQuery) {
              defLines.set(span.line, span);
            }
          }
        }

        const rawLines = doc.content.split('\n');
        let docHits = 0;
        for (let i = 0; i < rawLines.length && docHits < perFileLimit; i++) {
          const cleanLine = stripTrailingCR(rawLines[i]);
          const m = compiledRegex!.exec(cleanLine);
          if (!m) continue;
          const lineNo = i + 1;
          const defSpan = defLines.get(lineNo);
          const isDef = defSpan !== undefined;
          const score = (isDef ? 1500 : 1000) + semanticBonus;
          hits.push({
            tenantId: doc.tenantId,
            repoId: doc.repoId,
            branch: effectiveBranch,
            path: doc.path,
            blobSha256: doc.blobSha256,
            version: effectiveVersion,
            language: doc.language,
            line: lineNo,
            column: m.index + 1,
            excerpt: truncateExcerpt(cleanLine),
            contextBefore: extractContext(rawLines, i, contextLines, 'before'),
            contextAfter: extractContext(rawLines, i, contextLines, 'after'),
            mark: isDef ? 'definition' : 'reference',
            score,
            exactMatch: true,
            symbolKind: defSpan?.kind,
          });
          docHits += 1;
        }
        continue;
      }

      if (kind === 'regex') {
        if (!compiledRegex!.test(doc.content)) continue;
        const rawLines = doc.content.split('\n');
        let docHits = 0;
        for (let i = 0; i < rawLines.length && docHits < perFileLimit; i++) {
          const cleanLine = stripTrailingCR(rawLines[i]);
          const m = compiledRegex!.exec(cleanLine);
          if (!m) continue;
          hits.push({
            tenantId: doc.tenantId,
            repoId: doc.repoId,
            branch: effectiveBranch,
            path: doc.path,
            blobSha256: doc.blobSha256,
            version: effectiveVersion,
            language: doc.language,
            line: i + 1,
            column: m.index + 1,
            excerpt: truncateExcerpt(cleanLine),
            contextBefore: extractContext(rawLines, i, contextLines, 'before'),
            contextAfter: extractContext(rawLines, i, contextLines, 'after'),
            mark: 'regex',
            score: 1000 + semanticBonus,
            exactMatch: true,
          });
          docHits += 1;
        }
        continue;
      }

      // 'exact' or 'hybrid'
      const haystackFull = caseSensitive ? doc.content : doc.lowerContent;
      const hasLiteral = haystackFull.includes(needle);
      if (kind === 'exact' && !hasLiteral) {
        continue;
      }

      const rawLines = doc.content.split('\n');
      let docHits = 0;
      let foundExactInDoc = false;
      const lowerNeedle = options.query.toLowerCase();

      if (hasLiteral) {
        for (let i = 0; i < rawLines.length && docHits < perFileLimit; i++) {
          const cleanLine = stripTrailingCR(rawLines[i]);
          const haystack = caseSensitive ? cleanLine : cleanLine.toLowerCase();
          const col = haystack.indexOf(needle);
          if (col === -1) continue;
          foundExactInDoc = true;

          const isDef = doc.symbols.some(s => s.line === i + 1 && s.lowerName === lowerNeedle);
          const exactCaseBonus = cleanLine.includes(options.query) ? 1000 : 800;
          const defBonus = isDef ? 500 : 0;

          hits.push({
            tenantId: doc.tenantId,
            repoId: doc.repoId,
            branch: effectiveBranch,
            path: doc.path,
            blobSha256: doc.blobSha256,
            version: effectiveVersion,
            language: doc.language,
            line: i + 1,
            column: col + 1,
            excerpt: truncateExcerpt(cleanLine),
            contextBefore: extractContext(rawLines, i, contextLines, 'before'),
            contextAfter: extractContext(rawLines, i, contextLines, 'after'),
            mark: isDef ? 'definition' : 'exact',
            score: exactCaseBonus + defBonus + semanticBonus,
            exactMatch: true,
          });
          docHits += 1;
        }
      }

      if (kind === 'hybrid' && !foundExactInDoc && queryTokens.length > 0) {
        const semScore = this.computeLexicalSemanticScore(doc, queryTokens, authorizedSet.size);
        if (semScore > 0.15) {
          let bestIdx = 0;
          let bestOverlap = -1;
          for (let i = 0; i < rawLines.length; i++) {
            const lowerLine = rawLines[i].toLowerCase();
            let overlap = 0;
            for (const tok of queryTokens) {
              if (lowerLine.includes(tok)) overlap += 1;
            }
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestIdx = i;
            }
          }
          hits.push({
            tenantId: doc.tenantId,
            repoId: doc.repoId,
            branch: effectiveBranch,
            path: doc.path,
            blobSha256: doc.blobSha256,
            version: effectiveVersion,
            language: doc.language,
            line: bestIdx + 1,
            column: 1,
            excerpt: truncateExcerpt(stripTrailingCR(rawLines[bestIdx] ?? '')),
            contextBefore: extractContext(rawLines, bestIdx, contextLines, 'before'),
            contextAfter: extractContext(rawLines, bestIdx, contextLines, 'after'),
            mark: 'hybrid',
            score: Math.min(199, semScore * 180),
            exactMatch: false,
          });
        }
      }
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
      const aDef = a.mark === 'definition' ? 0 : 1;
      const bDef = b.mark === 'definition' ? 0 : 1;
      if (aDef !== bDef) return aDef - bDef;
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.line - b.line;
    });

    const totalHitsBeforeLimit = hits.length;
    const limited = limit > 0 ? hits.slice(0, limit) : hits;

    return {
      hits: limited,
      stats: {
        elapsedMs: performance.now() - t0,
        authorizedDocs: authorizedSet.size,
        candidateDocs: candidateIds.length,
        verifiedDocs,
        totalHitsBeforeLimit,
        usedFastPath: plan.selective,
        plan,
      },
    };
  }

  private attachCanonicalBlob(
    canonicalKey: string,
    contentKey: string,
    blob: CanonicalTrigramBlob
  ): number {
    const existingDocId = this.contentKeyToDocId.get(contentKey);
    if (existingDocId !== undefined) {
      const state = this.docsById.get(existingDocId)!;
      state.branches.add(blob.branch);
      state.branchVersions.set(blob.branch, blob.version);
      this.branchPathToDocId.set(canonicalKey, existingDocId);
      addToSetMap(this.tenantBranchDocIds, this.makeTenantBranchKey(blob.tenantId, blob.branch), existingDocId);
      return existingDocId;
    }

    const docId = this.nextDocId++;
    const contentTrigrams = extractUniqueTrigrams(blob.content);
    const pathTrigrams = extractUniqueTrigrams(blob.path);
    const symbols = extractSymbolsFromContent(blob.content, blob.language);
    const tokenFreqs = buildTokenFreqMap(blob.content);

    const state: IndexedDocState = {
      docId,
      contentKey,
      tenantId: blob.tenantId,
      repoId: blob.repoId,
      path: blob.path,
      blobSha256: blob.blobSha256,
      aclScope: blob.aclScope,
      language: blob.language,
      content: blob.content,
      lowerContent: blob.content.toLowerCase(),
      lineCount: blob.lineCount,
      byteLength: blob.byteLength,
      branchVersions: new Map([[blob.branch, blob.version]]),
      branches: new Set([blob.branch]),
      asciiContentTrigrams: contentTrigrams.ascii,
      unicodeContentTrigrams: contentTrigrams.unicode,
      asciiPathTrigrams: pathTrigrams.ascii,
      unicodePathTrigrams: pathTrigrams.unicode,
      symbols,
      tokenFreqs,
    };

    this.docsById.set(docId, state);
    this.contentKeyToDocId.set(contentKey, docId);
    this.branchPathToDocId.set(canonicalKey, docId);

    addToSetMap(this.tenantDocIds, blob.tenantId, docId);
    addToSetMap(this.tenantBranchDocIds, this.makeTenantBranchKey(blob.tenantId, blob.branch), docId);

    for (const tri of contentTrigrams.ascii) {
      addToSetMap(this.contentAsciiPostings, tri, docId);
    }
    for (const tri of contentTrigrams.unicode) {
      addToSetMap(this.contentUnicodePostings, tri, docId);
    }
    for (const tri of pathTrigrams.ascii) {
      addToSetMap(this.pathAsciiPostings, tri, docId);
    }
    for (const tri of pathTrigrams.unicode) {
      addToSetMap(this.pathUnicodePostings, tri, docId);
    }

    for (const span of symbols) {
      let byDoc = this.symbolExactPostings.get(span.lowerName);
      if (!byDoc) {
        byDoc = new Map<number, TrigramSymbolSpan[]>();
        this.symbolExactPostings.set(span.lowerName, byDoc);
      }
      let list = byDoc.get(docId);
      if (!list) {
        list = [];
        byDoc.set(docId, list);
      }
      list.push(span);
    }

    for (const tok of tokenFreqs.keys()) {
      this.tokenDocFreq.set(tok, (this.tokenDocFreq.get(tok) ?? 0) + 1);
    }

    return docId;
  }

  private detachBranchDoc(
    canonicalKey: string,
    tenantId: string,
    branch: string,
    docId: number
  ): void {
    this.branchPathToDocId.delete(canonicalKey);
    removeFromSetMap(this.tenantBranchDocIds, this.makeTenantBranchKey(tenantId, branch), docId);

    const state = this.docsById.get(docId);
    if (!state) return;
    state.branches.delete(branch);
    state.branchVersions.delete(branch);

    // Only purge global postings when no branch still references this content blob.
    if (state.branches.size > 0) return;

    this.docsById.delete(docId);
    this.contentKeyToDocId.delete(state.contentKey);
    removeFromSetMap(this.tenantDocIds, state.tenantId, docId);

    for (const tri of state.asciiContentTrigrams) {
      removeFromSetMap(this.contentAsciiPostings, tri, docId);
    }
    for (const tri of state.unicodeContentTrigrams) {
      removeFromSetMap(this.contentUnicodePostings, tri, docId);
    }
    for (const tri of state.asciiPathTrigrams) {
      removeFromSetMap(this.pathAsciiPostings, tri, docId);
    }
    for (const tri of state.unicodePathTrigrams) {
      removeFromSetMap(this.pathUnicodePostings, tri, docId);
    }

    for (const span of state.symbols) {
      const byDoc = this.symbolExactPostings.get(span.lowerName);
      if (byDoc) {
        byDoc.delete(docId);
        if (byDoc.size === 0) {
          this.symbolExactPostings.delete(span.lowerName);
        }
      }
    }

    for (const tok of state.tokenFreqs.keys()) {
      const next = (this.tokenDocFreq.get(tok) ?? 1) - 1;
      if (next <= 0) this.tokenDocFreq.delete(tok);
      else this.tokenDocFreq.set(tok, next);
    }
  }

  private executePlanPostings(plan: TrigramQueryPlan, authorizedSet: Set<number>): number[] {
    if (plan.mode === 'and') {
      return this.intersectMultipleLiterals(plan.branches[0], authorizedSet);
    }
    if (plan.mode === 'or') {
      const union = new Set<number>();
      for (const branchLits of plan.branches) {
        for (const docId of this.intersectMultipleLiterals(branchLits, authorizedSet)) {
          union.add(docId);
        }
      }
      return [...union];
    }
    return [...authorizedSet];
  }

  private intersectMultipleLiterals(literals: readonly string[], authorizedSet: Set<number>): number[] {
    const sets: Set<number>[] = [authorizedSet];
    for (const lit of literals) {
      const { ascii, unicode } = extractUniqueTrigrams(lit);
      for (const tri of ascii) {
        const posting = this.contentAsciiPostings.get(tri);
        if (!posting || posting.size === 0) return [];
        sets.push(posting);
      }
      for (const tri of unicode) {
        const posting = this.contentUnicodePostings.get(tri);
        if (!posting || posting.size === 0) return [];
        sets.push(posting);
      }
    }
    return intersectPostingSets(sets);
  }

  private intersectLiteralPostings(
    literal: string,
    asciiMap: Map<number, Set<number>>,
    unicodeMap: Map<string, Set<number>>,
    authorizedSet: Set<number>
  ): number[] {
    const { ascii, unicode } = extractUniqueTrigrams(literal);
    if (ascii.size === 0 && unicode.size === 0) {
      return [...authorizedSet];
    }
    const sets: Set<number>[] = [authorizedSet];
    for (const tri of ascii) {
      const posting = asciiMap.get(tri);
      if (!posting || posting.size === 0) return [];
      sets.push(posting);
    }
    for (const tri of unicode) {
      const posting = unicodeMap.get(tri);
      if (!posting || posting.size === 0) return [];
      sets.push(posting);
    }
    return intersectPostingSets(sets);
  }

  private computeLexicalSemanticScore(
    doc: IndexedDocState,
    queryTokens: readonly string[],
    corpusSize: number
  ): number {
    if (queryTokens.length === 0 || corpusSize <= 0) return 0;
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const tok of queryTokens) {
      const df = this.tokenDocFreq.get(tok) ?? 0;
      const idf = Math.log(1 + (corpusSize + 1) / (df + 1));
      totalWeight += idf;
      const tf = doc.tokenFreqs.get(tok) ?? 0;
      if (tf > 0) {
        matchedWeight += idf * (1 - 1 / (1 + tf));
      }
    }
    return totalWeight > 0 ? Math.min(1, matchedWeight / totalWeight) : 0;
  }
}

function intersectPostingSets(sets: Set<number>[]): number[] {
  if (sets.length === 0) return [];
  sets.sort((a, b) => a.size - b.size);
  const smallest = sets[0];
  if (smallest.size === 0) return [];

  const result: number[] = [];
  outer: for (const docId of smallest) {
    for (let i = 1; i < sets.length; i++) {
      if (!sets[i].has(docId)) continue outer;
    }
    result.push(docId);
  }
  return result;
}

function addToSetMap<K>(map: Map<K, Set<number>>, key: K, docId: number): void {
  let set = map.get(key);
  if (!set) {
    set = new Set<number>();
    map.set(key, set);
  }
  set.add(docId);
}

function removeFromSetMap<K>(map: Map<K, Set<number>>, key: K, docId: number): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(docId);
  if (set.size === 0) {
    map.delete(key);
  }
}

function extractContext(
  rawLines: readonly string[],
  index: number,
  contextLines: number,
  direction: 'before' | 'after'
): string[] {
  if (contextLines <= 0) return [];
  if (direction === 'before') {
    const start = Math.max(0, index - contextLines);
    const out: string[] = [];
    for (let i = start; i < index; i++) {
      out.push(truncateExcerpt(stripTrailingCR(rawLines[i])));
    }
    return out;
  }
  const end = Math.min(rawLines.length, index + 1 + contextLines);
  const out: string[] = [];
  for (let i = index + 1; i < end; i++) {
    out.push(truncateExcerpt(stripTrailingCR(rawLines[i])));
  }
  return out;
}

function tokenizeForHybrid(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const tok of raw) {
    out.add(tok);
    if (tok.includes('_')) {
      for (const part of tok.split('_')) {
        if (part.length >= 2) out.add(part);
      }
    }
  }
  return [...out];
}

function buildTokenFreqMap(content: string): Map<string, number> {
  const freqs = new Map<string, number>();
  const matches = content.toLowerCase().match(/[a-z0-9_]{2,}/g);
  if (!matches) return freqs;
  for (const tok of matches) {
    freqs.set(tok, (freqs.get(tok) ?? 0) + 1);
  }
  return freqs;
}
