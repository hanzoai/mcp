/**
 * Compiler-Aware Code Knowledge Graph: SCIP + Tree-Sitter Structural Fusion (HIP-1346 / #34).
 *
 * Clean-room MIT implementation of a versioned repository symbol graph:
 *   Repository -> Package -> File -> Symbol -> Definition / Reference / Import / Implementation
 *
 * Architectural guarantees:
 * 1. Derived index over immutable identities: Every source blob and commit has a stable
 *    `(tenantId, repoId, commitOid, blobSha256)` identity. Rebuilding from the immutable
 *    source + SCIP documents yields an identical graph digest without mutating source records.
 * 2. Compiler-exact SCIP ingestion (`scip-typescript`, `scip-go`; Apache-2.0 wire semantics)
 *    paired with fast polyglot structural syntax extraction (Go, Rust, TypeScript, Python)
 *    for uncovered files and rapid incremental commit updates.
 * 3. Pre-hit tenant & RBAC access-control filtering: `tenantId` and `principalRoles` are
 *    enforced BEFORE any symbol, definition, reference, implementation, or bug-localization
 *    candidate is scored or returned.
 */

import * as crypto from 'crypto';
import { Tool, ToolResult } from '../types/index.js';

export type SupportedGraphLanguage = 'typescript' | 'go' | 'rust' | 'python';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'trait'
  | 'struct'
  | 'enum'
  | 'function'
  | 'method'
  | 'type'
  | 'variable'
  | 'module';

export type OccurrenceRole = 'definition' | 'reference' | 'import' | 'implementation';

/** Standard SCIP SymbolRole bitmask constants (Apache-2.0 SCIP specification). */
export const ScipSymbolRole = {
  Definition: 0x1,
  Import: 0x2,
  WriteAccess: 0x4,
  ReadAccess: 0x8,
  Generated: 0x10,
  Test: 0x20,
  ForwardDefinition: 0x40,
} as const;

export interface SourceSpan {
  startLine: number; // 1-indexed inclusive
  startColumn: number; // 0-indexed inclusive
  endLine: number; // 1-indexed inclusive
  endColumn: number; // 0-indexed exclusive
}

export interface SourceBlobIdentity {
  tenantId: string;
  repoId: string;
  commitOid: string;
  packageName: string;
  filePath: string;
  language: SupportedGraphLanguage;
  blobSha256?: string;
  /** Optional RBAC allowlist; empty/undefined means accessible to any principal in the same tenant. */
  allowedRoles?: string[];
  content: string;
}

export interface ScipRelationshipInput {
  symbol: string;
  isReference?: boolean;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
}

export interface ScipSymbolInformationInput {
  symbol: string;
  documentation?: string[];
  relationships?: ScipRelationshipInput[];
}

export interface ScipOccurrenceInput {
  /** 3-tuple `[line, startChar, endChar]` or 4-tuple `[startLine, startChar, endLine, endChar]` (0-indexed). */
  range: [number, number, number] | [number, number, number, number];
  symbol: string;
  symbolRoles?: number;
}

export interface ScipDocumentInput {
  relativePath: string;
  language?: string;
  occurrences: ScipOccurrenceInput[];
  symbols?: ScipSymbolInformationInput[];
}

export interface ScipIndexInput {
  projectRoot?: string;
  toolInfo?: { name: string; version: string };
  documents: ScipDocumentInput[];
}

export interface AccessContext {
  tenantId: string;
  principalRoles?: string[];
  allowedPackages?: string[];
}

export interface ParsedScipSymbol {
  raw: string;
  isLocal: boolean;
  scheme: string;
  manager: string;
  packageName: string;
  version: string;
  descriptors: Array<{
    name: string;
    suffix: 'namespace' | 'type' | 'term' | 'method' | 'typeParameter' | 'parameter' | 'meta';
    disambiguator?: string;
  }>;
  leafName: string;
  enclosingType?: string;
}

export interface RepositoryNode {
  tenantId: string;
  repoId: string;
  commitOid: string;
  indexedAtMs: number;
  packages: Set<string>;
}

export interface PackageNode {
  id: string; // `${tenantId}::${repoId}::${packageName}`
  tenantId: string;
  repoId: string;
  packageName: string;
  files: Set<string>;
}

export interface FileNode {
  id: string; // `${tenantId}::${repoId}::${filePath}`
  tenantId: string;
  repoId: string;
  commitOid: string;
  packageName: string;
  filePath: string;
  language: SupportedGraphLanguage;
  blobSha256: string;
  allowedRoles: string[];
  indexSource: 'scip' | 'tree-sitter-structural' | 'hybrid';
  symbolIds: Set<string>;
  occurrenceIds: string[];
}

export interface SymbolNode {
  id: string; // Canonical symbol key scoped to tenant+repo
  canonicalSymbol: string;
  name: string;
  enclosingSymbol?: string;
  kind: SymbolKind;
  tenantId: string;
  repoId: string;
  packageName: string;
  definedInFile?: string;
  definitionSpan?: SourceSpan;
  allowedRoles: string[];
  provenance: 'scip' | 'structural';
  implementedInterfaces: Set<string>; // canonicalSymbol targets
}

export interface GraphOccurrence {
  id: string;
  tenantId: string;
  repoId: string;
  packageName: string;
  filePath: string;
  blobSha256: string;
  allowedRoles: string[];
  canonicalSymbol: string;
  symbolName: string;
  role: OccurrenceRole;
  span: SourceSpan;
  linePreview: string;
  provenance: 'scip' | 'structural';
}

export interface NavigationHit {
  canonicalSymbol: string;
  symbolName: string;
  kind: SymbolKind;
  role: OccurrenceRole;
  packageName: string;
  filePath: string;
  blobSha256: string;
  commitOid: string;
  span: SourceSpan;
  linePreview: string;
  provenance: 'scip' | 'structural';
}

export interface BugLocalizationHit {
  filePath: string;
  packageName: string;
  blobSha256: string;
  commitOid: string;
  score: number;
  matchedSymbols: string[];
  rationale: string[];
}

export interface CommitDelta {
  tenantId: string;
  repoId: string;
  newCommitOid: string;
  upsertedBlobs: SourceBlobIdentity[];
  deletedFilePaths?: string[];
  scipIndex?: ScipIndexInput;
}

export interface ReindexStats {
  previousCommitOid: string;
  newCommitOid: string;
  reindexedFiles: number;
  removedFiles: number;
  untouchedFiles: number;
  elapsedMs: number;
  graphDigest: string;
}

export interface GraphMemoryStats {
  repositories: number;
  packages: number;
  files: number;
  symbols: number;
  occurrences: number;
  implementationEdges: number;
  estimatedMemoryBytes: number;
}

export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Parses a standard SCIP symbol string (`<scheme> <manager> <pkg> <version> <descriptors>`)
 * or `local <id>` symbol into structured components.
 */
