/**
 * AST-Aware Structural Edits, Semantic Diffs & Incremental Test Selection (HIP-1347, Issue #38).
 *
 * Clean-room MIT TypeScript implementation providing:
 * 1. Canonical blob identities with pre-retrieval multi-tenant & RBAC access control,
 *    plus deterministic derived symbol/dependency indexes that rebuild cleanly from source records.
 * 2. Polyglot lexical-state-aware structural AST search & constrained rewrite engine
 *    (inspired by ast-grep MIT metavariable semantics: `$NODE`, `$$$VARIADIC`, repeated-capture
 *    unification, comment/string literal immunity, and pre-flight syntax gating).
 * 3. Symbol-level semantic diffing and cross-package contract break detection
 *    (arity, parameter/return types, visibility narrowing, and un-updated cross-package callsites).
 * 4. Dependency-confidence incremental test selection with automatic 3-tier escalation
 *    (`minimal_targeted` -> `package_and_dependents` -> `full_suite_escalation`) whenever
 *    dynamic reflection, global config changes, cross-package breaks, or sparse test links lower confidence.
 */

import * as crypto from 'crypto';
import * as path from 'path';

export type SupportedAstLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'json';

export type SemanticErrorCode =
  | 'TENANT_MISMATCH'
  | 'RBAC_DENIED'
  | 'INVALID_PATH'
  | 'INVALID_PATTERN'
  | 'SYNTAX_VALIDATION_FAILED';

export class SemanticPlannerError extends Error {
  public readonly code: SemanticErrorCode;

  constructor(code: SemanticErrorCode, message: string) {
    super(message);
    this.name = 'SemanticPlannerError';
    this.code = code;
  }
}

export interface TenantAccessContext {
  tenantId: string;
  callerRoles?: readonly string[];
  repoId?: string;
}

export interface SourceBlobInput {
  tenantId: string;
  repoId: string;
  filePath: string;
  content: string;
  commitVersion?: string;
  packageName?: string;
  language?: SupportedAstLanguage;
  isTestFile?: boolean;
  allowedRoles?: readonly string[];
}

export interface CanonicalBlobRecord {
  readonly blobId: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly packageName: string;
  readonly filePath: string;
  readonly commitVersion: string;
  readonly sha256: string;
  readonly language: SupportedAstLanguage;
  readonly isTestFile: boolean;
  readonly allowedRoles: readonly string[];
  readonly content: string;
}

export interface AstLexToken {
  readonly kind: 'ident' | 'number' | 'string' | 'punct';
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface StructuralValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly string[];
}

export type MetavarConstraintKind = 'any' | 'identifier' | 'literal' | 'call_expression';

export interface AstRewriteRule {
  readonly id: string;
  readonly pattern: string;
  readonly replacement?: string;
  readonly languages?: readonly SupportedAstLanguage[];
  readonly packageFilter?: readonly string[];
  readonly fileGlobPrefix?: string;
  readonly includeTests?: boolean;
  readonly metavarKinds?: Readonly<Record<string, MetavarConstraintKind>>;
  readonly forbiddenMetavarPattern?: Readonly<Record<string, string>>;
}

export interface StructuralMatch {
  readonly ruleId: string;
  readonly filePath: string;
  readonly packageName: string;
  readonly blobId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly matchedText: string;
  readonly captures: Readonly<Record<string, string>>;
  readonly replacementText?: string;
}

export interface ConstrainedFileEdit {
  readonly filePath: string;
  readonly packageName: string;
  readonly baseBlobId: string;
  readonly baseSha256: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly afterSha256: string;
  readonly appliedRuleIds: readonly string[];
  readonly matchCount: number;
  readonly syntaxValidation: StructuralValidationResult;
}

export interface SymbolParameterSpec {
  readonly name: string;
  readonly typeAnnotation: string;
  readonly optionalOrDefault: boolean;
  readonly variadic: boolean;
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'struct'
  | 'type'
  | 'const';

export interface ExtractedSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly params: readonly SymbolParameterSpec[];
  readonly minArgs: number;
  readonly maxArgs: number | null;
  readonly returnType: string;
  readonly signatureNormalized: string;
  readonly bodyTokenHash: string;
}

export interface ExtractedCallSite {
  readonly callee: string;
  readonly receiver?: string;
  readonly enclosingSymbol: string;
  readonly line: number;
  readonly argCount: number;
}

export interface ExtractedImport {
  readonly specifier: string;
  readonly resolvedPackage?: string;
  readonly importedSymbols: readonly string[];
  readonly isWildcard: boolean;
  readonly line: number;
}

export interface DerivedFileEntry {
  readonly blobId: string;
  readonly sha256: string;
  readonly commitVersion: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly packageName: string;
  readonly filePath: string;
  readonly language: SupportedAstLanguage;
  readonly isTestFile: boolean;
  readonly codeTokenHash: string;
  readonly dynamicHazardSignals: readonly string[];
  readonly isGlobalConfig: boolean;
  readonly symbols: readonly ExtractedSymbol[];
  readonly imports: readonly ExtractedImport[];
  readonly callSites: readonly ExtractedCallSite[];
}

export type SemanticChangeKind =
  | 'formatting_or_comment_only'
  | 'body_implementation_changed'
  | 'compatible_signature_extension'
  | 'breaking_arity_change'
  | 'breaking_param_type_change'
  | 'breaking_return_type_change'
  | 'symbol_removed_or_unexported'
  | 'symbol_added'
  | 'config_or_data_modified';

export interface SemanticSymbolDelta {
  readonly filePath: string;
  readonly packageName: string;
  readonly symbolName: string;
  readonly symbolKind: SymbolKind | 'module';
  readonly changeKind: SemanticChangeKind;
  readonly breakingContract: boolean;
  readonly beforeSignature?: string;
  readonly afterSignature?: string;
  readonly summary: string;
}

export interface IncompatibleCrossPackageChange {
  readonly sourcePackage: string;
  readonly sourceFile: string;
  readonly symbolName: string;
  readonly changeKind: SemanticChangeKind;
  readonly consumerPackage: string;
  readonly consumerFile: string;
  readonly consumerSymbol: string;
  readonly consumerLine: number;
  readonly reason: string;
}

export interface SemanticDiffReport {
  readonly changedFilesCount: number;
  readonly formattingOnlyFiles: readonly string[];
  readonly affectedSymbols: readonly string[];
  readonly affectedCallers: readonly {
    readonly filePath: string;
    readonly packageName: string;
    readonly callerSymbol: string;
    readonly calleeSymbol: string;
    readonly line: number;
    readonly crossPackage: boolean;
  }[];
  readonly deltas: readonly SemanticSymbolDelta[];
  readonly crossPackageBreakages: readonly IncompatibleCrossPackageChange[];
  readonly hasBreakingCrossPackageChanges: boolean;
}

export type TestSelectionTier =
  | 'none_formatting_only'
  | 'minimal_targeted'
  | 'package_and_dependents'
  | 'full_suite_escalation';

export interface IncrementalTestSelection {
  readonly tier: TestSelectionTier;
  readonly dependencyConfidence: number;
  readonly confidenceReasons: readonly string[];
  readonly selectedTests: readonly string[];
  readonly totalAvailableTests: number;
  readonly reductionRatio: number;
  readonly escalated: boolean;
  readonly validationContract: {
    readonly requiresCompilerCheck: true;
    readonly requiresSelectedTestsPass: true;
    readonly selectionIsNotSafetyProof: true;
    readonly disclaimer: string;
  };
}

export interface ExternalVerificationOutcome {
  readonly compilerPassed: boolean;
  readonly compilerDiagnostics: readonly string[];
  readonly testsRun: readonly string[];
  readonly failedTests: readonly string[];
}

export type VerificationRunner = (params: {
  readonly updatedBlobs: ReadonlyMap<string, string>;
  readonly selectedTests: readonly string[];
  readonly tier: TestSelectionTier;
}) => ExternalVerificationOutcome;

export interface SemanticChangePlanResult {
  readonly edits: readonly ConstrainedFileEdit[];
  readonly rejectedEdits: readonly ConstrainedFileEdit[];
  readonly semanticDiff: SemanticDiffReport;
  readonly testSelection: IncrementalTestSelection;
  readonly verification?: ExternalVerificationOutcome;
  readonly readyToApply: boolean;
  readonly blockingReasons: readonly string[];
}

export interface PlannerThresholds {
  readonly highConfidenceThreshold?: number;
  readonly lowConfidenceThreshold?: number;
  readonly historicalCoFailureMap?: Readonly<Record<string, readonly string[]>>;
}

// ── Utility & Identity Helpers ──────────────────────────────────────────

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeRepoPath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0')) {
    throw new SemanticPlannerError('INVALID_PATH', 'File path must be non-empty and free of NUL bytes');
  }
  const slashPath = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(slashPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new SemanticPlannerError('INVALID_PATH', `Path traversal rejected: ${rawPath}`);
  }
  return normalized;
}

export function inferLanguage(filePath: string): SupportedAstLanguage {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript';
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'javascript';
  }
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.json')) return 'json';
  return 'typescript';
}

export function inferPackageName(filePath: string): string {
  const parts = filePath.split('/');
  if (
    parts.length >= 3 &&
    (parts[0] === 'packages' || parts[0] === 'crates' || parts[0] === 'services' || parts[0] === 'apps' || parts[0] === 'modules')
  ) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts.length >= 2 && parts[0] !== 'src' && parts[0] !== 'test' && parts[0] !== 'tests') {
    return parts[0];
  }
  return 'root';
}

export function inferIsTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = path.posix.basename(lower);
  return (
    lower.startsWith('test/') ||
    lower.startsWith('tests/') ||
    lower.includes('/__tests__/') ||
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    base.endsWith('.test.ts') ||
    base.endsWith('.spec.ts') ||
    base.endsWith('.test.tsx') ||
    base.endsWith('.test.js') ||
    base.endsWith('.spec.js') ||
    base.endsWith('_test.go') ||
    base.endsWith('_test.rs') ||
    base.endsWith('_test.py') ||
    base.startsWith('test_')
  );
}

export function createCanonicalBlobRecord(input: SourceBlobInput): CanonicalBlobRecord {
  if (!input.tenantId || !input.tenantId.trim()) {
    throw new SemanticPlannerError('TENANT_MISMATCH', 'Canonical blob requires a non-empty tenantId');
  }
  if (!input.repoId || !input.repoId.trim()) {
    throw new SemanticPlannerError('INVALID_PATH', 'Canonical blob requires a non-empty repoId');
  }
  const filePath = normalizeRepoPath(input.filePath);
  const commitVersion = (input.commitVersion ?? 'HEAD').trim() || 'HEAD';
  const sha = sha256Hex(input.content);
  const language = input.language ?? inferLanguage(filePath);
  const packageName = input.packageName ?? inferPackageName(filePath);
  const isTestFile = input.isTestFile ?? inferIsTestFile(filePath);
  const allowedRoles = input.allowedRoles ? [...input.allowedRoles] : [];
  const blobId = `${input.tenantId}:${input.repoId}:${filePath}@${commitVersion}:${sha.slice(0, 16)}`;

  return {
    blobId,
    tenantId: input.tenantId,
    repoId: input.repoId,
    packageName,
    filePath,
    commitVersion,
    sha256: sha,
    language,
    isTestFile,
    allowedRoles,
    content: input.content,
  };
}