export function parseScipSymbol(rawSymbol: string): ParsedScipSymbol {
  const trimmed = rawSymbol.trim();
  if (trimmed.startsWith('local ')) {
    const localId = trimmed.slice('local '.length).trim();
    return {
      raw: trimmed,
      isLocal: true,
      scheme: 'local',
      manager: '',
      packageName: '',
      version: '',
      descriptors: [{ name: localId, suffix: 'term' }],
      leafName: localId,
    };
  }

  // Space-separated header tokens where double-space escapes space inside a token
  const tokens: string[] = [];
  let cur = '';
  let idx = 0;
  while (idx < trimmed.length && tokens.length < 4) {
    const ch = trimmed[idx];
    if (ch === ' ') {
      if (trimmed[idx + 1] === ' ') {
        cur += ' ';
        idx += 2;
        continue;
      }
      tokens.push(cur);
      cur = '';
      idx += 1;
    } else {
      cur += ch;
      idx += 1;
    }
  }

  const descriptorTail = trimmed.slice(idx);
  const [scheme = 'scip', manager = '.', packageName = '.', version = '.'] = tokens;
  const descriptors: ParsedScipSymbol['descriptors'] = [];

  let p = 0;
  while (p < descriptorTail.length) {
    let ident = '';
    if (descriptorTail[p] === '`') {
      p += 1;
      while (p < descriptorTail.length) {
        if (descriptorTail[p] === '`' && descriptorTail[p + 1] === '`') {
          ident += '`';
          p += 2;
        } else if (descriptorTail[p] === '`') {
          p += 1;
          break;
        } else {
          ident += descriptorTail[p];
          p += 1;
        }
      }
    } else if (descriptorTail[p] === '(') {
      p += 1;
      while (p < descriptorTail.length && descriptorTail[p] !== ')') {
        ident += descriptorTail[p];
        p += 1;
      }
      if (descriptorTail[p] === ')') p += 1;
      if (ident) {
        descriptors.push({ name: ident, suffix: 'parameter' });
      }
      continue;
    } else if (descriptorTail[p] === '[') {
      p += 1;
      while (p < descriptorTail.length && descriptorTail[p] !== ']') {
        ident += descriptorTail[p];
        p += 1;
      }
      if (descriptorTail[p] === ']') p += 1;
      if (ident) {
        descriptors.push({ name: ident, suffix: 'typeParameter' });
      }
      continue;
    } else {
      while (
        p < descriptorTail.length &&
        !'/#.()[]:!'.includes(descriptorTail[p])
      ) {
        ident += descriptorTail[p];
        p += 1;
      }
    }

    const sep = descriptorTail[p];
    if (sep === '/') {
      descriptors.push({ name: ident, suffix: 'namespace' });
      p += 1;
    } else if (sep === '#') {
      descriptors.push({ name: ident, suffix: 'type' });
      p += 1;
    } else if (sep === '.') {
      descriptors.push({ name: ident, suffix: 'term' });
      p += 1;
    } else if (sep === '(') {
      // Method descriptor: `methodName(disambiguator).`
      p += 1;
      let disambig = '';
      while (p < descriptorTail.length && descriptorTail[p] !== ')') {
        disambig += descriptorTail[p];
        p += 1;
      }
      if (descriptorTail[p] === ')') p += 1;
      if (descriptorTail[p] === '.') p += 1;
      descriptors.push({
        name: ident,
        suffix: 'method',
        disambiguator: disambig || undefined,
      });
    } else if (sep === ':' || sep === '!') {
      descriptors.push({ name: ident, suffix: 'meta' });
      p += 1;
    } else if (ident) {
      descriptors.push({ name: ident, suffix: 'term' });
    } else {
      p += 1;
    }
  }

  const nonParam = descriptors.filter(
    (d) => d.suffix !== 'parameter' && d.suffix !== 'typeParameter' && d.name.length > 0
  );
  const leaf = nonParam[nonParam.length - 1]?.name ?? trimmed;
  let enclosingType: string | undefined;
  for (let i = nonParam.length - 2; i >= 0; i--) {
    if (nonParam[i].suffix === 'type') {
      enclosingType = nonParam[i].name;
      break;
    }
  }

  return {
    raw: trimmed,
    isLocal: false,
    scheme,
    manager,
    packageName,
    version,
    descriptors,
    leafName: leaf,
    enclosingType,
  };
}

function scipRangeToSpan(range: [number, number, number] | [number, number, number, number]): SourceSpan {
  if (range.length === 3) {
    return {
      startLine: range[0] + 1,
      startColumn: range[1],
      endLine: range[0] + 1,
      endColumn: range[2],
    };
  }
  return {
    startLine: range[0] + 1,
    startColumn: range[1],
    endLine: range[2] + 1,
    endColumn: range[3],
  };
}

function inferKindFromParsedScip(parsed: ParsedScipSymbol): SymbolKind {
  const last = parsed.descriptors[parsed.descriptors.length - 1];
  if (!last) return 'variable';
  if (last.suffix === 'method') return 'method';
  if (last.suffix === 'type') return 'class';
  if (last.suffix === 'namespace') return 'module';
  return 'function';
}

/**
 * Strips comments and string literals while preserving exact line count and column offsets
 * (replacing stripped characters with spaces) so structural syntax extraction never
 * produces false-positive symbols from comments or string literals.
 */
export function maskCommentsAndStringsPreservingLayout(
  source: string,
  language: SupportedGraphLanguage
): string {
  const out = source.split('');
  const n = out.length;
  let i = 0;

  const blank = (idx: number) => {
    if (out[idx] !== '\n' && out[idx] !== '\r') {
      out[idx] = ' ';
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Python `#` line comments
    if (language === 'python' && ch === '#') {
      while (i < n && source[i] !== '\n') {
        blank(i++);
      }
      continue;
    }

    // Python triple-quoted strings `"""` or `'''`
    if (
      language === 'python' &&
      ((ch === '"' && next === '"' && source[i + 2] === '"') ||
        (ch === "'" && next === "'" && source[i + 2] === "'"))
    ) {
      const q = ch;
      blank(i++);
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === q && source[i + 1] === q && source[i + 2] === q)) {
        blank(i++);
      }
      if (i < n) {
        blank(i++);
        blank(i++);
        blank(i++);
      }
      continue;
    }

    // `//` line comments (TS, Go, Rust)
    if (language !== 'python' && ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        blank(i++);
      }
      continue;
    }

    // `/* ... */` block comments (TS, Go, Rust)
    if (language !== 'python' && ch === '/' && next === '*') {
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        blank(i++);
      }
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }

    // Raw/backtick strings in Go or TS
    if ((language === 'go' || language === 'typescript') && ch === '`') {
      blank(i++);
      while (i < n && source[i] !== '`') {
        if (language === 'typescript' && source[i] === '\\') {
          blank(i++);
        }
        if (i < n) blank(i++);
      }
      if (i < n) blank(i++);
      continue;
    }

    // Standard single or double quoted strings (skip Rust region-tick annotations like `'a`)
    if (ch === '"' || (ch === "'" && language !== 'rust')) {
      const quote = ch;
      blank(i++);
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          blank(i++);
        }
        if (i < n) blank(i++);
      }
      if (i < n && source[i] === quote) blank(i++);
      continue;
    }

    i += 1;
  }

  return out.join('');
}

interface ExtractedSymbolDef {
  name: string;
  enclosingType?: string;
  kind: SymbolKind;
  span: SourceSpan;
  implementsNames: string[];
  goMethodSignature?: string;
}

interface ExtractedImportRef {
  importedName: string;
  sourceSpecifier?: string;
  span: SourceSpan;
}

interface ExtractedIdentifierToken {
  name: string;
  span: SourceSpan;
}

const LANGUAGE_KEYWORDS: Record<SupportedGraphLanguage, Set<string>> = {
  typescript: new Set([
    'import', 'from', 'export', 'default', 'class', 'interface', 'type', 'enum', 'function',
    'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'break', 'continue', 'new', 'this', 'super', 'extends', 'implements', 'async', 'await',
    'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'void', 'null',
    'undefined', 'true', 'false', 'number', 'string', 'boolean', 'any', 'unknown', 'never',
    'readonly', 'public', 'private', 'protected', 'static', 'abstract', 'as', 'Record',
    'Array', 'Promise', 'Map', 'Set', 'Error',
  ]),
  go: new Set([
    'package', 'import', 'func', 'type', 'struct', 'interface', 'return', 'if', 'else',
    'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'go', 'defer',
    'chan', 'select', 'map', 'var', 'const', 'nil', 'true', 'false', 'error', 'string',
    'int', 'int64', 'int32', 'uint', 'uint64', 'byte', 'bool', 'float64', 'float32', 'any',
    'make', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover',
  ]),
  rust: new Set([
    'pub', 'crate', 'super', 'self', 'Self', 'mod', 'use', 'fn', 'struct', 'enum', 'trait',
    'impl', 'for', 'where', 'type', 'const', 'static', 'let', 'mut', 'ref', 'return', 'if',
    'else', 'match', 'loop', 'while', 'in', 'break', 'continue', 'async', 'await', 'move',
    'unsafe', 'extern', 'dyn', 'as', 'true', 'false', 'Some', 'None', 'Ok', 'Err', 'Option',
    'Result', 'Vec', 'String', 'Box', 'Arc', 'Rc', 'usize', 'isize', 'u8', 'u16', 'u32',
    'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'bool', 'str',
  ]),
  python: new Set([
    'def', 'class', 'import', 'from', 'as', 'return', 'if', 'elif', 'else', 'for', 'while',
    'in', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'self', 'cls', 'try', 'except',
    'finally', 'raise', 'with', 'yield', 'async', 'await', 'pass', 'break', 'continue',
    'lambda', 'global', 'nonlocal', 'int', 'str', 'float', 'bool', 'list', 'dict', 'set',
    'tuple', 'Optional', 'Any', 'List', 'Dict', 'Tuple', 'Set', 'Exception', 'ValueError',
  ]),
};

interface StructuralParseResult {
  definitions: ExtractedSymbolDef[];
  imports: ExtractedImportRef[];
  identifiers: ExtractedIdentifierToken[];
  goInterfaceMethods: Map<string, Set<string>>;
}

/**
 * Polyglot Tree-sitter-style structural syntax extractor for TypeScript, Go, Rust, and Python.
 */
function extractStructuralSyntax(
  content: string,
  language: SupportedGraphLanguage
): StructuralParseResult {
  const masked = maskCommentsAndStringsPreservingLayout(content, language);
  const rawLines = content.split(/\r?\n/);
  const lines = masked.split(/\r?\n/);

  const definitions: ExtractedSymbolDef[] = [];
  const imports: ExtractedImportRef[] = [];
  const identifiers: ExtractedIdentifierToken[] = [];
  const goInterfaceMethods = new Map<string, Set<string>>();

  const locateSpan = (lineIdx: number, symbolName: string, searchFrom = 0): SourceSpan => {
    const lineText = lines[lineIdx] ?? '';
    const col = Math.max(0, lineText.indexOf(symbolName, searchFrom));
    return {
      startLine: lineIdx + 1,
      startColumn: col,
      endLine: lineIdx + 1,
      endColumn: col + symbolName.length,
    };
  };

  if (language === 'typescript') {
    let activeClass: { name: string; braceDepth: number } | undefined;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const rawLn = rawLines[i] ?? '';

      // Named imports: `import { A, B as C } from '...'`
      const impMatch = rawLn.match(/^\s*import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
      if (impMatch) {
        const specifiers = impMatch[1].split(',');
        for (const sp of specifiers) {
          const clean = sp.replace(/\btype\b/, '').trim();
          if (!clean) continue;
          const parts = clean.split(/\s+as\s+/);
          const importedName = parts[0].trim();
          if (importedName) {
            imports.push({
              importedName,
              sourceSpecifier: impMatch[2],
              span: locateSpan(i, importedName),
            });
          }
        }
      }

      // Class / Interface declaration
      const clsMatch = ln.match(
        /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]+>)?(?:\s+extends\s+([A-Za-z0-9_$,\s<>]+?))?(?:\s+implements\s+([A-Za-z0-9_$,\s<>]+?))?\s*\{/
      );
      if (clsMatch) {
        const kind: SymbolKind = clsMatch[1] === 'interface' ? 'interface' : 'class';
        const name = clsMatch[2];
        const implRaw = [clsMatch[3], clsMatch[4]].filter(Boolean).join(',');
        const implementsNames = implRaw
          .split(',')
          .map((s) => s.replace(/<.*>/g, '').trim())
          .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s));
        definitions.push({
          name,
          kind,
          span: locateSpan(i, name),
          implementsNames,
        });
        activeClass = { name, braceDepth };
      } else {
        const fnMatch = ln.match(
          /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/
        );
        if (fnMatch) {
          definitions.push({
            name: fnMatch[1],
            kind: 'function',
            span: locateSpan(i, fnMatch[1]),
            implementsNames: [],
          });
        } else {
          const typeMatch = ln.match(
            /^\s*(?:export\s+)?(type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/
          );
          if (typeMatch) {
            definitions.push({
              name: typeMatch[2],
              kind: typeMatch[1] === 'enum' ? 'enum' : 'type',
              span: locateSpan(i, typeMatch[2]),
              implementsNames: [],
            });
          } else if (activeClass) {
            const methMatch = ln.match(
              /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/
            );
            if (
              methMatch &&
              !LANGUAGE_KEYWORDS.typescript.has(methMatch[1]) &&
              methMatch[1] !== 'constructor'
            ) {
              definitions.push({
                name: methMatch[1],
                enclosingType: activeClass.name,
                kind: 'method',
                span: locateSpan(i, methMatch[1]),
                implementsNames: [],
              });
            }
          } else {
            const constMatch = ln.match(
              /^\s*export\s+(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/
            );
            if (constMatch) {
              definitions.push({
                name: constMatch[1],
                kind: 'variable',
                span: locateSpan(i, constMatch[1]),
                implementsNames: [],
              });
            }
          }
        }
      }

      for (const ch of ln) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      }
      if (activeClass && braceDepth <= activeClass.braceDepth) {
        activeClass = undefined;
      }
    }
  } else if (language === 'go') {
    let inImportBlock = false;
    let activeInterface: { name: string; methods: Set<string> } | undefined;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const rawLn = rawLines[i] ?? '';

      if (/^\s*import\s*\(/.test(ln)) {
        inImportBlock = true;
        continue;
      }
      if (inImportBlock) {
        if (/^\s*\)/.test(ln)) {
          inImportBlock = false;
          continue;
        }
        const pkgLit = rawLn.match(/["`]([^"`]+)["`]/);
        if (pkgLit) {
          const segs = pkgLit[1].split('/');
          const leafPkg = segs[segs.length - 1];
          imports.push({
            importedName: leafPkg,
            sourceSpecifier: pkgLit[1],
            span: {
              startLine: i + 1,
              startColumn: Math.max(0, rawLn.indexOf(leafPkg)),
              endLine: i + 1,
              endColumn: Math.max(0, rawLn.indexOf(leafPkg)) + leafPkg.length,
            },
          });
        }
        continue;
      }

      const singleImp = rawLn.match(/^\s*import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?["`]([^"`]+)["`]/);
      if (singleImp) {
        const segs = singleImp[1].split('/');
        const leafPkg = segs[segs.length - 1];
        imports.push({
          importedName: leafPkg,
          sourceSpecifier: singleImp[1],
          span: {
            startLine: i + 1,
            startColumn: Math.max(0, rawLn.indexOf(leafPkg)),
            endLine: i + 1,
            endColumn: Math.max(0, rawLn.indexOf(leafPkg)) + leafPkg.length,
          },
        });
      }

      if (activeInterface) {
        if (/^\s*\}/.test(ln)) {
          goInterfaceMethods.set(activeInterface.name, activeInterface.methods);
          activeInterface = undefined;
          continue;
        }
        const ifaceMethod = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (ifaceMethod) {
          activeInterface.methods.add(ifaceMethod[1]);
          definitions.push({
            name: ifaceMethod[1],
            enclosingType: activeInterface.name,
            kind: 'method',
            span: locateSpan(i, ifaceMethod[1]),
            implementsNames: [],
          });
        }
        continue;
      }

      const typeMatch = ln.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/);
      if (typeMatch) {
        const kind: SymbolKind = typeMatch[2] === 'interface' ? 'interface' : 'struct';
        definitions.push({
          name: typeMatch[1],
          kind,
          span: locateSpan(i, typeMatch[1]),
          implementsNames: [],
        });
        if (kind === 'interface' && ln.includes('{') && !ln.includes('}')) {
          activeInterface = { name: typeMatch[1], methods: new Set() };
        }
        continue;
      }

      const recvFn = ln.match(
        /^\s*func\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/
      );
      if (recvFn) {
        definitions.push({
          name: recvFn[2],
          enclosingType: recvFn[1],
          kind: 'method',
          span: locateSpan(i, recvFn[2], ln.indexOf(')')),
          implementsNames: [],
          goMethodSignature: recvFn[2],
        });
        continue;
      }

      const freeFn = ln.match(/^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*[([[]/);
      if (freeFn) {
        definitions.push({
          name: freeFn[1],
          kind: 'function',
          span: locateSpan(i, freeFn[1]),
          implementsNames: [],
        });
      }
    }
  } else if (language === 'rust') {
    let activeImpl: { targetType: string; traitName?: string; braceDepth: number } | undefined;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];

      const useBrace = ln.match(/^\s*(?:pub\s+)?use\s+([A-Za-z0-9_:]+)::\{([^}]+)\}/);
      if (useBrace) {
        for (const item of useBrace[2].split(',')) {
          const clean = item.split(/\s+as\s+/)[0].trim();
          if (clean && clean !== 'self') {
            imports.push({
              importedName: clean,
              sourceSpecifier: useBrace[1],
              span: locateSpan(i, clean),
            });
          }
        }
      } else {
        const useSingle = ln.match(/^\s*(?:pub\s+)?use\s+(?:[A-Za-z0-9_]+::)+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
        if (useSingle && useSingle[1] !== 'self') {
          imports.push({
            importedName: useSingle[1],
            span: locateSpan(i, useSingle[1]),
          });
        }
      }

      const implTrait = ln.match(
        /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_:]*?)(?:<[^>]*>)?\s+for\s+([A-Za-z_][A-Za-z0-9_]*)/
      );
      if (implTrait) {
        const traitParts = implTrait[1].split('::');
        const traitLeaf = traitParts[traitParts.length - 1];
        const targetType = implTrait[2];
        activeImpl = { targetType, traitName: traitLeaf, braceDepth };
        // Attach trait implementation edge to struct/enum if defined in same file, or emit synthetic impl record
        const existingDef = definitions.find((d) => d.name === targetType && !d.enclosingType);
        if (existingDef) {
          if (!existingDef.implementsNames.includes(traitLeaf)) {
            existingDef.implementsNames.push(traitLeaf);
          }
        } else {
          definitions.push({
            name: targetType,
            kind: 'struct',
            span: locateSpan(i, targetType),
            implementsNames: [traitLeaf],
          });
        }
      } else {
        const implInherent = ln.match(/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?\s*\{/);
        if (implInherent) {
          activeImpl = { targetType: implInherent[1], braceDepth };
        }
      }

      const itemMatch = ln.match(
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/
      );
      if (itemMatch) {
        const kindMap: Record<string, SymbolKind> = {
          struct: 'struct',
          enum: 'enum',
          trait: 'trait',
        };
        definitions.push({
          name: itemMatch[2],
          kind: kindMap[itemMatch[1]],
          span: locateSpan(i, itemMatch[2]),
          implementsNames: [],
        });
      }

      const fnMatch = ln.match(
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/
      );
      if (fnMatch) {
        definitions.push({
          name: fnMatch[1],
          enclosingType: activeImpl?.targetType,
          kind: activeImpl ? 'method' : 'function',
          span: locateSpan(i, fnMatch[1]),
          implementsNames: [],
        });
      }

      for (const ch of ln) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      }
      if (activeImpl && braceDepth <= activeImpl.braceDepth) {
        activeImpl = undefined;
      }
    }
  } else if (language === 'python') {
    let activeClass: { name: string; indent: number } | undefined;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) continue;
      const indent = ln.match(/^\s*/)?.[0].length ?? 0;
      if (activeClass && indent <= activeClass.indent && !/^\s*@/.test(ln)) {
        activeClass = undefined;
      }

      const fromImp = ln.match(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/);
      if (fromImp) {
        for (const rawPart of fromImp[2].replace(/[()]/g, '').split(',')) {
          const clean = rawPart.trim().split(/\s+as\s+/)[0].trim();
          if (clean && clean !== '*') {
            imports.push({
              importedName: clean,
              sourceSpecifier: fromImp[1],
              span: locateSpan(i, clean),
            });
          }
        }
        continue;
      }

      const clsMatch = ln.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*:/);
      if (clsMatch) {
        const bases = (clsMatch[2] ?? '')
          .split(',')
          .map((b) => b.trim().replace(/\[.*\]/g, ''))
          .filter((b) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(b) && !['ABC', 'Protocol', 'object'].includes(b))
          .map((b) => {
            const segs = b.split('.');
            return segs[segs.length - 1];
          });
        const isProtocol = (clsMatch[2] ?? '').includes('Protocol') || (clsMatch[2] ?? '').includes('ABC');
        definitions.push({
          name: clsMatch[1],
          kind: isProtocol ? 'interface' : 'class',
          span: locateSpan(i, clsMatch[1]),
          implementsNames: bases,
        });
        activeClass = { name: clsMatch[1], indent };
        continue;
      }

      const defMatch = ln.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (defMatch) {
        if (defMatch[1] !== '__init__') {
          definitions.push({
            name: defMatch[1],
            enclosingType: activeClass?.name,
            kind: activeClass ? 'method' : 'function',
            span: locateSpan(i, defMatch[1]),
            implementsNames: [],
          });
        }
      }
    }
  }

  // Extract all non-keyword identifier tokens for cross-file reference linking
  const kw = LANGUAGE_KEYWORDS[language];
  const tokenRegex = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let match: RegExpExecArray | null;
    tokenRegex.lastIndex = 0;
    while ((match = tokenRegex.exec(ln)) !== null) {
      const word = match[0];
      if (kw.has(word) || word.length < 2) continue;
      identifiers.push({
        name: word,
        span: {
          startLine: i + 1,
          startColumn: match.index,
          endLine: i + 1,
          endColumn: match.index + word.length,
        },
      });
    }
  }

  return { definitions, imports, identifiers, goInterfaceMethods };
}