export function checkBlobAccess(blob: CanonicalBlobRecord, access: TenantAccessContext): boolean {
  if (!access.tenantId || blob.tenantId !== access.tenantId) {
    return false;
  }
  if (access.repoId && blob.repoId !== access.repoId) {
    return false;
  }
  if (blob.allowedRoles.length > 0) {
    const caller = access.callerRoles ?? [];
    const matched = blob.allowedRoles.some((r) => caller.includes(r));
    if (!matched) return false;
  }
  return true;
}

// ── Polyglot Lexical-State-Aware Tokenizer ──────────────────────────────

export interface LexScanOutput {
  readonly tokens: readonly AstLexToken[];
  readonly diagnostics: readonly string[];
}

const MULTI_CHAR_PUNCT = [
  '===', '!==', '>>>', '...', '::=',
  '==', '!=', '<=', '>=', '=>', '->', '::', '&&', '||', '??',
  '+=', '-=', '*=', '/=', ':=', '..', '<<', '>>',
];

export function tokenizeCodeLexical(source: string, language: SupportedAstLanguage): LexScanOutput {
  const tokens: AstLexToken[] = [];
  const diagnostics: string[] = [];
  const len = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const advanceNewlines = (segment: string, baseOffset: number) => {
    for (let k = 0; k < segment.length; k++) {
      if (segment[k] === '\n') {
        line++;
        lineStart = baseOffset + k + 1;
      }
    }
  };

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : '';

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      i++;
      continue;
    }

    // Python '#' comments
    if (language === 'python' && ch === '#') {
      while (i < len && source[i] !== '\n') i++;
      continue;
    }

    // C-family '//' line comments
    if (language !== 'python' && language !== 'json' && ch === '/' && next === '/') {
      while (i < len && source[i] !== '\n') i++;
      continue;
    }

    // C-family '/* ... */' block comments
    if (language !== 'python' && language !== 'json' && ch === '/' && next === '*') {
      const startLine = line;
      const closeIdx = source.indexOf('*/', i + 2);
      if (closeIdx === -1) {
        diagnostics.push(`Unterminated block comment starting at line ${startLine}`);
        break;
      }
      advanceNewlines(source.slice(i, closeIdx + 2), i);
      i = closeIdx + 2;
      continue;
    }

    // Python triple-quoted strings / docstrings
    if (
      language === 'python' &&
      ((ch === '"' && source.slice(i, i + 3) === '"""') ||
        (ch === "'" && source.slice(i, i + 3) === "'''"))
    ) {
      const delim = source.slice(i, i + 3);
      const tokLine = line;
      const tokCol = i - lineStart + 1;
      const start = i;
      i += 3;
      let closed = false;
      while (i < len) {
        if (source[i] === '\\') {
          advanceNewlines(source.slice(i, Math.min(len, i + 2)), i);
          i += 2;
          continue;
        }
        if (source.slice(i, i + 3) === delim) {
          i += 3;
          closed = true;
          break;
        }
        if (source[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (!closed) {
        diagnostics.push(`Unterminated triple-quoted string starting at line ${tokLine}`);
      }
      tokens.push({
        kind: 'string',
        text: source.slice(start, i),
        start,
        end: i,
        line: tokLine,
        column: tokCol,
      });
      continue;
    }

    // Rust raw string r#"..."# or r"..."
    if (language === 'rust' && ch === 'r' && (next === '"' || next === '#')) {
      let hashes = 0;
      let cursor = i + 1;
      while (cursor < len && source[cursor] === '#') {
        hashes++;
        cursor++;
      }
      if (cursor < len && source[cursor] === '"') {
        const tokLine = line;
        const tokCol = i - lineStart + 1;
        const start = i;
        const closer = '"' + '#'.repeat(hashes);
        const closeIdx = source.indexOf(closer, cursor + 1);
        if (closeIdx === -1) {
          diagnostics.push(`Unterminated Rust raw string starting at line ${tokLine}`);
          i = len;
        } else {
          advanceNewlines(source.slice(start, closeIdx + closer.length), start);
          i = closeIdx + closer.length;
        }
        tokens.push({
          kind: 'string',
          text: source.slice(start, i),
          start,
          end: i,
          line: tokLine,
          column: tokCol,
        });
        continue;
      }
    }

    // Rust lifetime `'a` vs char literal `'x'`
    if (language === 'rust' && ch === "'") {
      // Check if char literal `'x'` or `'\n'`
      if (i + 2 < len && source[i + 1] !== '\\' && source[i + 2] === "'") {
        const tokCol = i - lineStart + 1;
        tokens.push({ kind: 'string', text: source.slice(i, i + 3), start: i, end: i + 3, line, column: tokCol });
        i += 3;
        continue;
      }
      if (i + 3 < len && source[i + 1] === '\\' && source[i + 3] === "'") {
        const tokCol = i - lineStart + 1;
        tokens.push({ kind: 'string', text: source.slice(i, i + 4), start: i, end: i + 4, line, column: tokCol });
        i += 4;
        continue;
      }
      // Rust lifetime token `'ident`
      let end = i + 1;
      while (end < len && /[A-Za-z0-9_]/.test(source[end])) end++;
      tokens.push({ kind: 'ident', text: source.slice(i, end), start: i, end, line, column: i - lineStart + 1 });
      i = end;
      continue;
    }

    // Standard quoted strings ('...', "...", `...`)
    if (ch === '"' || ch === "'" || (ch === '`' && (language === 'typescript' || language === 'javascript' || language === 'go'))) {
      const quote = ch;
      const start = i;
      const tokLine = line;
      const tokCol = i - lineStart + 1;
      const allowMultiline = quote === '`';
      i++;
      let closed = false;
      while (i < len) {
        const c = source[i];
        if (c === '\\' && !(language === 'go' && quote === '`')) {
          advanceNewlines(source.slice(i, Math.min(len, i + 2)), i);
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          closed = true;
          break;
        }
        if (c === '\n') {
          if (!allowMultiline) {
            diagnostics.push(`Unterminated string literal at line ${tokLine}`);
            break;
          }
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (!closed && allowMultiline) {
        diagnostics.push(`Unterminated template/raw literal starting at line ${tokLine}`);
      }
      tokens.push({
        kind: 'string',
        text: source.slice(start, i),
        start,
        end: i,
        line: tokLine,
        column: tokCol,
      });
      continue;
    }

    // Identifiers & Metavariables ($NAME / $$$VARIADIC)
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      const tokCol = i - lineStart + 1;
      if (ch === '$' && source.slice(i, i + 3) === '$$$') {
        i += 3;
        while (i < len && /[A-Za-z0-9_]/.test(source[i])) i++;
      } else {
        i++;
        while (i < len && /[A-Za-z0-9_$]/.test(source[i])) i++;
      }
      tokens.push({
        kind: 'ident',
        text: source.slice(start, i),
        start,
        end: i,
        line,
        column: tokCol,
      });
      continue;
    }

    // Numeric literals
    if (/[0-9]/.test(ch)) {
      const start = i;
      const tokCol = i - lineStart + 1;
      i++;
      while (i < len && /[0-9A-Za-z_.]/.test(source[i])) i++;
      tokens.push({
        kind: 'number',
        text: source.slice(start, i),
        start,
        end: i,
        line,
        column: tokCol,
      });
      continue;
    }

    // Multi-char punctuation / operators
    let matchedMulti = '';
    for (const op of MULTI_CHAR_PUNCT) {
      if (source.startsWith(op, i)) {
        matchedMulti = op;
        break;
      }
    }
    if (matchedMulti) {
      tokens.push({
        kind: 'punct',
        text: matchedMulti,
        start: i,
        end: i + matchedMulti.length,
        line,
        column: i - lineStart + 1,
      });
      i += matchedMulti.length;
      continue;
    }

    // Single-char punctuation / delimiter
    tokens.push({
      kind: 'punct',
      text: ch,
      start: i,
      end: i + 1,
      line,
      column: i - lineStart + 1,
    });
    i++;
  }

  return { tokens, diagnostics };
}

// ── Pre-Flight Structural Syntax Validation ─────────────────────────────

export function validateStructuralSyntax(
  content: string,
  language: SupportedAstLanguage
): StructuralValidationResult {
  const diagnostics: string[] = [];

  if (/^(<{7}|={7}|>{7})(\s|$)/m.test(content)) {
    diagnostics.push('Unresolved Git merge-conflict marker detected');
  }

  if (language === 'json') {
    try {
      JSON.parse(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`Invalid JSON: ${msg}`);
    }
    return { valid: diagnostics.length === 0, diagnostics };
  }

  const { tokens, diagnostics: lexDiagnostics } = tokenizeCodeLexical(content, language);
  diagnostics.push(...lexDiagnostics);

  const openToClose: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closeToOpen: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: { char: string; line: number; col: number }[] = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    const prev = idx > 0 ? tokens[idx - 1] : undefined;

    if (tok.kind === 'punct') {
      if (openToClose[tok.text]) {
        stack.push({ char: tok.text, line: tok.line, col: tok.column });
      } else if (closeToOpen[tok.text]) {
        const top = stack.pop();
        if (!top || top.char !== closeToOpen[tok.text]) {
          diagnostics.push(
            `Unmatched closing '${tok.text}' at line ${tok.line}:${tok.column}` +
              (top ? ` (expected '${openToClose[top.char]}' for '${top.char}' at line ${top.line})` : '')
          );
        }
      }

      // Catch malformed argument/parameter commas like `fn(, x)` or `fn(a,, b)`
      if (tok.text === ',' && prev?.kind === 'punct' && (prev.text === '(' || prev.text === ',')) {
        diagnostics.push(`Invalid consecutive or leading comma '${prev.text},' at line ${tok.line}:${tok.column}`);
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push(
      `Unclosed delimiter '${unclosed.char}' opened at line ${unclosed.line}:${unclosed.col}`
    );
  }

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  };
}

// ── Structural AST Pattern Compiler & Constrained Rewrite Engine ────────

interface PatternNode {
  readonly type: 'literal' | 'metavar' | 'variadic';
  readonly nameOrText: string;
}

function compileAstPattern(pattern: string, language: SupportedAstLanguage): readonly PatternNode[] {
  const { tokens, diagnostics } = tokenizeCodeLexical(pattern, language);
  if (diagnostics.length > 0 || tokens.length === 0) {
    throw new SemanticPlannerError(
      'INVALID_PATTERN',
      `Invalid structural AST pattern "${pattern}": ${diagnostics.join('; ') || 'empty pattern'}`
    );
  }
  return tokens.map((t) => {
    if (t.kind === 'ident' && /^\$\$\$[A-Z][A-Z0-9_]*$/.test(t.text)) {
      return { type: 'variadic', nameOrText: t.text };
    }
    if (t.kind === 'ident' && /^\$[A-Z][A-Z0-9_]*$/.test(t.text)) {
      return { type: 'metavar', nameOrText: t.text };
    }
    return { type: 'literal', nameOrText: t.text };
  });
}

function isBalancedTokenSlice(tokens: readonly AstLexToken[], startIdx: number, endIdxExclusive: number): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let i = startIdx; i < endIdxExclusive; i++) {
    const t = tokens[i];
    if (t.kind !== 'punct') continue;
    if (pairs[t.text]) {
      stack.push(pairs[t.text]);
    } else if (t.text === ')' || t.text === ']' || t.text === '}') {
      const expected = stack.pop();
      if (expected !== t.text) return false;
    }
  }
  return stack.length === 0;
}