interface StoredSourceFile {
  blob: SourceBlobIdentity;
  blobSha256: string;
  structural: StructuralParseResult;
  scipDoc?: ScipDocumentInput;
}

/**
 * Versioned Compiler-Aware Code Knowledge Graph (`HIP-1346` / `#34`).
 */
export class CodeKnowledgeGraph {
  private readonly repositories = new Map<string, RepositoryNode>();
  private readonly packages = new Map<string, PackageNode>();
  private readonly files = new Map<string, FileNode>();
  private readonly symbols = new Map<string, SymbolNode>();
  private readonly occurrencesBySymbol = new Map<string, GraphOccurrence[]>();
  private readonly symbolIdsByLeafName = new Map<string, Set<string>>();
  private readonly implementationsByTarget = new Map<string, Set<string>>();
  private readonly storedSources = new Map<string, StoredSourceFile>();

  private repoKey(tenantId: string, repoId: string): string {
    return `${tenantId}::${repoId}`;
  }

  private pkgKey(tenantId: string, repoId: string, packageName: string): string {
    return `${tenantId}::${repoId}::${packageName}`;
  }

  private fileKey(tenantId: string, repoId: string, filePath: string): string {
    return `${tenantId}::${repoId}::${filePath}`;
  }

  private symbolKey(tenantId: string, repoId: string, canonicalSymbol: string): string {
    return `${tenantId}::${repoId}::${canonicalSymbol}`;
  }

  /**
   * Mandatory pre-retrieval access control check:
   * Tenant isolation and optional role/package restrictions are evaluated BEFORE any hit is returned.
   */
  private isPermitted(
    tenantId: string,
    packageName: string,
    allowedRoles: string[],
    access: AccessContext
  ): boolean {
    if (tenantId !== access.tenantId) {
      return false;
    }
    if (access.allowedPackages && access.allowedPackages.length > 0) {
      if (!access.allowedPackages.includes(packageName)) {
        return false;
      }
    }
    if (allowedRoles.length > 0) {
      const principal = access.principalRoles ?? [];
      return allowedRoles.some((r) => principal.includes(r));
    }
    return true;
  }

  /**
   * Indexes a full repository snapshot from immutable source blobs and optional SCIP compiler output.
   */
  public indexRepository(
    blobs: SourceBlobIdentity[],
    scipIndex?: ScipIndexInput
  ): ReindexStats {
    if (blobs.length === 0) {
      return {
        previousCommitOid: '',
        newCommitOid: '',
        reindexedFiles: 0,
        removedFiles: 0,
        untouchedFiles: 0,
        elapsedMs: 0,
        graphDigest: this.computeGraphDigest(),
      };
    }
    const { tenantId, repoId, commitOid } = blobs[0];
    return this.reindexCommit({
      tenantId,
      repoId,
      newCommitOid: commitOid,
      upsertedBlobs: blobs,
      scipIndex,
    });
  }

  /**
   * Incrementally updates the symbol graph on a new commit in O(|delta|) file parses,
   * preserving untouched file subgraphs and recomputing cross-file edges deterministically.
   */
  public reindexCommit(delta: CommitDelta): ReindexStats {
    const t0 = performance.now();
    const rKey = this.repoKey(delta.tenantId, delta.repoId);
    const existingRepo = this.repositories.get(rKey);
    const previousCommitOid = existingRepo?.commitOid ?? '';

    const scipByPath = new Map<string, ScipDocumentInput>();
    for (const doc of delta.scipIndex?.documents ?? []) {
      scipByPath.set(doc.relativePath, doc);
    }

    let removedFiles = 0;
    for (const deletedPath of delta.deletedFilePaths ?? []) {
      const fKey = this.fileKey(delta.tenantId, delta.repoId, deletedPath);
      if (this.storedSources.delete(fKey)) {
        removedFiles += 1;
      }
    }

    let reindexedFiles = 0;
    for (const rawBlob of delta.upsertedBlobs) {
      const computedSha = rawBlob.blobSha256 ?? sha256Hex(rawBlob.content);
      const fKey = this.fileKey(delta.tenantId, delta.repoId, rawBlob.filePath);
      const prev = this.storedSources.get(fKey);
      const nextScip = scipByPath.get(rawBlob.filePath);

      if (
        prev &&
        prev.blobSha256 === computedSha &&
        prev.blob.packageName === rawBlob.packageName &&
        !nextScip &&
        JSON.stringify(prev.blob.allowedRoles ?? []) === JSON.stringify(rawBlob.allowedRoles ?? [])
      ) {
        // Update commitOid pointer without re-running syntax extraction
        prev.blob = { ...rawBlob, commitOid: delta.newCommitOid, blobSha256: computedSha };
        continue;
      }

      const structural = extractStructuralSyntax(rawBlob.content, rawBlob.language);
      this.storedSources.set(fKey, {
        blob: { ...rawBlob, commitOid: delta.newCommitOid, blobSha256: computedSha },
        blobSha256: computedSha,
        structural,
        scipDoc: nextScip ?? prev?.scipDoc,
      });
      reindexedFiles += 1;
    }

    // Update commitOid across untouched stored files in this repository
    let totalRepoFiles = 0;
    for (const [fKey, stored] of this.storedSources.entries()) {
      if (fKey.startsWith(`${rKey}::`)) {
        stored.blob = { ...stored.blob, commitOid: delta.newCommitOid };
        totalRepoFiles += 1;
      }
    }
    const untouchedFiles = Math.max(0, totalRepoFiles - reindexedFiles);

    // Rebuild derived graph projections for this `(tenantId, repoId)` from cached AST/SCIP structures
    this.rebuildDerivedRepoProjection(delta.tenantId, delta.repoId, delta.newCommitOid);

    const elapsedMs = Number((performance.now() - t0).toFixed(3));
    return {
      previousCommitOid,
      newCommitOid: delta.newCommitOid,
      reindexedFiles,
      removedFiles,
      untouchedFiles,
      elapsedMs,
      graphDigest: this.computeGraphDigest(delta.tenantId, delta.repoId),
    };
  }

  private clearDerivedRepoProjection(tenantId: string, repoId: string): void {
    const prefix = `${tenantId}::${repoId}::`;

    for (const key of Array.from(this.packages.keys())) {
      if (key.startsWith(prefix)) this.packages.delete(key);
    }
    for (const key of Array.from(this.files.keys())) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
    for (const [symId, sym] of Array.from(this.symbols.entries())) {
      if (symId.startsWith(prefix)) {
        this.symbols.delete(symId);
        const leafSet = this.symbolIdsByLeafName.get(sym.name);
        if (leafSet) {
          leafSet.delete(symId);
          if (leafSet.size === 0) this.symbolIdsByLeafName.delete(sym.name);
        }
      }
    }
    for (const key of Array.from(this.occurrencesBySymbol.keys())) {
      if (key.startsWith(prefix)) this.occurrencesBySymbol.delete(key);
    }
    for (const key of Array.from(this.implementationsByTarget.keys())) {
      if (key.startsWith(prefix)) this.implementationsByTarget.delete(key);
    }
  }

  private registerSymbol(node: SymbolNode): void {
    this.symbols.set(node.id, node);
    let set = this.symbolIdsByLeafName.get(node.name);
    if (!set) {
      set = new Set();
      this.symbolIdsByLeafName.set(node.name, set);
    }
    set.add(node.id);
  }

  private appendOccurrence(symKey: string, occ: GraphOccurrence): void {
    let list = this.occurrencesBySymbol.get(symKey);
    if (!list) {
      list = [];
      this.occurrencesBySymbol.set(symKey, list);
    }
    // Deduplicate identical file+line+col+role occurrences when merging SCIP + structural
    const dup = list.some(
      (existing) =>
        existing.filePath === occ.filePath &&
        existing.span.startLine === occ.span.startLine &&
        existing.span.startColumn === occ.span.startColumn &&
        existing.role === occ.role
    );
    if (!dup) {
      list.push(occ);
    }
  }

  private recordImplementationEdge(
    tenantId: string,
    repoId: string,
    implementerSymbolKey: string,
    targetInterfaceSymbolKey: string
  ): void {
    const prefix = `${tenantId}::${repoId}::`;
    if (!targetInterfaceSymbolKey.startsWith(prefix)) return;
    let set = this.implementationsByTarget.get(targetInterfaceSymbolKey);
    if (!set) {
      set = new Set();
      this.implementationsByTarget.set(targetInterfaceSymbolKey, set);
    }
    set.add(implementerSymbolKey);
  }