function findSingleNodeCandidateEnds(tokens: readonly AstLexToken[], startIdx: number): number[] {
  const ends: number[] = [];
  let depth = 0;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct') {
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        depth++;
      } else if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (t.text === ',' || t.text === ';')) {
        break;
      }
    }
    if (depth === 0) {
      ends.push(i + 1);
    }
  }
  return ends;
}

function findVariadicCandidateEnds(tokens: readonly AstLexToken[], startIdx: number): number[] {
  const ends: number[] = [startIdx]; // 0 tokens allowed for $$$VARIADIC
  let depth = 0;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct') {
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        depth++;
      } else if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && t.text === ';') {
        break;
      }
    }
    if (depth === 0) {
      ends.push(i + 1);
    }
  }
  return ends;
}

interface InternalCapture {
  readonly rawText: string;
  readonly normalizedTokens: string;
  readonly sliceTokens: readonly AstLexToken[];
}

function checkMetavarKind(
  capture: InternalCapture,
  kind: MetavarConstraintKind | undefined
): boolean {
  if (!kind || kind === 'any') return true;
  if (kind === 'identifier') {
    return capture.sliceTokens.length === 1 && capture.sliceTokens[0].kind === 'ident';
  }
  if (kind === 'literal') {
    return (
      capture.sliceTokens.length === 1 &&
      (capture.sliceTokens[0].kind === 'string' || capture.sliceTokens[0].kind === 'number')
    );
  }
  if (kind === 'call_expression') {
    return (
      capture.sliceTokens.length >= 3 &&
      capture.sliceTokens.some((t) => t.kind === 'punct' && t.text === '(') &&
      capture.sliceTokens[capture.sliceTokens.length - 1].text === ')'
    );
  }
  return true;
}

function matchPatternAt(
  pNodes: readonly PatternNode[],
  pIdx: number,
  tokens: readonly AstLexToken[],
  tIdx: number,
  source: string,
  rule: AstRewriteRule,
  captures: Map<string, InternalCapture>
): number | null {
  if (pIdx === pNodes.length) {
    return tIdx;
  }
  const node = pNodes[pIdx];

  if (node.type === 'literal') {
    if (tIdx < tokens.length && tokens[tIdx].text === node.nameOrText) {
      const matched = matchPatternAt(pNodes, pIdx + 1, tokens, tIdx + 1, source, rule, captures);
      if (matched !== null) return matched;
    }
    // Optional comma separator before an empty $$$VARIADIC tail (ast-grep `fn($A, $$$REST)` on `fn(x)`)
    if (
      node.nameOrText === ',' &&
      pIdx + 1 < pNodes.length &&
      pNodes[pIdx + 1].type === 'variadic'
    ) {
      const varName = pNodes[pIdx + 1].nameOrText;
      const emptyCap: InternalCapture = { rawText: '', normalizedTokens: '', sliceTokens: [] };
      const prevCap = captures.get(varName);
      if (!prevCap || prevCap.normalizedTokens === '') {
        if (!prevCap) captures.set(varName, emptyCap);
        const res = matchPatternAt(pNodes, pIdx + 2, tokens, tIdx, source, rule, captures);
        if (res !== null) return res;
        if (!prevCap) captures.delete(varName);
      }
    }
    return null;
  }

  if (node.type === 'metavar') {
    const candidates = findSingleNodeCandidateEnds(tokens, tIdx);
    // Prefer greedy balanced expression when followed by an explicit delimiter, shortest otherwise
    const nextIsDelimiter = pIdx + 1 < pNodes.length && pNodes[pIdx + 1].type === 'literal';
    const orderedEnds = nextIsDelimiter ? [...candidates].reverse() : candidates;

    for (const endIdx of orderedEnds) {
      if (!isBalancedTokenSlice(tokens, tIdx, endIdx)) continue;
      const sliceTokens = tokens.slice(tIdx, endIdx);
      const rawText = source.slice(sliceTokens[0].start, sliceTokens[sliceTokens.length - 1].end);
      const normalizedTokens = sliceTokens.map((t) => t.text).join(' ');
      const cap: InternalCapture = { rawText, normalizedTokens, sliceTokens };

      if (!checkMetavarKind(cap, rule.metavarKinds?.[node.nameOrText])) continue;
      const forbiddenRe = rule.forbiddenMetavarPattern?.[node.nameOrText];
      if (forbiddenRe && new RegExp(forbiddenRe).test(rawText)) continue;

      const existing = captures.get(node.nameOrText);
      if (existing) {
        if (existing.normalizedTokens !== normalizedTokens) continue;
        const res = matchPatternAt(pNodes, pIdx + 1, tokens, endIdx, source, rule, captures);
        if (res !== null) return res;
      } else {
        captures.set(node.nameOrText, cap);
        const res = matchPatternAt(pNodes, pIdx + 1, tokens, endIdx, source, rule, captures);
        if (res !== null) return res;
        captures.delete(node.nameOrText);
      }
    }
    return null;
  }

  // Variadic $$$NAME
  const varEnds = findVariadicCandidateEnds(tokens, tIdx);
  for (let k = varEnds.length - 1; k >= 0; k--) {
    const endIdx = varEnds[k];
    if (!isBalancedTokenSlice(tokens, tIdx, endIdx)) continue;
    const sliceTokens = tokens.slice(tIdx, endIdx);
    const rawText =
      sliceTokens.length === 0
        ? ''
        : source.slice(sliceTokens[0].start, sliceTokens[sliceTokens.length - 1].end);
    const normalizedTokens = sliceTokens.map((t) => t.text).join(' ');
    const cap: InternalCapture = { rawText, normalizedTokens, sliceTokens };

    const forbiddenRe = rule.forbiddenMetavarPattern?.[node.nameOrText];
    if (forbiddenRe && new RegExp(forbiddenRe).test(rawText)) continue;

    const existing = captures.get(node.nameOrText);
    if (existing) {
      if (existing.normalizedTokens !== normalizedTokens) continue;
      const res = matchPatternAt(pNodes, pIdx + 1, tokens, endIdx, source, rule, captures);
      if (res !== null) return res;
    } else {
      captures.set(node.nameOrText, cap);
      const res = matchPatternAt(pNodes, pIdx + 1, tokens, endIdx, source, rule, captures);
      if (res !== null) return res;
      captures.delete(node.nameOrText);
    }
  }

  return null;
}

export function renderAstReplacement(
  template: string,
  captures: Readonly<Record<string, string>>,
  lineIndent: string
): string {
  let rendered = template;

  // First clean up empty variadic captures adjacent to commas:
  // e.g. `fn($A, $$$REST)` when `$$$REST === ""` -> `fn($A)` rather than `fn($A, )`
  const keys = Object.keys(captures).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const val = captures[key];
    if (key.startsWith('$$$') && val.trim() === '') {
      const escaped = key.replace(/\$/g, '\\$');
      rendered = rendered.replace(new RegExp(`,\\s*${escaped}\\b`, 'g'), '');
      rendered = rendered.replace(new RegExp(`${escaped}\\s*,\\s*`, 'g'), '');
      rendered = rendered.replace(new RegExp(escaped, 'g'), '');
    }
  }

  for (const key of keys) {
    const val = captures[key];
    const escaped = key.replace(/\$/g, '\\$');
    rendered = rendered.replace(new RegExp(escaped, 'g'), () => val);
  }

  if (rendered.includes('\n') && lineIndent.length > 0) {
    const lines = rendered.split('\n');
    return lines
      .map((ln, idx) => (idx === 0 || ln.trim() === '' ? ln : lineIndent + ln))
      .join('\n');
  }
  return rendered;
}

export function findStructuralMatchesInBlob(
  blob: CanonicalBlobRecord,
  rule: AstRewriteRule
): readonly StructuralMatch[] {
  if (rule.languages && !rule.languages.includes(blob.language)) {
    return [];
  }
  if (!rule.includeTests && blob.isTestFile) {
    return [];
  }
  if (rule.packageFilter && rule.packageFilter.length > 0 && !rule.packageFilter.includes(blob.packageName)) {
    return [];
  }
  if (rule.fileGlobPrefix && !blob.filePath.startsWith(rule.fileGlobPrefix)) {
    return [];
  }

  const pNodes = compileAstPattern(rule.pattern, blob.language);
  const { tokens } = tokenizeCodeLexical(blob.content, blob.language);
  const matches: StructuralMatch[] = [];

  let cursor = 0;
  while (cursor < tokens.length) {
    const capMap = new Map<string, InternalCapture>();
    const endTokenIdx = matchPatternAt(pNodes, 0, tokens, cursor, blob.content, rule, capMap);
    if (endTokenIdx !== null && endTokenIdx > cursor) {
      const firstTok = tokens[cursor];
      const lastTok = tokens[endTokenIdx - 1];
      const capturesObj: Record<string, string> = {};
      for (const [k, v] of capMap.entries()) {
        capturesObj[k] = v.rawText;
      }

      const lineStartIdx = blob.content.lastIndexOf('\n', firstTok.start - 1) + 1;
      const linePrefix = blob.content.slice(lineStartIdx, firstTok.start);
      const indentMatch = linePrefix.match(/^[ \t]*/);
      const lineIndent = indentMatch ? indentMatch[0] : '';

      const replacementText =
        rule.replacement !== undefined
          ? renderAstReplacement(rule.replacement, capturesObj, lineIndent)
          : undefined;

      matches.push({
        ruleId: rule.id,
        filePath: blob.filePath,
        packageName: blob.packageName,
        blobId: blob.blobId,
        startOffset: firstTok.start,
        endOffset: lastTok.end,
        startLine: firstTok.line,
        endLine: lastTok.line,
        matchedText: blob.content.slice(firstTok.start, lastTok.end),
        captures: capturesObj,
        replacementText,
      });
      cursor = endTokenIdx;
    } else {
      cursor++;
    }
  }

  return matches;
}

export function applyRulesToBlob(
  blob: CanonicalBlobRecord,
  rules: readonly AstRewriteRule[]
): ConstrainedFileEdit | null {
  let currentContent = blob.content;
  const appliedRuleIds: string[] = [];
  let totalMatches = 0;

  for (const rule of rules) {
    if (rule.replacement === undefined) continue;
    const tempBlob = createCanonicalBlobRecord({
      tenantId: blob.tenantId,
      repoId: blob.repoId,
      filePath: blob.filePath,
      packageName: blob.packageName,
      commitVersion: blob.commitVersion,
      language: blob.language,
      isTestFile: blob.isTestFile,
      allowedRoles: blob.allowedRoles,
      content: currentContent,
    });
    const matches = findStructuralMatchesInBlob(tempBlob, rule);
    if (matches.length === 0) continue;

    // Apply non-overlapping matches in reverse offset order
    let rewritten = currentContent;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      if (m.replacementText === undefined) continue;
      rewritten =
        rewritten.slice(0, m.startOffset) + m.replacementText + rewritten.slice(m.endOffset);
    }
    if (rewritten !== currentContent) {
      currentContent = rewritten;
      appliedRuleIds.push(rule.id);
      totalMatches += matches.length;
    }
  }

  if (currentContent === blob.content) {
    return null;
  }

  const syntaxValidation = validateStructuralSyntax(currentContent, blob.language);
  return {
    filePath: blob.filePath,
    packageName: blob.packageName,
    baseBlobId: blob.blobId,
    baseSha256: blob.sha256,
    beforeContent: blob.content,
    afterContent: currentContent,
    afterSha256: sha256Hex(currentContent),
    appliedRuleIds,
    matchCount: totalMatches,
    syntaxValidation,
  };
}