  private rebuildDerivedRepoProjection(
    tenantId: string,
    repoId: string,
    commitOid: string
  ): void {
    this.clearDerivedRepoProjection(tenantId, repoId);
    const rKey = this.repoKey(tenantId, repoId);
    const repoFiles: StoredSourceFile[] = [];
    for (const [fKey, stored] of this.storedSources.entries()) {
      if (fKey.startsWith(`${rKey}::`)) {
        repoFiles.push(stored);
      }
    }
    repoFiles.sort((a, b) => a.blob.filePath.localeCompare(b.blob.filePath));

    const repoNode: RepositoryNode = {
      tenantId,
      repoId,
      commitOid,
      indexedAtMs: Date.now(),
      packages: new Set(),
    };
    this.repositories.set(rKey, repoNode);

    // Pass 1: Register packages, files, SCIP definitions, and structural definitions
    const goStructMethods = new Map<string, { structSymKey: string; methods: Set<string>; file: StoredSourceFile; defSpan: SourceSpan }>();
    const allGoInterfaces = new Map<string, { ifaceSymKey: string; methods: Set<string> }>();
    const pendingStructuralImpls: Array<{ implSymKey: string; targetLeafName: string; file: StoredSourceFile; span: SourceSpan }> = [];

    for (const stored of repoFiles) {
      const { blob, blobSha256, structural, scipDoc } = stored;
      const roles = [...(blob.allowedRoles ?? [])];
      repoNode.packages.add(blob.packageName);

      const pKey = this.pkgKey(tenantId, repoId, blob.packageName);
      let pkgNode = this.packages.get(pKey);
      if (!pkgNode) {
        pkgNode = {
          id: pKey,
          tenantId,
          repoId,
          packageName: blob.packageName,
          files: new Set(),
        };
        this.packages.set(pKey, pkgNode);
      }
      pkgNode.files.add(blob.filePath);

      const fKey = this.fileKey(tenantId, repoId, blob.filePath);
      const fileNode: FileNode = {
        id: fKey,
        tenantId,
        repoId,
        commitOid,
        packageName: blob.packageName,
        filePath: blob.filePath,
        language: blob.language,
        blobSha256,
        allowedRoles: roles,
        indexSource: scipDoc ? 'hybrid' : 'tree-sitter-structural',
        symbolIds: new Set(),
        occurrenceIds: [],
      };
      this.files.set(fKey, fileNode);

      const rawLines = blob.content.split(/\r?\n/);

      // 1A. Ingest SCIP compiler definitions & symbol relationships if available
      const scipDefinedLineCols = new Set<string>();
      if (scipDoc) {
        const symInfoMap = new Map<string, ScipSymbolInformationInput>();
        for (const info of scipDoc.symbols ?? []) {
          symInfoMap.set(info.symbol, info);
        }

        for (const occ of scipDoc.occurrences) {
          const parsed = parseScipSymbol(occ.symbol);
          if (parsed.isLocal) continue;
          const span = scipRangeToSpan(occ.range);
          const roleMask = occ.symbolRoles ?? 0;
          const isDef = (roleMask & ScipSymbolRole.Definition) !== 0;
          const isImp = (roleMask & ScipSymbolRole.Import) !== 0;
          const role: OccurrenceRole = isDef ? 'definition' : isImp ? 'import' : 'reference';

          const canonical = occ.symbol;
          const sKey = this.symbolKey(tenantId, repoId, canonical);
          let symNode = this.symbols.get(sKey);
          if (!symNode) {
            symNode = {
              id: sKey,
              canonicalSymbol: canonical,
              name: parsed.leafName,
              enclosingSymbol: parsed.enclosingType,
              kind: inferKindFromParsedScip(parsed),
              tenantId,
              repoId,
              packageName: blob.packageName,
              definedInFile: isDef ? blob.filePath : undefined,
              definitionSpan: isDef ? span : undefined,
              allowedRoles: roles,
              provenance: 'scip',
              implementedInterfaces: new Set(),
            };
            this.registerSymbol(symNode);
          } else if (isDef) {
            symNode.definedInFile = blob.filePath;
            symNode.definitionSpan = span;
            symNode.packageName = blob.packageName;
            symNode.allowedRoles = roles;
            symNode.provenance = 'scip';
          }

          if (isDef) {
            fileNode.symbolIds.add(sKey);
            scipDefinedLineCols.add(`${span.startLine}:${parsed.leafName}`);
            const info = symInfoMap.get(canonical);
            for (const rel of info?.relationships ?? []) {
              if (rel.isImplementation) {
                symNode.implementedInterfaces.add(rel.symbol);
                const targetKey = this.symbolKey(tenantId, repoId, rel.symbol);
                this.recordImplementationEdge(tenantId, repoId, sKey, targetKey);
                const implOcc: GraphOccurrence = {
                  id: `${fKey}::impl::${span.startLine}:${span.startColumn}::${rel.symbol}`,
                  tenantId,
                  repoId,
                  packageName: blob.packageName,
                  filePath: blob.filePath,
                  blobSha256,
                  allowedRoles: roles,
                  canonicalSymbol: rel.symbol,
                  symbolName: parseScipSymbol(rel.symbol).leafName,
                  role: 'implementation',
                  span,
                  linePreview: (rawLines[span.startLine - 1] ?? '').trim(),
                  provenance: 'scip',
                };
                this.appendOccurrence(targetKey, implOcc);
              }
            }
          }

          const gOcc: GraphOccurrence = {
            id: `${fKey}::scip::${span.startLine}:${span.startColumn}::${role}`,
            tenantId,
            repoId,
            packageName: blob.packageName,
            filePath: blob.filePath,
            blobSha256,
            allowedRoles: roles,
            canonicalSymbol: canonical,
            symbolName: parsed.leafName,
            role,
            span,
            linePreview: (rawLines[span.startLine - 1] ?? '').trim(),
            provenance: 'scip',
          };
          fileNode.occurrenceIds.push(gOcc.id);
          this.appendOccurrence(sKey, gOcc);
        }
      }

      // 1B. Ingest Tree-sitter-style structural definitions for any symbol not already covered by SCIP
      for (const def of structural.definitions) {
        if (scipDefinedLineCols.has(`${def.span.startLine}:${def.name}`)) {
          continue;
        }
        const descriptor = def.enclosingType
          ? `${def.enclosingType}#${def.name}().`
          : def.kind === 'class' || def.kind === 'interface' || def.kind === 'struct' || def.kind === 'trait' || def.kind === 'enum' || def.kind === 'type'
            ? `${def.name}#`
            : `${def.name}().`;
        const canonical = `structural ${blob.language} ${blob.packageName} HEAD ${blob.filePath}/${descriptor}`;
        const sKey = this.symbolKey(tenantId, repoId, canonical);

        const symNode: SymbolNode = {
          id: sKey,
          canonicalSymbol: canonical,
          name: def.name,
          enclosingSymbol: def.enclosingType,
          kind: def.kind,
          tenantId,
          repoId,
          packageName: blob.packageName,
          definedInFile: blob.filePath,
          definitionSpan: def.span,
          allowedRoles: roles,
          provenance: 'structural',
          implementedInterfaces: new Set(),
        };
        this.registerSymbol(symNode);
        fileNode.symbolIds.add(sKey);

        const defOcc: GraphOccurrence = {
          id: `${fKey}::struct-def::${def.span.startLine}:${def.span.startColumn}`,
          tenantId,
          repoId,
          packageName: blob.packageName,
          filePath: blob.filePath,
          blobSha256,
          allowedRoles: roles,
          canonicalSymbol: canonical,
          symbolName: def.name,
          role: 'definition',
          span: def.span,
          linePreview: (rawLines[def.span.startLine - 1] ?? '').trim(),
          provenance: 'structural',
        };
        fileNode.occurrenceIds.push(defOcc.id);
        this.appendOccurrence(sKey, defOcc);

        for (const targetLeaf of def.implementsNames) {
          pendingStructuralImpls.push({
            implSymKey: sKey,
            targetLeafName: targetLeaf,
            file: stored,
            span: def.span,
          });
        }

        if (blob.language === 'go') {
          if (def.kind === 'struct') {
            const existing = goStructMethods.get(`${blob.packageName}::${def.name}`);
            goStructMethods.set(`${blob.packageName}::${def.name}`, {
              structSymKey: sKey,
              methods: existing?.methods ?? new Set(),
              file: stored,
              defSpan: def.span,
            });
          } else if (def.kind === 'interface') {
            const mSet = structural.goInterfaceMethods.get(def.name) ?? new Set();
            if (mSet.size > 0) {
              allGoInterfaces.set(sKey, { ifaceSymKey: sKey, methods: mSet });
            }
          } else if (def.kind === 'method' && def.enclosingType && def.goMethodSignature) {
            const key = `${blob.packageName}::${def.enclosingType}`;
            const entry = goStructMethods.get(key);
            if (entry) {
              entry.methods.add(def.goMethodSignature);
            } else {
              goStructMethods.set(key, {
                structSymKey: '',
                methods: new Set([def.goMethodSignature]),
                file: stored,
                defSpan: def.span,
              });
            }
          }
        }
      }
    }

    // Pass 2: Resolve structural implementation edges (TS `implements`, Rust `impl Trait for T`, Python subclass, Go structural interfaces)
    for (const pending of pendingStructuralImpls) {
      const candidates = this.resolveSymbolCandidatesByName(
        tenantId,
        repoId,
        pending.targetLeafName,
        pending.file.blob.packageName
      ).filter((s) => ['interface', 'trait', 'class'].includes(s.kind));

      const implSym = this.symbols.get(pending.implSymKey);
      const rawLines = pending.file.blob.content.split(/\r?\n/);
      for (const target of candidates) {
        implSym?.implementedInterfaces.add(target.canonicalSymbol);
        this.recordImplementationEdge(tenantId, repoId, pending.implSymKey, target.id);
        this.appendOccurrence(target.id, {
          id: `${pending.file.blob.filePath}::struct-impl::${pending.span.startLine}:${target.id}`,
          tenantId,
          repoId,
          packageName: pending.file.blob.packageName,
          filePath: pending.file.blob.filePath,
          blobSha256: pending.file.blobSha256,
          allowedRoles: [...(pending.file.blob.allowedRoles ?? [])],
          canonicalSymbol: target.canonicalSymbol,
          symbolName: target.name,
          role: 'implementation',
          span: pending.span,
          linePreview: (rawLines[pending.span.startLine - 1] ?? '').trim(),
          provenance: 'structural',
        });
      }
    }

    // Go duck-typed interface satisfaction across packages inside the same repo
    for (const structEntry of goStructMethods.values()) {
      if (!structEntry.structSymKey || structEntry.methods.size === 0) continue;
      const structSym = this.symbols.get(structEntry.structSymKey);
      const rawLines = structEntry.file.blob.content.split(/\r?\n/);
      for (const iface of allGoInterfaces.values()) {
        let satisfiesAll = true;
        for (const reqMethod of iface.methods) {
          if (!structEntry.methods.has(reqMethod)) {
            satisfiesAll = false;
            break;
          }
        }
        if (satisfiesAll) {
          const ifaceSym = this.symbols.get(iface.ifaceSymKey);
          if (ifaceSym) {
            structSym?.implementedInterfaces.add(ifaceSym.canonicalSymbol);
            this.recordImplementationEdge(tenantId, repoId, structEntry.structSymKey, iface.ifaceSymKey);
            this.appendOccurrence(iface.ifaceSymKey, {
              id: `${structEntry.file.blob.filePath}::go-impl::${structEntry.defSpan.startLine}::${iface.ifaceSymKey}`,
              tenantId,
              repoId,
              packageName: structEntry.file.blob.packageName,
              filePath: structEntry.file.blob.filePath,
              blobSha256: structEntry.file.blobSha256,
              allowedRoles: [...(structEntry.file.blob.allowedRoles ?? [])],
              canonicalSymbol: ifaceSym.canonicalSymbol,
              symbolName: ifaceSym.name,
              role: 'implementation',
              span: structEntry.defSpan,
              linePreview: (rawLines[structEntry.defSpan.startLine - 1] ?? '').trim(),
              provenance: 'structural',
            });
          }
        }
      }
    }

    // Pass 3: Resolve structural imports and cross-file references for files without full SCIP coverage
    for (const stored of repoFiles) {
      if (stored.scipDoc) {
        // SCIP already resolved exact compiler occurrences for this file
        continue;
      }
      const { blob, blobSha256, structural } = stored;
      const roles = [...(blob.allowedRoles ?? [])];
      const fKey = this.fileKey(tenantId, repoId, blob.filePath);
      const fileNode = this.files.get(fKey)!;
      const rawLines = blob.content.split(/\r?\n/);

      const importedSymbols = new Map<string, SymbolNode>();
      const importSpanKeys = new Set<string>();

      for (const imp of structural.imports) {
        const targets = this.resolveSymbolCandidatesByName(
          tenantId,
          repoId,
          imp.importedName,
          blob.packageName,
          imp.sourceSpecifier
        );
        const target = targets[0];
        if (!target) continue;
        importedSymbols.set(imp.importedName, target);
        const spanKey = `${imp.span.startLine}:${imp.span.startColumn}`;
        importSpanKeys.add(spanKey);

        const impOcc: GraphOccurrence = {
          id: `${fKey}::struct-imp::${spanKey}`,
          tenantId,
          repoId,
          packageName: blob.packageName,
          filePath: blob.filePath,
          blobSha256,
          allowedRoles: roles,
          canonicalSymbol: target.canonicalSymbol,
          symbolName: target.name,
          role: 'import',
          span: imp.span,
          linePreview: (rawLines[imp.span.startLine - 1] ?? '').trim(),
          provenance: 'structural',
        };
        fileNode.occurrenceIds.push(impOcc.id);
        this.appendOccurrence(target.id, impOcc);
      }

      const defSpanKeys = new Set(
        structural.definitions.map((d) => `${d.span.startLine}:${d.span.startColumn}`)
      );

      for (const tok of structural.identifiers) {
        const spanKey = `${tok.span.startLine}:${tok.span.startColumn}`;
        if (defSpanKeys.has(spanKey) || importSpanKeys.has(spanKey)) {
          continue;
        }
        const target =
          importedSymbols.get(tok.name) ??
          this.resolveSymbolCandidatesByName(
            tenantId,
            repoId,
            tok.name,
            blob.packageName,
            undefined,
            blob.filePath
          )[0];
        if (!target) continue;

        const refOcc: GraphOccurrence = {
          id: `${fKey}::struct-ref::${spanKey}`,
          tenantId,
          repoId,
          packageName: blob.packageName,
          filePath: blob.filePath,
          blobSha256,
          allowedRoles: roles,
          canonicalSymbol: target.canonicalSymbol,
          symbolName: target.name,
          role: 'reference',
          span: tok.span,
          linePreview: (rawLines[tok.span.startLine - 1] ?? '').trim(),
          provenance: 'structural',
        };
        fileNode.occurrenceIds.push(refOcc.id);
        this.appendOccurrence(target.id, refOcc);
      }
    }
  }

  private resolveSymbolCandidatesByName(
    tenantId: string,
    repoId: string,
    leafName: string,
    currentPackage: string,
    sourceSpecifier?: string,
    currentFilePath?: string
  ): SymbolNode[] {
    const prefix = `${tenantId}::${repoId}::`;
    const ids = this.symbolIdsByLeafName.get(leafName);
    if (!ids) return [];

    const matches: SymbolNode[] = [];
    for (const id of ids) {
      if (!id.startsWith(prefix)) continue;
      const sym = this.symbols.get(id);
      if (sym && sym.definedInFile) {
        matches.push(sym);
      }
    }

    const specClean = sourceSpecifier?.replace(/^\.+?\//, '').replace(/\.(js|ts|py|rs|go)$/, '');
    matches.sort((a, b) => {
      const score = (s: SymbolNode): number => {
        let sc = 0;
        if (s.provenance === 'scip') sc += 8;
        if (specClean && (s.definedInFile?.includes(specClean) || s.packageName.includes(specClean))) {
          sc += 16;
        }
        if (currentFilePath && s.definedInFile === currentFilePath) sc += 6;
        if (s.packageName === currentPackage) sc += 4;
        if (s.kind !== 'method') sc += 1;
        return sc;
      };
      return score(b) - score(a);
    });

    return matches;
  }

  /**
   * Resolves symbol definitions matching a canonical SCIP symbol or short symbol name,
   * strictly enforcing pre-retrieval tenant & RBAC access controls.
   */
  public findDefinitions(
    repoId: string,
    symbolQuery: string,
    access: AccessContext
  ): NavigationHit[] {
    const hits: NavigationHit[] = [];
    const rNode = this.repositories.get(this.repoKey(access.tenantId, repoId));
    if (!rNode) return hits;

    const matchingSymbols = this.findPermittedSymbols(repoId, symbolQuery, access);
    for (const sym of matchingSymbols) {
      const occs = this.occurrencesBySymbol.get(sym.id) ?? [];
      for (const occ of occs) {
        if (occ.role !== 'definition') continue;
        if (!this.isPermitted(occ.tenantId, occ.packageName, occ.allowedRoles, access)) continue;
        hits.push({
          canonicalSymbol: sym.canonicalSymbol,
          symbolName: sym.name,
          kind: sym.kind,
          role: 'definition',
          packageName: occ.packageName,
          filePath: occ.filePath,
          blobSha256: occ.blobSha256,
          commitOid: rNode.commitOid,
          span: occ.span,
          linePreview: occ.linePreview,
          provenance: occ.provenance,
        });
      }
    }
    return hits;
  }

  /**
   * Finds all permitted references (and optionally imports) to a symbol across packages.
   */
  public findReferences(
    repoId: string,
    symbolQuery: string,
    access: AccessContext,
    options?: { includeImports?: boolean; includeDefinitions?: boolean }
  ): NavigationHit[] {
    const hits: NavigationHit[] = [];
    const rNode = this.repositories.get(this.repoKey(access.tenantId, repoId));
    if (!rNode) return hits;

    const includeImports = options?.includeImports ?? true;
    const includeDefinitions = options?.includeDefinitions ?? false;
    const matchingSymbols = this.findPermittedSymbols(repoId, symbolQuery, access);

    for (const sym of matchingSymbols) {
      const occs = this.occurrencesBySymbol.get(sym.id) ?? [];
      for (const occ of occs) {
        if (!this.isPermitted(occ.tenantId, occ.packageName, occ.allowedRoles, access)) continue;
        if (occ.role === 'reference') {
          // keep
        } else if (occ.role === 'import' && includeImports) {
          // keep
        } else if (occ.role === 'definition' && includeDefinitions) {
          // keep
        } else {
          continue;
        }
        hits.push({
          canonicalSymbol: sym.canonicalSymbol,
          symbolName: sym.name,
          kind: sym.kind,
          role: occ.role,
          packageName: occ.packageName,
          filePath: occ.filePath,
          blobSha256: occ.blobSha256,
          commitOid: rNode.commitOid,
          span: occ.span,
          linePreview: occ.linePreview,
          provenance: occ.provenance,
        });
      }
    }
    return hits;
  }

  /**
   * Finds concrete types/classes/structs implementing an interface, trait, or base protocol.
   */
  public findImplementations(
    repoId: string,
    interfaceQuery: string,
    access: AccessContext
  ): NavigationHit[] {
    const hits: NavigationHit[] = [];
    const rNode = this.repositories.get(this.repoKey(access.tenantId, repoId));
    if (!rNode) return hits;

    const targetInterfaces = this.findPermittedSymbols(repoId, interfaceQuery, access);
    for (const iface of targetInterfaces) {
      const implIds = this.implementationsByTarget.get(iface.id);
      if (!implIds) continue;
      for (const implId of implIds) {
        const implSym = this.symbols.get(implId);
        if (!implSym || !implSym.definedInFile || !implSym.definitionSpan) continue;
        if (!this.isPermitted(implSym.tenantId, implSym.packageName, implSym.allowedRoles, access)) {
          continue;
        }
        const fNode = this.files.get(this.fileKey(access.tenantId, repoId, implSym.definedInFile));
        if (!fNode) continue;
        const stored = this.storedSources.get(fNode.id);
        const linePreview =
          stored?.blob.content.split(/\r?\n/)[implSym.definitionSpan.startLine - 1]?.trim() ?? '';

        hits.push({
          canonicalSymbol: implSym.canonicalSymbol,
          symbolName: implSym.name,
          kind: implSym.kind,
          role: 'implementation',
          packageName: implSym.packageName,
          filePath: implSym.definedInFile,
          blobSha256: fNode.blobSha256,
          commitOid: rNode.commitOid,
          span: implSym.definitionSpan,
          linePreview,
          provenance: implSym.provenance,
        });
      }
    }
    return hits;
  }

  /**
   * Graph-propagated bug localization: combines query/symptom terms with 1-hop symbol
   * definition, implementation, and call/reference neighborhood scoring while strictly
   * enforcing tenant & RBAC pre-filters prior to candidate scoring.
   */
  public localizeBugFiles(
    repoId: string,
    symptomQuery: string,
    access: AccessContext,
    topK = 5
  ): BugLocalizationHit[] {
    const rNode = this.repositories.get(this.repoKey(access.tenantId, repoId));
    if (!rNode) return [];

    // Extract raw query identifiers + camelCase / snake_case subwords
    const rawTokens: string[] = symptomQuery.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    const queryTerms = new Set<string>();
    for (const tok of rawTokens) {
      if (tok.length >= 3) queryTerms.add(tok);
      const splitCamel = tok.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/);
      for (const sub of splitCamel) {
        if (sub.length >= 3) queryTerms.add(sub.toLowerCase());
      }
    }

    const fileScores = new Map<string, { score: number; matchedSymbols: Set<string>; rationale: string[] }>();
    const bump = (filePath: string, delta: number, symName?: string, reason?: string) => {
      const fNode = this.files.get(this.fileKey(access.tenantId, repoId, filePath));
      if (!fNode) return;
      if (!this.isPermitted(fNode.tenantId, fNode.packageName, fNode.allowedRoles, access)) {
        return;
      }
      let entry = fileScores.get(filePath);
      if (!entry) {
        entry = { score: 0, matchedSymbols: new Set(), rationale: [] };
        fileScores.set(filePath, entry);
      }
      entry.score += delta;
      if (symName) entry.matchedSymbols.add(symName);
      if (reason && entry.rationale.length < 4 && !entry.rationale.includes(reason)) {
        entry.rationale.push(reason);
      }
    };

    const prefix = `${access.tenantId}::${repoId}::`;
    for (const [symId, sym] of this.symbols.entries()) {
      if (!symId.startsWith(prefix)) continue;
      if (!this.isPermitted(sym.tenantId, sym.packageName, sym.allowedRoles, access)) continue;

      const exactMatch = rawTokens.includes(sym.name);
      const symSubwords = sym.name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[\s_]+/)
        .filter((w) => w.length >= 3);
      const subHits = symSubwords.filter((w) => queryTerms.has(w)).length;

      if (!exactMatch && subHits === 0) continue;

      const baseWeight = exactMatch ? 14.0 : subHits * 4.5;
      if (sym.definedInFile) {
        bump(
          sym.definedInFile,
          baseWeight * (sym.provenance === 'scip' ? 1.25 : 1.0),
          sym.name,
          `defines ${sym.kind} ${sym.name}`
        );
      }

      // 1-hop graph propagation: concrete implementations of matched interfaces/traits!
      const implSet = this.implementationsByTarget.get(sym.id);
      if (implSet) {
        for (const implId of implSet) {
          const implSym = this.symbols.get(implId);
          if (implSym?.definedInFile) {
            bump(
              implSym.definedInFile,
              baseWeight * 0.95,
              implSym.name,
              `implements ${sym.name} via ${implSym.name}`
            );
          }
        }
      }

      // 1-hop reverse & forward symbol references
      const occs = this.occurrencesBySymbol.get(sym.id) ?? [];
      for (const occ of occs) {
        if (occ.role === 'reference') {
          bump(occ.filePath, baseWeight * 0.35, sym.name, `references ${sym.name}`);
        }
      }
    }