// ── Polyglot Symbol, Import & Call-Graph Extraction ─────────────────────

function splitTopLevelParams(rawParams: string): string[] {
  const trimmed = rawParams.trim();
  if (!trimmed) return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = trimmed.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseParameterSpecs(rawParams: string, language: SupportedAstLanguage): SymbolParameterSpec[] {
  const chunks = splitTopLevelParams(rawParams);
  const specs: SymbolParameterSpec[] = [];

  for (const chunk of chunks) {
    if (!chunk) continue;
    if (language === 'python' && (chunk === 'self' || chunk === 'cls' || chunk === '*' || chunk === '/')) {
      continue;
    }
    if (language === 'rust' && /^(&\s*(mut\s+)?self|mut\s+self|self)\b/.test(chunk)) {
      continue;
    }

    if (language === 'go') {
      const variadic = chunk.includes('...');
      const tokens = chunk.trim().split(/\s+/);
      const typeAnnotation = tokens.length >= 2 ? tokens.slice(1).join(' ') : tokens[0];
      const name = tokens.length >= 2 ? tokens[0] : '_';
      specs.push({
        name,
        typeAnnotation: typeAnnotation.replace(/\s+/g, ' ').trim(),
        optionalOrDefault: variadic,
        variadic,
      });
      continue;
    }

    const variadic = chunk.startsWith('...') || (language === 'python' && chunk.startsWith('*'));
    const hasDefault = chunk.includes('=');
    const noDefault = hasDefault ? chunk.slice(0, chunk.indexOf('=')).trim() : chunk.trim();
    const colonIdx = noDefault.indexOf(':');
    let rawName = colonIdx >= 0 ? noDefault.slice(0, colonIdx).trim() : noDefault;
    const typeAnnotation =
      colonIdx >= 0 ? noDefault.slice(colonIdx + 1).replace(/\s+/g, ' ').trim() : 'untyped';
    const isOptionalQuestion = rawName.endsWith('?');
    if (isOptionalQuestion) rawName = rawName.slice(0, -1).trim();
    rawName = rawName.replace(/^\.{3}|^\*{1,2}|^mut\s+/g, '').trim();

    specs.push({
      name: rawName || '_',
      typeAnnotation,
      optionalOrDefault: hasDefault || isOptionalQuestion || variadic,
      variadic,
    });
  }

  return specs;
}

function computeArityBounds(params: readonly SymbolParameterSpec[]): {
  minArgs: number;
  maxArgs: number | null;
} {
  let minArgs = 0;
  let hasVariadic = false;
  for (const p of params) {
    if (p.variadic) {
      hasVariadic = true;
    } else if (!p.optionalOrDefault) {
      minArgs++;
    }
  }
  return {
    minArgs,
    maxArgs: hasVariadic ? null : params.length,
  };
}

function findMatchingBraceEndToken(tokens: readonly AstLexToken[], startSearchIdx: number): number {
  let depth = 0;
  let seenBrace = false;
  for (let i = startSearchIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct') {
      if (t.text === '{') {
        depth++;
        seenBrace = true;
      } else if (t.text === '}') {
        depth--;
        if (seenBrace && depth === 0) return i;
      } else if (!seenBrace && t.text === ';') {
        return i;
      }
    }
  }
  return Math.min(tokens.length - 1, startSearchIdx + 20);
}

const LANGUAGE_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'return', 'catch', 'try', 'throw',
  'new', 'typeof', 'instanceof', 'delete', 'void', 'await', 'yield', 'import', 'export',
  'from', 'function', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'impl',
  'fn', 'pub', 'func', 'def', 'match', 'loop', 'where', 'sizeof', 'super', 'this', 'self',
]);

export function buildDerivedFileEntry(
  blob: CanonicalBlobRecord,
  knownPackageNames: ReadonlySet<string>
): DerivedFileEntry {
  const baseName = path.posix.basename(blob.filePath);
  const isGlobalConfig =
    baseName === 'package.json' ||
    baseName === 'tsconfig.json' ||
    baseName === 'Cargo.toml' ||
    baseName === 'go.mod' ||
    baseName.endsWith('.schema.json');

  if (blob.language === 'json') {
    return {
      blobId: blob.blobId,
      sha256: blob.sha256,
      commitVersion: blob.commitVersion,
      tenantId: blob.tenantId,
      repoId: blob.repoId,
      packageName: blob.packageName,
      filePath: blob.filePath,
      language: blob.language,
      isTestFile: blob.isTestFile,
      codeTokenHash: sha256Hex(blob.content.trim()),
      dynamicHazardSignals: [],
      isGlobalConfig,
      symbols: [],
      imports: [],
      callSites: [],
    };
  }

  const { tokens } = tokenizeCodeLexical(blob.content, blob.language);
  const codeTokenHash = sha256Hex(tokens.map((t) => `${t.kind}:${t.text}`).join('\n'));

  // Detect dynamic reflection / runtime dispatch hazards in non-comment code
  const dynamicHazardSignals: string[] = [];
  const joinedCode = tokens.map((t) => t.text).join(' ');
  if (/\beval\s*\(/.test(joinedCode) || /\bFunction\s*\(/.test(joinedCode)) {
    dynamicHazardSignals.push('dynamic_code_eval');
  }
  if (/\bReflect\s*\./.test(joinedCode) || /\bgetattr\s*\(/.test(joinedCode) || /\bimportlib\b/.test(joinedCode)) {
    dynamicHazardSignals.push('runtime_reflection_dispatch');
  }
  if (/\bimport\s*\(/.test(joinedCode) && (blob.language === 'typescript' || blob.language === 'javascript')) {
    dynamicHazardSignals.push('dynamic_module_import');
  }

  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const lines = blob.content.split('\n');

  // Extract imports line-by-line / multiline for TS/JS, Python, Rust, Go
  if (blob.language === 'typescript' || blob.language === 'javascript') {
    const importRegex = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(blob.content)) !== null) {
      const clause = m[1].trim();
      const spec = m[2].trim();
      const lineNum = blob.content.slice(0, m.index).split('\n').length;
      const importedSymbols: string[] = [];
      let isWildcard = false;
      if (clause.includes('* as')) {
        isWildcard = true;
      }
      const braceMatch = clause.match(/\{([\s\S]*?)\}/);
      if (braceMatch) {
        for (const item of braceMatch[1].split(',')) {
          const clean = item.replace(/\btype\s+/, '').trim();
          if (!clean) continue;
          const orig = clean.split(/\s+as\s+/)[0].trim();
          if (orig) importedSymbols.push(orig);
        }
      } else if (!isWildcard && clause) {
        importedSymbols.push(clause.split(',')[0].trim());
      }
      const resolvedPackage = resolveImportToPackage(spec, blob.filePath, knownPackageNames);
      imports.push({ specifier: spec, resolvedPackage, importedSymbols, isWildcard, line: lineNum });
    }
  } else if (blob.language === 'python') {
    lines.forEach((ln, idx) => {
      const fromMatch = ln.match(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/);
      if (fromMatch) {
        const spec = fromMatch[1];
        const names = fromMatch[2]
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        imports.push({
          specifier: spec,
          resolvedPackage: resolveImportToPackage(spec, blob.filePath, knownPackageNames),
          importedSymbols: names.includes('*') ? [] : names,
          isWildcard: names.includes('*'),
          line: idx + 1,
        });
      }
    });
  } else if (blob.language === 'rust') {
    lines.forEach((ln, idx) => {
      const useMatch = ln.match(/^\s*use\s+([A-Za-z0-9_:{}*,\s]+);/);
      if (useMatch) {
        const raw = useMatch[1].trim();
        const segs = raw.split('::');
        const last = segs[segs.length - 1];
        const syms = last.startsWith('{')
          ? last.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
          : last === '*'
            ? []
            : [last.trim()];
        imports.push({
          specifier: raw,
          resolvedPackage: resolveImportToPackage(raw, blob.filePath, knownPackageNames),
          importedSymbols: syms,
          isWildcard: last === '*',
          line: idx + 1,
        });
      }
    });
  } else if (blob.language === 'go') {
    const goImpSingle = /import\s+"([^"]+)"/g;
    let gm: RegExpExecArray | null;
    while ((gm = goImpSingle.exec(blob.content)) !== null) {
      const spec = gm[1];
      const lineNum = blob.content.slice(0, gm.index).split('\n').length;
      imports.push({
        specifier: spec,
        resolvedPackage: resolveImportToPackage(spec, blob.filePath, knownPackageNames),
        importedSymbols: [],
        isWildcard: true,
        line: lineNum,
      });
    }
    const goImpBlock = /import\s*\(([\s\S]*?)\)/g;
    while ((gm = goImpBlock.exec(blob.content)) !== null) {
      const blockLine = blob.content.slice(0, gm.index).split('\n').length;
      const strRe = /"([^"]+)"/g;
      let sm: RegExpExecArray | null;
      while ((sm = strRe.exec(gm[1])) !== null) {
        imports.push({
          specifier: sm[1],
          resolvedPackage: resolveImportToPackage(sm[1], blob.filePath, knownPackageNames),
          importedSymbols: [],
          isWildcard: true,
          line: blockLine,
        });
      }
    }
  }

  // Extract top-level / class declarations by language
  if (blob.language === 'typescript' || blob.language === 'javascript') {
    extractTsSymbols(blob.content, tokens, symbols);
  } else if (blob.language === 'python') {
    extractPythonSymbols(blob.content, tokens, symbols);
  } else if (blob.language === 'rust') {
    extractRustSymbols(blob.content, tokens, symbols);
  } else if (blob.language === 'go') {
    extractGoSymbols(blob.content, tokens, symbols);
  }

  // Extract call sites across token stream with enclosing symbol & argument count
  const callSites: ExtractedCallSite[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    if (tok.kind !== 'ident' || next.kind !== 'punct' || next.text !== '(') continue;
    if (LANGUAGE_KEYWORDS.has(tok.text)) continue;

    // Skip if this is the declaration site itself (preceded by `function`, `fn`, `def`, `func`)
    const prev = i > 0 ? tokens[i - 1] : undefined;
    if (
      prev &&
      prev.kind === 'ident' &&
      (prev.text === 'function' || prev.text === 'fn' || prev.text === 'def' || prev.text === 'func')
    ) {
      continue;
    }

    let receiver: string | undefined;
    if (
      i >= 2 &&
      tokens[i - 1].kind === 'punct' &&
      (tokens[i - 1].text === '.' || tokens[i - 1].text === '::') &&
      tokens[i - 2].kind === 'ident'
    ) {
      receiver = tokens[i - 2].text;
    }

    // Count top-level arguments inside (...)
    let depth = 0;
    let argCount = 0;
    let hasTokensInside = false;
    for (let k = i + 1; k < tokens.length; k++) {
      const ct = tokens[k];
      if (ct.kind === 'punct') {
        if (ct.text === '(' || ct.text === '[' || ct.text === '{') {
          if (depth >= 1) hasTokensInside = true;
          depth++;
        } else if (ct.text === ')' || ct.text === ']' || ct.text === '}') {
          depth--;
          if (depth === 0) {
            if (hasTokensInside) argCount++;
            break;
          }
        } else if (ct.text === ',' && depth === 1) {
          argCount++;
          hasTokensInside = false;
        } else if (depth >= 1) {
          hasTokensInside = true;
        }
      } else if (depth >= 1) {
        hasTokensInside = true;
      }
    }

    const enclosing =
      symbols.find((s) => tok.line >= s.startLine && tok.line <= s.endLine)?.name ?? '<module>';

    callSites.push({
      callee: tok.text,
      receiver,
      enclosingSymbol: enclosing,
      line: tok.line,
      argCount,
    });
  }

  return {
    blobId: blob.blobId,
    sha256: blob.sha256,
    commitVersion: blob.commitVersion,
    tenantId: blob.tenantId,
    repoId: blob.repoId,
    packageName: blob.packageName,
    filePath: blob.filePath,
    language: blob.language,
    isTestFile: blob.isTestFile,
    codeTokenHash,
    dynamicHazardSignals,
    isGlobalConfig,
    symbols,
    imports,
    callSites,
  };
}