    // Secondary path-segment match on permitted files only
    for (const [fKey, fNode] of this.files.entries()) {
      if (!fKey.startsWith(prefix)) continue;
      if (!this.isPermitted(fNode.tenantId, fNode.packageName, fNode.allowedRoles, access)) continue;
      const lowerPath = fNode.filePath.toLowerCase();
      for (const term of queryTerms) {
        if (term.length >= 4 && lowerPath.includes(term.toLowerCase())) {
          bump(fNode.filePath, 1.5, undefined, `path matches ${term}`);
        }
      }
    }

    const results: BugLocalizationHit[] = [];
    for (const [filePath, info] of fileScores.entries()) {
      const fNode = this.files.get(this.fileKey(access.tenantId, repoId, filePath))!;
      results.push({
        filePath,
        packageName: fNode.packageName,
        blobSha256: fNode.blobSha256,
        commitOid: rNode.commitOid,
        score: Number(info.score.toFixed(3)),
        matchedSymbols: Array.from(info.matchedSymbols),
        rationale: info.rationale,
      });
    }

    results.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
    return results.slice(0, topK);
  }

  private findPermittedSymbols(
    repoId: string,
    symbolQuery: string,
    access: AccessContext
  ): SymbolNode[] {
    const prefix = `${access.tenantId}::${repoId}::`;
    const exactKey = this.symbolKey(access.tenantId, repoId, symbolQuery);
    const exact = this.symbols.get(exactKey);
    if (exact) {
      return this.isPermitted(exact.tenantId, exact.packageName, exact.allowedRoles, access)
        ? [exact]
        : [];
    }

    // Check `Type#method` or `Type.method` qualified lookup
    const qualSep = symbolQuery.includes('#') ? '#' : symbolQuery.includes('.') ? '.' : undefined;
    let enclosingFilter: string | undefined;
    let leafLookup = symbolQuery;
    if (qualSep) {
      const parts = symbolQuery.split(qualSep);
      if (parts.length === 2 && parts[0] && parts[1]) {
        enclosingFilter = parts[0];
        leafLookup = parts[1];
      }
    }

    const candidateIds = this.symbolIdsByLeafName.get(leafLookup);
    if (!candidateIds) return [];

    const out: SymbolNode[] = [];
    for (const id of candidateIds) {
      if (!id.startsWith(prefix)) continue;
      const sym = this.symbols.get(id);
      if (!sym) continue;
      if (enclosingFilter && sym.enclosingSymbol !== enclosingFilter) continue;
      if (!this.isPermitted(sym.tenantId, sym.packageName, sym.allowedRoles, access)) continue;
      out.push(sym);
    }
    return out;
  }

  /**
   * Computes a deterministic SHA-256 digest of the derived symbol/occurrence/implementation
   * graph so incremental commit updates can be proved bit-identical to full cold rebuilds.
   */
  public computeGraphDigest(tenantId?: string, repoId?: string): string {
    const prefix = tenantId && repoId ? `${tenantId}::${repoId}::` : '';
    const rows: string[] = [];

    for (const [k, f] of Array.from(this.files.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (prefix && !k.startsWith(prefix)) continue;
      rows.push(`F|${f.id}|${f.commitOid}|${f.blobSha256}|${f.indexSource}`);
    }
    for (const [k, s] of Array.from(this.symbols.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (prefix && !k.startsWith(prefix)) continue;
      const impls = Array.from(s.implementedInterfaces).sort().join(',');
      rows.push(
        `S|${s.id}|${s.kind}|${s.definedInFile ?? ''}|${s.definitionSpan?.startLine ?? 0}|${impls}`
      );
    }
    for (const [k, occs] of Array.from(this.occurrencesBySymbol.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      if (prefix && !k.startsWith(prefix)) continue;
      const sortedOccs = [...occs].sort((a, b) =>
        `${a.filePath}:${a.span.startLine}:${a.span.startColumn}:${a.role}`.localeCompare(
          `${b.filePath}:${b.span.startLine}:${b.span.startColumn}:${b.role}`
        )
      );
      for (const o of sortedOccs) {
        rows.push(`O|${k}|${o.role}|${o.filePath}|${o.span.startLine}:${o.span.startColumn}`);
      }
    }

    return sha256Hex(rows.join('\n'));
  }

  public getMemoryStats(): GraphMemoryStats {
    let occurrences = 0;
    let estBytes = 0;
    for (const [k, list] of this.occurrencesBySymbol.entries()) {
      occurrences += list.length;
      estBytes += k.length * 2 + list.length * 168;
    }
    let implementationEdges = 0;
    for (const set of this.implementationsByTarget.values()) {
      implementationEdges += set.size;
    }
    estBytes += this.files.size * 220 + this.symbols.size * 240 + implementationEdges * 64;
    return {
      repositories: this.repositories.size,
      packages: this.packages.size,
      files: this.files.size,
      symbols: this.symbols.size,
      occurrences,
      implementationEdges,
      estimatedMemoryBytes: estBytes,
    };
  }
}

/**
 * Opt-in read-only MCP tool bindings over `CodeKnowledgeGraph`.
 */
export function createCodeGraphTools(graph: CodeKnowledgeGraph): Tool[] {
  const makeResult = (payload: unknown): ToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  });

  return [
    {
      name: 'code_graph_definition',
      description: 'Resolve compiler-aware SCIP + Tree-sitter symbol definitions with tenant isolation',
      inputSchema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string' },
          repoId: { type: 'string' },
          symbol: { type: 'string' },
          principalRoles: { type: 'array', items: { type: 'string' } },
        },
        required: ['tenantId', 'repoId', 'symbol'],
      },
      handler: async (args) =>
        makeResult(
          graph.findDefinitions(args.repoId, args.symbol, {
            tenantId: args.tenantId,
            principalRoles: args.principalRoles,
          })
        ),
    },
    {
      name: 'code_graph_references',
      description: 'Find cross-package symbol references and imports in the versioned symbol graph',
      inputSchema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string' },
          repoId: { type: 'string' },
          symbol: { type: 'string' },
          principalRoles: { type: 'array', items: { type: 'string' } },
        },
        required: ['tenantId', 'repoId', 'symbol'],
      },
      handler: async (args) =>
        makeResult(
          graph.findReferences(args.repoId, args.symbol, {
            tenantId: args.tenantId,
            principalRoles: args.principalRoles,
          })
        ),
    },
    {
      name: 'code_graph_implementations',
      description: 'Find concrete classes, structs, and Go/Rust/TS/Python implementations of an interface or trait',
      inputSchema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string' },
          repoId: { type: 'string' },
          interfaceSymbol: { type: 'string' },
          principalRoles: { type: 'array', items: { type: 'string' } },
        },
        required: ['tenantId', 'repoId', 'interfaceSymbol'],
      },
      handler: async (args) =>
        makeResult(
          graph.findImplementations(args.repoId, args.interfaceSymbol, {
            tenantId: args.tenantId,
            principalRoles: args.principalRoles,
          })
        ),
    },
    {
      name: 'code_graph_localize_bug',
      description: 'Rank bug-localization candidate files via 1-hop symbol, implementation, and reference graph propagation',
      inputSchema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string' },
          repoId: { type: 'string' },
          symptomQuery: { type: 'string' },
          topK: { type: 'number' },
          principalRoles: { type: 'array', items: { type: 'string' } },
        },
        required: ['tenantId', 'repoId', 'symptomQuery'],
      },
      handler: async (args) =>
        makeResult(
          graph.localizeBugFiles(
            args.repoId,
            args.symptomQuery,
            {
              tenantId: args.tenantId,
              principalRoles: args.principalRoles,
            },
            args.topK ?? 5
          )
        ),
    },
  ];
}