function resolveImportToPackage(
  specifier: string,
  fromFilePath: string,
  knownPackages: ReadonlySet<string>
): string | undefined {
  for (const pkg of knownPackages) {
    const shortName = pkg.split('/').pop() ?? pkg;
    if (
      specifier === pkg ||
      specifier.startsWith(`${pkg}/`) ||
      specifier === `@repo/${shortName}` ||
      specifier === `@hanzo/${shortName}` ||
      specifier.startsWith(`@${shortName}/`) ||
      specifier.endsWith(`/${shortName}`) ||
      specifier.replace(/_/g, '-') === shortName.replace(/_/g, '-') ||
      specifier.startsWith(`${shortName}::`) ||
      specifier.startsWith(`${shortName}.`)
    ) {
      return pkg;
    }
  }
  if (specifier.startsWith('.')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFilePath), specifier));
    return inferPackageName(resolved);
  }
  return undefined;
}

function extractTsSymbols(
  content: string,
  tokens: readonly AstLexToken[],
  out: ExtractedSymbol[]
): void {
  const fnRe =
    /(^[ \t]*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*(?::\s*([^\{;]+))?\s*\{)/gm;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) {
    const exported = Boolean(m[2]);
    const name = m[3];
    const rawParams = m[4] ?? '';
    const returnType = (m[5] ?? 'inferred').replace(/\s+/g, ' ').trim();
    const startLine = content.slice(0, m.index).split('\n').length;
    const tokIdx = tokens.findIndex((t) => t.start >= m!.index && t.text === name);
    const endTokIdx = tokIdx >= 0 ? findMatchingBraceEndToken(tokens, tokIdx) : -1;
    const endLine = endTokIdx >= 0 ? tokens[endTokIdx].line : startLine + 5;
    const bodyTokens =
      tokIdx >= 0 && endTokIdx >= tokIdx
        ? tokens.slice(tokIdx, endTokIdx + 1).map((t) => t.text).join(' ')
        : m[0];
    const params = parseParameterSpecs(rawParams, 'typescript');
    const { minArgs, maxArgs } = computeArityBounds(params);
    const sig = `${exported ? 'export ' : ''}fn ${name}(${params.map((p) => `${p.variadic ? '...' : ''}${p.name}${p.optionalOrDefault ? '?' : ''}:${p.typeAnnotation}`).join(', ')}) -> ${returnType}`;
    out.push({
      name,
      kind: 'function',
      exported,
      startLine,
      endLine,
      params,
      minArgs,
      maxArgs,
      returnType,
      signatureNormalized: sig,
      bodyTokenHash: sha256Hex(bodyTokens),
    });
  }

  // Arrow functions: export const foo = (a: string): number => { ... }
  const arrowRe =
    /(^[ \t]*(export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\(([\s\S]*?)\)\s*(?::\s*([^=]+?))?\s*=>)/gm;
  while ((m = arrowRe.exec(content)) !== null) {
    const exported = Boolean(m[2]);
    const name = m[3];
    const rawParams = m[4] ?? '';
    const returnType = (m[5] ?? 'inferred').replace(/\s+/g, ' ').trim();
    const startLine = content.slice(0, m.index).split('\n').length;
    const tokIdx = tokens.findIndex((t) => t.start >= m!.index && t.text === name);
    const endTokIdx = tokIdx >= 0 ? findMatchingBraceEndToken(tokens, tokIdx) : -1;
    const endLine = endTokIdx >= 0 ? tokens[endTokIdx].line : startLine + 3;
    const bodyTokens =
      tokIdx >= 0 && endTokIdx >= tokIdx
        ? tokens.slice(tokIdx, endTokIdx + 1).map((t) => t.text).join(' ')
        : m[0];
    const params = parseParameterSpecs(rawParams, 'typescript');
    const { minArgs, maxArgs } = computeArityBounds(params);
    const sig = `${exported ? 'export ' : ''}fn ${name}(${params.map((p) => `${p.variadic ? '...' : ''}${p.name}${p.optionalOrDefault ? '?' : ''}:${p.typeAnnotation}`).join(', ')}) -> ${returnType}`;
    out.push({
      name,
      kind: 'function',
      exported,
      startLine,
      endLine,
      params,
      minArgs,
      maxArgs,
      returnType,
      signatureNormalized: sig,
      bodyTokenHash: sha256Hex(bodyTokens),
    });
  }

  // Interfaces & Classes
  const typeDeclRe = /(^[ \t]*(export\s+)?(class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)[^{]*\{)/gm;
  while ((m = typeDeclRe.exec(content)) !== null) {
    const exported = Boolean(m[2]);
    const kind = m[3] === 'interface' ? 'interface' : 'class';
    const name = m[4];
    const startLine = content.slice(0, m.index).split('\n').length;
    const tokIdx = tokens.findIndex((t) => t.start >= m!.index && t.text === name);
    const endTokIdx = tokIdx >= 0 ? findMatchingBraceEndToken(tokens, tokIdx) : -1;
    const endLine = endTokIdx >= 0 ? tokens[endTokIdx].line : startLine + 5;
    const bodyTokens =
      tokIdx >= 0 && endTokIdx >= tokIdx
        ? tokens.slice(tokIdx, endTokIdx + 1).map((t) => t.text).join(' ')
        : m[0];
    out.push({
      name,
      kind,
      exported,
      startLine,
      endLine,
      params: [],
      minArgs: 0,
      maxArgs: null,
      returnType: name,
      signatureNormalized: `${exported ? 'export ' : ''}${kind} ${name}`,
      bodyTokenHash: sha256Hex(bodyTokens),
    });
  }
}

function extractPythonSymbols(
  content: string,
  tokens: readonly AstLexToken[],
  out: ExtractedSymbol[]
): void {
  const lines = content.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const ln = lines[idx];
    const defMatch = ln.match(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/);
    if (!defMatch) continue;
    const indent = defMatch[1].length;
    const name = defMatch[2];
    const rawParams = defMatch[3] ?? '';
    const returnType = (defMatch[4] ?? 'Any').trim();
    const exported = indent === 0 && !name.startsWith('_');
    const startLine = idx + 1;
    let endLine = startLine;
    for (let k = idx + 1; k < lines.length; k++) {
      const trimmed = lines[k].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const curIndent = (lines[k].match(/^[ \t]*/) ?? [''])[0].length;
      if (curIndent <= indent) break;
      endLine = k + 1;
    }
    const bodyTokens = tokens
      .filter((t) => t.line >= startLine && t.line <= endLine)
      .map((t) => t.text)
      .join(' ');
    const params = parseParameterSpecs(rawParams, 'python');
    const { minArgs, maxArgs } = computeArityBounds(params);
    const sig = `${exported ? 'pub ' : ''}def ${name}(${params.map((p) => `${p.variadic ? '*' : ''}${p.name}${p.optionalOrDefault ? '?' : ''}:${p.typeAnnotation}`).join(', ')}) -> ${returnType}`;
    out.push({
      name,
      kind: indent > 0 ? 'method' : 'function',
      exported,
      startLine,
      endLine,
      params,
      minArgs,
      maxArgs,
      returnType,
      signatureNormalized: sig,
      bodyTokenHash: sha256Hex(bodyTokens),
    });
  }
}

function extractRustSymbols(
  content: string,
  tokens: readonly AstLexToken[],
  out: ExtractedSymbol[]
): void {
  const fnRe =
    /(^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*(?:->\s*([^\{;]+))?\s*\{)/gm;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) {
    const exported = Boolean(m[2] && m[2].trim() === 'pub');
    const name = m[3];
    const rawParams = m[4] ?? '';
    const returnType = (m[5] ?? '()').replace(/\s+/g, ' ').trim();
    const startLine = content.slice(0, m.index).split('\n').length;
    const tokIdx = tokens.findIndex((t) => t.start >= m!.index && t.text === name);
    const endTokIdx = tokIdx >= 0 ? findMatchingBraceEndToken(tokens, tokIdx) : -1;
    const endLine = endTokIdx >= 0 ? tokens[endTokIdx].line : startLine + 5;
    const bodyTokens =
      tokIdx >= 0 && endTokIdx >= tokIdx
        ? tokens.slice(tokIdx, endTokIdx + 1).map((t) => t.text).join(' ')
        : m[0];
    const params = parseParameterSpecs(rawParams, 'rust');
    const { minArgs, maxArgs } = computeArityBounds(params);
    const sig = `${exported ? 'pub ' : ''}fn ${name}(${params.map((p) => `${p.name}:${p.typeAnnotation}`).join(', ')}) -> ${returnType}`;
    out.push({
      name,
      kind: 'function',
      exported,
      startLine,
      endLine,
      params,
      minArgs,
      maxArgs,
      returnType,
      signatureNormalized: sig,
      bodyTokenHash: sha256Hex(bodyTokens),
    });
  }
}

function extractGoSymbols(
  content: string,
  tokens: readonly AstLexToken[],
  out: ExtractedSymbol[]
): void {
  const fnRe =
    /(^[ \t]*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*([^\{]*?)\{)/gm;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[2];
    const exported = /^[A-Z]/.test(name);
    const rawParams = m[3] ?? '';
    const returnType = (m[4] ?? 'void').replace(/\s+/g, ' ').trim() || 'void';
    const startLine = content.slice(0, m.index).split('\n').length;
    const tokIdx = tokens.findIndex((t) => t.start >= m!.index && t.text === name);
    const endTokIdx = tokIdx >= 0 ? findMatchingBraceEndToken(tokens, tokIdx) : -1;
    const endLine = endTokIdx >= 0 ? tokens[endTokIdx].line : startLine + 5;
    const bodyTokens =
      tokIdx >= 0 && endTokIdx >= tokIdx
        ? tokens.slice(tokIdx, endTokIdx + 1).map((t) => t.text).join(' ')
        : m[0];
    const params = parseParameterSpecs(rawParams, 'go');
    const { minArgs, maxArgs } = computeArityBounds(params);
    const sig = `${exported ? 'export ' : ''}func ${name}(${params.map((p) => `${p.variadic ? '...' : ''}${p.typeAnnotation}`).join(', ')}) -> ${returnType}`;
    out.push({
      name,
      kind: 'function',
      exported,
      startLine,
      endLine,
      params,
      minArgs,
      maxArgs,
      returnType,
      signatureNormalized: sig,
      bodyTokenHash: sha256Hex(bodyTokens),
    });
  }
}

// ── Derived Index & Semantic Corpus Store ───────────────────────────────

export class DerivedSemanticIndex {
  private entries = new Map<string, DerivedFileEntry>();

  public rebuildFromCanonical(blobs: Iterable<CanonicalBlobRecord>): void {
    this.entries.clear();
    const list = [...blobs];
    const packages = new Set(list.map((b) => b.packageName));
    for (const blob of list) {
      this.entries.set(blob.filePath, buildDerivedFileEntry(blob, packages));
    }
  }

  public incrementalUpdate(
    changedBlobs: readonly CanonicalBlobRecord[],
    allPackageNames: ReadonlySet<string>
  ): void {
    for (const blob of changedBlobs) {
      this.entries.set(blob.filePath, buildDerivedFileEntry(blob, allPackageNames));
    }
  }

  public remove(filePath: string): void {
    this.entries.delete(filePath);
  }

  public getEntry(filePath: string, access: TenantAccessContext, blobMap: ReadonlyMap<string, CanonicalBlobRecord>): DerivedFileEntry | undefined {
    const blob = blobMap.get(filePath);
    if (!blob || !checkBlobAccess(blob, access)) return undefined;
    return this.entries.get(filePath);
  }

  public getAuthorizedEntries(
    access: TenantAccessContext,
    blobMap: ReadonlyMap<string, CanonicalBlobRecord>
  ): readonly DerivedFileEntry[] {
    const result: DerivedFileEntry[] = [];
    for (const [filePath, entry] of this.entries.entries()) {
      const blob = blobMap.get(filePath);
      if (blob && checkBlobAccess(blob, access)) {
        result.push(entry);
      }
    }
    return result;
  }

  public snapshotDigest(): string {
    const rows = [...this.entries.values()]
      .sort((a, b) => a.filePath.localeCompare(b.filePath))
      .map(
        (e) =>
          `${e.filePath}|${e.sha256}|${e.codeTokenHash}|${e.symbols.map((s) => s.signatureNormalized + ':' + s.bodyTokenHash).join(',')}`
      );
    return sha256Hex(rows.join('\n'));
  }
}

// ── Semantic Diff & Cross-Package Compatibility Analysis ────────────────

function classifySymbolPairChange(
  beforeSym: ExtractedSymbol,
  afterSym: ExtractedSymbol
): { kind: SemanticChangeKind; breaking: boolean; summary: string } | null {
  if (
    beforeSym.signatureNormalized === afterSym.signatureNormalized &&
    beforeSym.bodyTokenHash === afterSym.bodyTokenHash
  ) {
    return null;
  }

  if (beforeSym.exported && !afterSym.exported) {
    return {
      kind: 'symbol_removed_or_unexported',
      breaking: true,
      summary: `Exported symbol '${beforeSym.name}' was unexported`,
    };
  }

  if (beforeSym.signatureNormalized === afterSym.signatureNormalized) {
    return {
      kind: 'body_implementation_changed',
      breaking: false,
      summary: `Internal body of '${beforeSym.name}' changed while preserving signature`,
    };
  }

  // Check return type change
  if (beforeSym.returnType !== afterSym.returnType) {
    return {
      kind: 'breaking_return_type_change',
      breaking: beforeSym.exported,
      summary: `Return type of '${beforeSym.name}' changed from '${beforeSym.returnType}' to '${afterSym.returnType}'`,
    };
  }

  // Check arity compatibility:
  // Breaking if required minArgs increased OR maxArgs decreased below previous maxArgs
  const minIncreased = afterSym.minArgs > beforeSym.minArgs;
  const maxDecreased =
    afterSym.maxArgs !== null &&
    (beforeSym.maxArgs === null || afterSym.maxArgs < beforeSym.maxArgs);
  if (minIncreased || maxDecreased) {
    return {
      kind: 'breaking_arity_change',
      breaking: beforeSym.exported,
      summary: `Arity of '${beforeSym.name}' changed incompatibly from [${beforeSym.minArgs}..${beforeSym.maxArgs ?? 'inf'}] to [${afterSym.minArgs}..${afterSym.maxArgs ?? 'inf'}]`,
    };
  }

  // Check overlapping positional parameter types
  const sharedCount = Math.min(beforeSym.params.length, afterSym.params.length);
  for (let i = 0; i < sharedCount; i++) {
    const bp = beforeSym.params[i];
    const ap = afterSym.params[i];
    if (bp.typeAnnotation !== ap.typeAnnotation) {
      return {
        kind: 'breaking_param_type_change',
        breaking: beforeSym.exported,
        summary: `Parameter #${i + 1} ('${ap.name}') of '${beforeSym.name}' changed type from '${bp.typeAnnotation}' to '${ap.typeAnnotation}'`,
      };
    }
  }

  return {
    kind: 'compatible_signature_extension',
    breaking: false,
    summary: `Signature of '${beforeSym.name}' extended compatibly with optional/default parameter(s)`,
  };
}

export function computeSemanticDiff(
  beforeEntries: ReadonlyMap<string, DerivedFileEntry>,
  afterEntries: ReadonlyMap<string, DerivedFileEntry>,
  changedPaths: ReadonlySet<string>
): SemanticDiffReport {
  const deltas: SemanticSymbolDelta[] = [];
  const formattingOnlyFiles: string[] = [];
  const affectedSymbolNames = new Set<string>();
  const breakingSymbolsByPkg = new Map<
    string,
    {
      sourceFile: string;
      sourcePackage: string;
      symbolName: string;
      changeKind: SemanticChangeKind;
      afterSym?: ExtractedSymbol;
    }[]
  >();

  for (const filePath of [...changedPaths].sort()) {
    const before = beforeEntries.get(filePath);
    const after = afterEntries.get(filePath);
    if (!before && !after) continue;

    if (before && after && before.codeTokenHash === after.codeTokenHash) {
      formattingOnlyFiles.push(filePath);
      deltas.push({
        filePath,
        packageName: after.packageName,
        symbolName: '<formatting>',
        symbolKind: 'module',
        changeKind: 'formatting_or_comment_only',
        breakingContract: false,
        summary: 'Whitespace or comment-only edit; executable token stream unchanged',
      });
      continue;
    }

    if (after?.isGlobalConfig || after?.language === 'json') {
      deltas.push({
        filePath,
        packageName: after.packageName,
        symbolName: path.posix.basename(filePath),
        symbolKind: 'module',
        changeKind: 'config_or_data_modified',
        breakingContract: false,
        summary: `Configuration or data file '${filePath}' modified`,
      });
      continue;
    }

    const beforeMap = new Map((before?.symbols ?? []).map((s) => [s.name, s]));
    const afterMap = new Map((after?.symbols ?? []).map((s) => [s.name, s]));
    const pkg = after?.packageName ?? before?.packageName ?? 'root';

    for (const [symName, bSym] of beforeMap.entries()) {
      const aSym = afterMap.get(symName);
      if (!aSym) {
        affectedSymbolNames.add(symName);
        const breaking = bSym.exported;
        deltas.push({
          filePath,
          packageName: pkg,
          symbolName: symName,
          symbolKind: bSym.kind,
          changeKind: 'symbol_removed_or_unexported',
          breakingContract: breaking,
          beforeSignature: bSym.signatureNormalized,
          summary: `Symbol '${symName}' was removed`,
        });
        if (breaking) {
          const arr = breakingSymbolsByPkg.get(pkg) ?? [];
          arr.push({
            sourceFile: filePath,
            sourcePackage: pkg,
            symbolName: symName,
            changeKind: 'symbol_removed_or_unexported',
          });
          breakingSymbolsByPkg.set(pkg, arr);
        }
        continue;
      }

      const classified = classifySymbolPairChange(bSym, aSym);
      if (classified) {
        affectedSymbolNames.add(symName);
        deltas.push({
          filePath,
          packageName: pkg,
          symbolName: symName,
          symbolKind: aSym.kind,
          changeKind: classified.kind,
          breakingContract: classified.breaking,
          beforeSignature: bSym.signatureNormalized,
          afterSignature: aSym.signatureNormalized,
          summary: classified.summary,
        });
        if (classified.breaking) {
          const arr = breakingSymbolsByPkg.get(pkg) ?? [];
          arr.push({
            sourceFile: filePath,
            sourcePackage: pkg,
            symbolName: symName,
            changeKind: classified.kind,
            afterSym: aSym,
          });
          breakingSymbolsByPkg.set(pkg, arr);
        }
      }
    }

    for (const [symName, aSym] of afterMap.entries()) {
      if (!beforeMap.has(symName)) {
        affectedSymbolNames.add(symName);
        deltas.push({
          filePath,
          packageName: pkg,
          symbolName: symName,
          symbolKind: aSym.kind,
          changeKind: 'symbol_added',
          breakingContract: false,
          afterSignature: aSym.signatureNormalized,
          summary: `New symbol '${symName}' added`,
        });
      }
    }
  }

  // Locate affected callers & detect incompatible cross-package breakages on the AFTER state
  const affectedCallers: {
    filePath: string;
    packageName: string;
    callerSymbol: string;
    calleeSymbol: string;
    line: number;
    crossPackage: boolean;
  }[] = [];
  const crossPackageBreakages: IncompatibleCrossPackageChange[] = [];

  // Map symbol -> defining package(s)
  const symbolHomePkg = new Map<string, string>();
  for (const entry of beforeEntries.values()) {
    for (const s of entry.symbols) {
      if (s.exported) symbolHomePkg.set(s.name, entry.packageName);
    }
  }
  for (const entry of afterEntries.values()) {
    for (const s of entry.symbols) {
      if (s.exported && !symbolHomePkg.has(s.name)) symbolHomePkg.set(s.name, entry.packageName);
    }
  }

  for (const entry of afterEntries.values()) {
    if (entry.isTestFile) continue;

    const importedFromPkgs = new Set(
      entry.imports.map((imp) => imp.resolvedPackage).filter((p): p is string => Boolean(p))
    );
    const explicitlyImportedSyms = new Map<string, string | undefined>();
    for (const imp of entry.imports) {
      for (const sym of imp.importedSymbols) {
        explicitlyImportedSyms.set(sym, imp.resolvedPackage);
      }
    }

    for (const cs of entry.callSites) {
      if (!affectedSymbolNames.has(cs.callee)) continue;
      const defPkg = explicitlyImportedSyms.get(cs.callee) ?? symbolHomePkg.get(cs.callee);
      const crossPkg = Boolean(defPkg && defPkg !== entry.packageName);

      affectedCallers.push({
        filePath: entry.filePath,
        packageName: entry.packageName,
        callerSymbol: cs.enclosingSymbol,
        calleeSymbol: cs.callee,
        line: cs.line,
        crossPackage: crossPkg,
      });

      if (!crossPkg || !defPkg) continue;
      const pkgBreaks = breakingSymbolsByPkg.get(defPkg) ?? [];
      for (const brk of pkgBreaks) {
        if (brk.symbolName !== cs.callee) continue;

        if (brk.changeKind === 'symbol_removed_or_unexported') {
          crossPackageBreakages.push({
            sourcePackage: brk.sourcePackage,
            sourceFile: brk.sourceFile,
            symbolName: brk.symbolName,
            changeKind: brk.changeKind,
            consumerPackage: entry.packageName,
            consumerFile: entry.filePath,
            consumerSymbol: cs.enclosingSymbol,
            consumerLine: cs.line,
            reason: `Consumer '${entry.filePath}:${cs.line}' still calls removed/unexported symbol '${brk.symbolName}' from '${brk.sourcePackage}'`,
          });
        } else if (brk.changeKind === 'breaking_arity_change' && brk.afterSym) {
          const tooFew = cs.argCount < brk.afterSym.minArgs;
          const tooMany = brk.afterSym.maxArgs !== null && cs.argCount > brk.afterSym.maxArgs;
          if (tooFew || tooMany) {
            crossPackageBreakages.push({
              sourcePackage: brk.sourcePackage,
              sourceFile: brk.sourceFile,
              symbolName: brk.symbolName,
              changeKind: brk.changeKind,
              consumerPackage: entry.packageName,
              consumerFile: entry.filePath,
              consumerSymbol: cs.enclosingSymbol,
              consumerLine: cs.line,
              reason: `Callsite '${entry.filePath}:${cs.line}' passes ${cs.argCount} arg(s) to '${brk.symbolName}', which now requires [${brk.afterSym.minArgs}..${brk.afterSym.maxArgs ?? 'inf'}]`,
            });
          }
        } else if (
          (brk.changeKind === 'breaking_param_type_change' ||
            brk.changeKind === 'breaking_return_type_change') &&
          !changedPaths.has(entry.filePath)
        ) {
          crossPackageBreakages.push({
            sourcePackage: brk.sourcePackage,
            sourceFile: brk.sourceFile,
            symbolName: brk.symbolName,
            changeKind: brk.changeKind,
            consumerPackage: entry.packageName,
            consumerFile: entry.filePath,
            consumerSymbol: cs.enclosingSymbol,
            consumerLine: cs.line,
            reason: `Cross-package contract '${brk.symbolName}' (${brk.changeKind}) changed in '${brk.sourcePackage}' without updating consumer '${entry.filePath}:${cs.line}'`,
          });
        }
      }
    }

    // Also catch dangling named imports of removed symbols even when referenced as values rather than calls
    for (const imp of entry.imports) {
      if (!imp.resolvedPackage || imp.resolvedPackage === entry.packageName) continue;
      const pkgBreaks = breakingSymbolsByPkg.get(imp.resolvedPackage) ?? [];
      for (const brk of pkgBreaks) {
        if (
          brk.changeKind === 'symbol_removed_or_unexported' &&
          imp.importedSymbols.includes(brk.symbolName) &&
          !crossPackageBreakages.some(
            (b) => b.consumerFile === entry.filePath && b.symbolName === brk.symbolName
          )
        ) {
          crossPackageBreakages.push({
            sourcePackage: brk.sourcePackage,
            sourceFile: brk.sourceFile,
            symbolName: brk.symbolName,
            changeKind: brk.changeKind,
            consumerPackage: entry.packageName,
            consumerFile: entry.filePath,
            consumerSymbol: '<import>',
            consumerLine: imp.line,
            reason: `Consumer '${entry.filePath}:${imp.line}' imports removed/unexported symbol '${brk.symbolName}' from '${brk.sourcePackage}'`,
          });
        }
      }
    }
    void importedFromPkgs;
  }

  return {
    changedFilesCount: changedPaths.size,
    formattingOnlyFiles,
    affectedSymbols: [...affectedSymbolNames].sort(),
    affectedCallers,
    deltas,
    crossPackageBreakages,
    hasBreakingCrossPackageChanges: crossPackageBreakages.length > 0,
  };
}

// ── Incremental Test Selection with Confidence Escalation ───────────────

export function selectIncrementalTests(
  afterEntries: ReadonlyMap<string, DerivedFileEntry>,
  changedPaths: ReadonlySet<string>,
  diff: SemanticDiffReport,
  thresholds: PlannerThresholds = {}
): IncrementalTestSelection {
  const highThreshold = thresholds.highConfidenceThreshold ?? 0.8;
  const lowThreshold = thresholds.lowConfidenceThreshold ?? 0.55;

  const allTests = [...afterEntries.values()]
    .filter((e) => e.isTestFile)
    .map((e) => e.filePath)
    .sort();

  const safetyContract = {
    requiresCompilerCheck: true as const,
    requiresSelectedTestsPass: true as const,
    selectionIsNotSafetyProof: true as const,
    disclaimer:
      'Dependency-based test selection accelerates early feedback and is never proof that unrelated behavior is safe; compiler checks and gated CI verification remain mandatory.',
  };

  if (changedPaths.size === 0 || (diff.formattingOnlyFiles.length === changedPaths.size && diff.deltas.every((d) => d.changeKind === 'formatting_or_comment_only'))) {
    return {
      tier: 'none_formatting_only',
      dependencyConfidence: 0.99,
      confidenceReasons: ['All modified files contain formatting or comment-only changes (identical lexical code token stream)'],
      selectedTests: [],
      totalAvailableTests: allTests.length,
      reductionRatio: allTests.length > 0 ? 1 : 0,
      escalated: false,
      validationContract: safetyContract,
    };
  }

  // Expand transitive affected symbols (2 hops across call graph)
  const closureSymbols = new Set<string>(diff.affectedSymbols);
  for (const caller of diff.affectedCallers) {
    if (caller.callerSymbol !== '<module>') {
      closureSymbols.add(caller.callerSymbol);
    }
  }
  for (const entry of afterEntries.values()) {
    if (entry.isTestFile) continue;
    for (const cs of entry.callSites) {
      if (closureSymbols.has(cs.callee) && cs.enclosingSymbol !== '<module>') {
        closureSymbols.add(cs.enclosingSymbol);
      }
    }
  }

  const touchedPackages = new Set<string>();
  const affectedSourceFiles = new Set<string>();
  let hasGlobalConfigChange = false;
  const dynamicHazardsFound = new Set<string>();

  for (const p of changedPaths) {
    const entry = afterEntries.get(p);
    if (!entry) continue;
    touchedPackages.add(entry.packageName);
    if (!entry.isTestFile) affectedSourceFiles.add(p);
    if (entry.isGlobalConfig) hasGlobalConfigChange = true;
    for (const hz of entry.dynamicHazardSignals) dynamicHazardsFound.add(`${p}:${hz}`);
  }
  for (const caller of diff.affectedCallers) {
    affectedSourceFiles.add(caller.filePath);
    const callerEntry = afterEntries.get(caller.filePath);
    if (callerEntry) {
      for (const hz of callerEntry.dynamicHazardSignals) {
        dynamicHazardsFound.add(`${caller.filePath}:${hz}`);
      }
    }
  }

  // Tier-1: Direct symbol/import/convention/co-failure linked tests
  const directTests = new Set<string>();
  let hasStaticGraphTestLink = false;

  for (const p of changedPaths) {
    const entry = afterEntries.get(p);
    if (entry?.isTestFile) {
      directTests.add(p);
      hasStaticGraphTestLink = true;
    }
    const coFailures = thresholds.historicalCoFailureMap?.[p] ?? [];
    for (const cf of coFailures) {
      if (afterEntries.get(cf)?.isTestFile) directTests.add(cf);
    }
  }

  const affectedStems = new Set(
    [...affectedSourceFiles].map((f) =>
      path.posix.basename(f).replace(/\.(ts|tsx|js|jsx|py|rs|go)$/, '').toLowerCase()
    )
  );

  for (const testPath of allTests) {
    const tEntry = afterEntries.get(testPath)!;
    // Check direct call to any symbol in closure
    const callsClosure = tEntry.callSites.some((cs) => closureSymbols.has(cs.callee));
    // Check explicit symbol import
    const importsClosure = tEntry.imports.some((imp) =>
      imp.importedSymbols.some((s) => closureSymbols.has(s))
    );
    // Check relative/specifier match to affected source stem
    const importsFileStem = tEntry.imports.some((imp) => {
      const specBase = path.posix.basename(imp.specifier).replace(/\.(js|ts|py|rs|go)$/, '').toLowerCase();
      return affectedStems.has(specBase);
    });

    if (callsClosure || importsClosure || importsFileStem) {
      directTests.add(testPath);
      hasStaticGraphTestLink = true;
      continue;
    }

    // Naming convention fallback (`billing.ts` <-> `billing.test.ts` / `test_billing.py`)
    const testBase = path.posix
      .basename(testPath)
      .toLowerCase()
      .replace(/(\.test|\.spec|_test|^test_)/g, '')
      .replace(/\.(ts|tsx|js|jsx|py|rs|go)$/, '');
    if (affectedStems.has(testBase)) {
      directTests.add(testPath);
    }
  }

  // Compute calibrated dependency confidence
  let confidence = hasStaticGraphTestLink ? 0.94 : directTests.size > 0 ? 0.74 : 0.44;
  const reasons: string[] = [];

  if (hasStaticGraphTestLink) {
    reasons.push('Direct static symbol/import edges link affected symbols to test suite(s)');
  } else if (directTests.size > 0) {
    reasons.push('Test linkage inferred via file naming/co-failure conventions without direct symbol call edges (-0.20)');
  } else {
    reasons.push('No direct static or convention-matched unit test found for modified code (-0.50)');
  }

  if (dynamicHazardsFound.size > 0) {
    confidence -= 0.42;
    reasons.push(
      `Dynamic dispatch / reflection hazard detected (${[...dynamicHazardsFound].join(', ')}) (-0.42)`
    );
  }

  if (hasGlobalConfigChange) {
    confidence -= 0.45;
    reasons.push('Global workspace/compiler configuration modified (-0.45)');
  }

  const hasPublicSignatureChange = diff.deltas.some(
    (d) =>
      d.changeKind === 'breaking_arity_change' ||
      d.changeKind === 'breaking_param_type_change' ||
      d.changeKind === 'breaking_return_type_change' ||
      d.changeKind === 'symbol_removed_or_unexported' ||
      d.changeKind === 'compatible_signature_extension'
  );
  if (hasPublicSignatureChange) {
    confidence -= 0.18;
    reasons.push('Exported symbol signature modified; expanding beyond narrow unit scope (-0.18)');
  }

  if (diff.hasBreakingCrossPackageChanges) {
    confidence -= 0.25;
    reasons.push('Unresolved cross-package contract breakage detected (-0.25)');
  }

  confidence = Math.max(0.05, Math.min(0.99, Number(confidence.toFixed(2))));

  // Tier selection & escalation
  if (confidence >= highThreshold && directTests.size > 0) {
    const selected = [...directTests].sort();
    return {
      tier: 'minimal_targeted',
      dependencyConfidence: confidence,
      confidenceReasons: reasons,
      selectedTests: selected,
      totalAvailableTests: allTests.length,
      reductionRatio:
        allTests.length > 0 ? Number((1 - selected.length / allTests.length).toFixed(4)) : 0,
      escalated: false,
      validationContract: safetyContract,
    };
  }

  if (confidence >= lowThreshold) {
    // Escalate to all tests in touched packages + packages of affected callers
    const expandedPkgs = new Set<string>(touchedPackages);
    for (const caller of diff.affectedCallers) expandedPkgs.add(caller.packageName);

    const pkgTests = new Set<string>(directTests);
    for (const testPath of allTests) {
      const tEntry = afterEntries.get(testPath)!;
      if (
        expandedPkgs.has(tEntry.packageName) ||
        tEntry.imports.some((imp) => imp.resolvedPackage && expandedPkgs.has(imp.resolvedPackage))
      ) {
        pkgTests.add(testPath);
      }
    }
    const selected = pkgTests.size > 0 ? [...pkgTests].sort() : allTests;
    return {
      tier: pkgTests.size > 0 ? 'package_and_dependents' : 'full_suite_escalation',
      dependencyConfidence: confidence,
      confidenceReasons: [
        ...reasons,
        `Confidence ${confidence} < ${highThreshold}: escalated to package & dependent integration tests`,
      ],
      selectedTests: selected,
      totalAvailableTests: allTests.length,
      reductionRatio:
        allTests.length > 0 ? Number((1 - selected.length / allTests.length).toFixed(4)) : 0,
      escalated: true,
      validationContract: safetyContract,
    };
  }

  // Low confidence (< lowThreshold) -> escalate to full authorized test suite
  return {
    tier: 'full_suite_escalation',
    dependencyConfidence: confidence,
    confidenceReasons: [
      ...reasons,
      `Low dependency confidence (${confidence} < ${lowThreshold}): escalated to full repository test suite`,
    ],
    selectedTests: allTests,
    totalAvailableTests: allTests.length,
    reductionRatio: 0,
    escalated: true,
    validationContract: safetyContract,
  };
}

// ── End-to-End Semantic Change Planner ──────────────────────────────────

export class SemanticChangePlanner {
  private readonly canonicalBlobs = new Map<string, CanonicalBlobRecord>();
  private readonly derivedIndex = new DerivedSemanticIndex();
  private readonly thresholds: PlannerThresholds;

  constructor(initialBlobs: readonly SourceBlobInput[] = [], thresholds: PlannerThresholds = {}) {
    this.thresholds = thresholds;
    for (const item of initialBlobs) {
      const rec = createCanonicalBlobRecord(item);
      this.canonicalBlobs.set(rec.filePath, rec);
    }
    this.derivedIndex.rebuildFromCanonical(this.canonicalBlobs.values());
  }

  public upsertBlob(input: SourceBlobInput): CanonicalBlobRecord {
    const rec = createCanonicalBlobRecord(input);
    this.canonicalBlobs.set(rec.filePath, rec);
    const allPkgs = new Set([...this.canonicalBlobs.values()].map((b) => b.packageName));
    this.derivedIndex.incrementalUpdate([rec], allPkgs);
    return rec;
  }

  public rebuildDerivedRepresentations(): string {
    this.derivedIndex.rebuildFromCanonical(this.canonicalBlobs.values());
    return this.derivedIndex.snapshotDigest();
  }

  public getDerivedDigest(): string {
    return this.derivedIndex.snapshotDigest();
  }

  public getAuthorizedBlob(filePath: string, access: TenantAccessContext): CanonicalBlobRecord | undefined {
    const normalized = normalizeRepoPath(filePath);
    const blob = this.canonicalBlobs.get(normalized);
    if (!blob || !checkBlobAccess(blob, access)) return undefined;
    return blob;
  }

  public searchStructural(
    rule: AstRewriteRule,
    access: TenantAccessContext
  ): readonly StructuralMatch[] {
    const out: StructuralMatch[] = [];
    const sortedPaths = [...this.canonicalBlobs.keys()].sort();
    for (const p of sortedPaths) {
      const blob = this.canonicalBlobs.get(p)!;
      if (!checkBlobAccess(blob, access)) continue;
      out.push(...findStructuralMatchesInBlob(blob, rule));
    }
    return out;
  }

  public planChange(params: {
    readonly access: TenantAccessContext;
    readonly rules?: readonly AstRewriteRule[];
    readonly explicitFileContents?: Readonly<Record<string, string>>;
    readonly verifier?: VerificationRunner;
    readonly commitIfReady?: boolean;
    readonly nextCommitVersion?: string;
  }): SemanticChangePlanResult {
    const {
      access,
      rules = [],
      explicitFileContents = {},
      verifier,
      commitIfReady = false,
      nextCommitVersion = 'NEXT',
    } = params;

    const authorizedBlobs = new Map<string, CanonicalBlobRecord>();
    for (const [p, b] of this.canonicalBlobs.entries()) {
      if (checkBlobAccess(b, access)) {
        authorizedBlobs.set(p, b);
      }
    }

    const beforeEntries = new Map<string, DerivedFileEntry>();
    for (const entry of this.derivedIndex.getAuthorizedEntries(access, this.canonicalBlobs)) {
      beforeEntries.set(entry.filePath, entry);
    }

    const validEdits: ConstrainedFileEdit[] = [];
    const rejectedEdits: ConstrainedFileEdit[] = [];
    const changedPaths = new Set<string>();

    // 1. Apply AST rewrite rules across authorized blobs
    if (rules.length > 0) {
      for (const p of [...authorizedBlobs.keys()].sort()) {
        if (Object.prototype.hasOwnProperty.call(explicitFileContents, p)) continue;
        const blob = authorizedBlobs.get(p)!;
        const candidate = applyRulesToBlob(blob, rules);
        if (!candidate) continue;
        if (candidate.syntaxValidation.valid) {
          validEdits.push(candidate);
          changedPaths.add(p);
        } else {
          rejectedEdits.push(candidate);
        }
      }
    }

    // 2. Apply any explicit file updates (e.g., manual / agent patch content) with pre-flight syntax gate
    for (const [rawPath, newContent] of Object.entries(explicitFileContents)) {
      const normPath = normalizeRepoPath(rawPath);
      const existing = this.canonicalBlobs.get(normPath);
      if (existing && !checkBlobAccess(existing, access)) {
        throw new SemanticPlannerError(
          'TENANT_MISMATCH',
          `Access denied to canonical blob '${normPath}' for tenant '${access.tenantId}'`
        );
      }

      const baseBlob =
        existing ??
        createCanonicalBlobRecord({
          tenantId: access.tenantId,
          repoId: access.repoId ?? 'default-repo',
          filePath: normPath,
          content: '',
          commitVersion: 'NEW',
        });

      if (existing && existing.content === newContent) continue;

      const syntaxValidation = validateStructuralSyntax(newContent, baseBlob.language);
      const editRecord: ConstrainedFileEdit = {
        filePath: normPath,
        packageName: baseBlob.packageName,
        baseBlobId: baseBlob.blobId,
        baseSha256: baseBlob.sha256,
        beforeContent: baseBlob.content,
        afterContent: newContent,
        afterSha256: sha256Hex(newContent),
        appliedRuleIds: ['explicit_edit'],
        matchCount: 1,
        syntaxValidation,
      };

      if (syntaxValidation.valid) {
        validEdits.push(editRecord);
        changedPaths.add(normPath);
      } else {
        rejectedEdits.push(editRecord);
      }
    }

    // 3. Build transient AFTER derived entries without mutating canonical store
    const allPkgs = new Set<string>([...authorizedBlobs.values()].map((b) => b.packageName));
    for (const edit of validEdits) allPkgs.add(edit.packageName);

    const afterEntries = new Map<string, DerivedFileEntry>(beforeEntries);
    for (const edit of validEdits) {
      const existing = authorizedBlobs.get(edit.filePath);
      const transientBlob = createCanonicalBlobRecord({
        tenantId: access.tenantId,
        repoId: existing?.repoId ?? access.repoId ?? 'default-repo',
        filePath: edit.filePath,
        packageName: edit.packageName,
        language: existing?.language,
        isTestFile: existing?.isTestFile,
        allowedRoles: existing?.allowedRoles,
        commitVersion: nextCommitVersion,
        content: edit.afterContent,
      });
      afterEntries.set(edit.filePath, buildDerivedFileEntry(transientBlob, allPkgs));
    }

    // 4. Semantic diff & cross-package compatibility check
    const semanticDiff = computeSemanticDiff(beforeEntries, afterEntries, changedPaths);

    // 5. Incremental test selection + confidence escalation
    const testSelection = selectIncrementalTests(
      afterEntries,
      changedPaths,
      semanticDiff,
      this.thresholds
    );

    const blockingReasons: string[] = [];
    if (rejectedEdits.length > 0) {
      blockingReasons.push(
        `${rejectedEdits.length} candidate edit(s) failed pre-flight structural syntax validation`
      );
    }
    if (semanticDiff.hasBreakingCrossPackageChanges) {
      blockingReasons.push(
        `${semanticDiff.crossPackageBreakages.length} incompatible cross-package contract breakage(s) detected`
      );
    }

    // 6. Optional compiler + selected/escalated test verification callback
    let verification: ExternalVerificationOutcome | undefined;
    if (verifier && blockingReasons.length === 0 && validEdits.length > 0) {
      const snapshotMap = new Map<string, string>();
      for (const [p, b] of authorizedBlobs.entries()) snapshotMap.set(p, b.content);
      for (const e of validEdits) snapshotMap.set(e.filePath, e.afterContent);

      verification = verifier({
        updatedBlobs: snapshotMap,
        selectedTests: testSelection.selectedTests,
        tier: testSelection.tier,
      });
      if (!verification.compilerPassed) {
        blockingReasons.push(
          `Compiler verification failed: ${verification.compilerDiagnostics.join('; ') || 'type/compile error'}`
        );
      }
      if (verification.failedTests.length > 0) {
        blockingReasons.push(
          `${verification.failedTests.length} selected/escalated test(s) failed: ${verification.failedTests.join(', ')}`
        );
      }
    }

    const readyToApply = blockingReasons.length === 0 && validEdits.length > 0;

    if (commitIfReady && readyToApply) {
      for (const edit of validEdits) {
        const prev = authorizedBlobs.get(edit.filePath);
        this.upsertBlob({
          tenantId: access.tenantId,
          repoId: prev?.repoId ?? access.repoId ?? 'default-repo',
          filePath: edit.filePath,
          packageName: edit.packageName,
          language: prev?.language,
          isTestFile: prev?.isTestFile,
          allowedRoles: prev?.allowedRoles,
          commitVersion: nextCommitVersion,
          content: edit.afterContent,
        });
      }
    }

    return {
      edits: validEdits,
      rejectedEdits,
      semanticDiff,
      testSelection,
      verification,
      readyToApply,
      blockingReasons,
    };
  }
}
