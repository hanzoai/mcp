/**
 * Graph Tools for Repository Reasoning & Change-Impact Analysis — RepoGraph (HIP-1347, Issue #37).
 *
 * Clean-room MIT TypeScript implementation inspired by:
 * - Ouyang et al., "RepoGraph: Enhancing AI Software Engineering with Repository-level Code Graph",
 *   ICLR 2025 (upstream MIT License).
 *
 * Provides six explicit architectural reasoning primitives:
 *   1. `find_callers`          — Direct & transitive callers with receiver/type disambiguation
 *   2. `find_implementations`  — TS implements/extends, Go structural interfaces, Rust impl Trait, Python subclasses + runtime dispatch
 *   3. `trace_dependency`      — Directed shortest & k-bounded symbol/file dependency chains
 *   4. `explain_change_impact` — Pre-execution blast-radius report fusing static graph, runtime traces, recent failures, and Git co-change history
 *   5. `find_related_tests`    — Ranked test suites covering affected symbols/files
 *   6. `find_regression_origin`— Hybrid backward-slice + runtime-error + Git-blame fault localization
 */

import * as crypto from 'crypto';
import * as path from 'path';

export type GraphLanguage = 'typescript' | 'javascript' | 'python' | 'rust' | 'go';

export type RepoGraphErrorCode =
  | 'TENANT_ISOLATION_VIOLATION'
  | 'RBAC_ACCESS_DENIED'
  | 'INVALID_GRAPH_ARGUMENT';

export class RepoGraphError extends Error {
  public readonly code: RepoGraphErrorCode;

  constructor(code: RepoGraphErrorCode, message: string) {
    super(message);
    this.name = 'RepoGraphError';
    this.code = code;
  }
}

export interface GraphAccessPolicy {
  readonly tenantId: string;
  readonly repoId?: string;
  readonly callerRoles?: readonly string[];
}

export interface SourceBlobNodeInput {
  readonly tenantId: string;
  readonly repoId: string;
  readonly filePath: string;
  readonly content: string;
  readonly commitSha?: string;
  readonly packageName?: string;
  readonly language?: GraphLanguage;
  readonly isTestFile?: boolean;
  readonly allowedRoles?: readonly string[];
}

export interface CanonicalSourceBlob {
  readonly blobId: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly packageName: string;
  readonly filePath: string;
  readonly commitSha: string;
  readonly sha256: string;
  readonly language: GraphLanguage;
  readonly isTestFile: boolean;
  readonly allowedRoles: readonly string[];
  readonly content: string;
}

export interface RuntimeTraceSpanInput {
  readonly traceId: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly commitSha?: string;
  readonly entryPoint: string;
  readonly callerFile: string;
  readonly callerSymbol: string;
  readonly calleeFile: string;
  readonly calleeSymbol: string;
  readonly calleeOwnerType?: string;
  readonly calleeLine?: number;
  readonly invocations: number;
  readonly errorCount?: number;
  readonly p95LatencyMs?: number;
  readonly allowedRoles?: readonly string[];
}

export interface CanonicalRuntimeTrace {
  readonly traceId: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly commitSha: string;
  readonly entryPoint: string;
  readonly callerFile: string;
  readonly callerSymbol: string;
  readonly calleeFile: string;
  readonly calleeSymbol: string;
  readonly calleeOwnerType?: string;
  readonly calleeLine: number;
  readonly invocations: number;
  readonly errorCount: number;
  readonly p95LatencyMs: number;
  readonly allowedRoles: readonly string[];
}

export interface StackFrameRef {
  readonly filePath: string;
  readonly symbolName: string;
  readonly line: number;
}

export interface RecentFailureInput {
  readonly failureId: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly commitSha: string;
  readonly testFile: string;
  readonly errorMessage: string;
  readonly stackFrames: readonly StackFrameRef[];
  readonly allowedRoles?: readonly string[];
}

export interface CanonicalFailureRecord {
  readonly failureId: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly commitSha: string;
  readonly testFile: string;
  readonly errorMessage: string;
  readonly stackFrames: readonly StackFrameRef[];
  readonly allowedRoles: readonly string[];
}

export interface CommitTouchedFile {
  readonly filePath: string;
  readonly changedLines?: readonly number[];
  readonly touchedSymbols?: readonly string[];
}

export interface GitCommitInput {
  readonly commitSha: string;
  readonly parentSha?: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly timestampEpochSec: number;
  readonly author: string;
  readonly message: string;
  readonly touchedFiles: readonly CommitTouchedFile[];
  readonly allowedRoles?: readonly string[];
}

export interface CanonicalGitCommit {
  readonly commitSha: string;
  readonly parentSha: string;
  readonly tenantId: string;
  readonly repoId: string;
  readonly timestampEpochSec: number;
  readonly author: string;
  readonly message: string;
  readonly touchedFiles: readonly CommitTouchedFile[];
  readonly allowedRoles: readonly string[];
}

// ── Derived Graph Entities ──────────────────────────────────────────────

export type GraphSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'trait'
  | 'struct';

export interface GraphSymbolNode {
  readonly nodeId: string; // `${filePath}::${ownerType ? ownerType + '.' : ''}${symbolName}`
  readonly symbolName: string;
  readonly ownerType?: string;
  readonly kind: GraphSymbolKind;
  readonly filePath: string;
  readonly packageName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly isTestFile: boolean;
  readonly declaredMethods?: readonly string[];
  readonly declaredImplements?: readonly string[];
}

export type GraphEdgeKind =
  | 'static_call'
  | 'interface_dispatch'
  | 'implements'
  | 'imports'
  | 'runtime_trace';

export interface GraphDirectedEdge {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: GraphEdgeKind;
  readonly callLine: number;
  readonly confidence: number;
  readonly runtimeInvocations: number;
  readonly runtimeErrors: number;
}

export interface CallerHit {
  readonly nodeId: string;
  readonly callerSymbol: string;
  readonly callerOwnerType?: string;
  readonly filePath: string;
  readonly packageName: string;
  readonly line: number;
  readonly hopDistance: number;
  readonly provenance: readonly GraphEdgeKind[];
  readonly runtimeInvocations: number;
  readonly confidence: number;
}

export interface ImplementationHit {
  readonly interfaceOrBase: string;
  readonly concreteType: string;
  readonly methodName?: string;
  readonly filePath: string;
  readonly packageName: string;
  readonly line: number;
  readonly mechanism: 'explicit_implements' | 'go_structural_interface' | 'rust_trait_impl' | 'python_subclass' | 'runtime_polymorphic';
  readonly runtimeInvocations: number;
  readonly confidence: number;
}

export interface DependencyPathHop {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeKind: GraphEdgeKind;
  readonly filePath: string;
  readonly line: number;
  readonly confidence: number;
}

export interface DependencyTraceResult {
  readonly reachable: boolean;
  readonly shortestHopCount: number | null;
  readonly paths: readonly {
    readonly hops: readonly DependencyPathHop[];
    readonly pathConfidence: number;
  }[];
  readonly falsePathsPruned: number;
}

export interface ImpactedSymbolEntry {
  readonly nodeId: string;
  readonly symbolName: string;
  readonly ownerType?: string;
  readonly filePath: string;
  readonly packageName: string;
  readonly line: number;
  readonly hopDistance: number;
  readonly impactScore: number;
  readonly reasons: readonly string[];
}

export interface CoChangeCouplingHit {
  readonly sourceFile: string;
  readonly coupledFile: string;
  readonly coChangeCommits: number;
  readonly couplingProbability: number;
}

export interface RelatedTestHit {
  readonly testFile: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly minHopDistance: number | null;
  readonly runtimeInvocations: number;
  readonly recentFailures: number;
}

export interface ChangeImpactReport {
  readonly overallRisk: 'low' | 'medium' | 'high' | 'critical';
  readonly impactedSymbols: readonly ImpactedSymbolEntry[];
  readonly affectedImplementations: readonly ImplementationHit[];
  readonly coChangeCoupledFiles: readonly CoChangeCouplingHit[];
  readonly relatedTests: readonly RelatedTestHit[];
  readonly falsePathsPruned: number;
  readonly summary: string;
}

export interface RegressionOriginCandidate {
  readonly rank: number;
  readonly commitSha: string;
  readonly author: string;
  readonly commitMessage: string;
  readonly filePath: string;
  readonly symbolName: string;
  readonly line: number;
  readonly suspiciousnessScore: number;
  readonly evidence: readonly string[];
}

// ── Canonical Identity & Access Helpers ─────────────────────────────────

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function normalizeGraphPath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0')) {
    throw new RepoGraphError('INVALID_GRAPH_ARGUMENT', 'Path must be non-empty and free of NUL bytes');
  }
  const clean = path.posix.normalize(rawPath.replace(/\\/g, '/').replace(/^\/+/, ''));
  if (clean === '.' || clean === '..' || clean.startsWith('../') || clean.includes('/../')) {
    throw new RepoGraphError('INVALID_GRAPH_ARGUMENT', `Invalid repository-relative path: ${rawPath}`);
  }
  return clean;
}

function detectGraphLanguage(filePath: string): GraphLanguage {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.jsx')) {
    return 'javascript';
  }
  return 'typescript';
}

function detectPackage(filePath: string): string {
  const segs = filePath.split('/');
  if (segs.length >= 3 && ['packages', 'crates', 'services', 'apps', 'modules'].includes(segs[0])) {
    return `${segs[0]}/${segs[1]}`;
  }
  return segs.length >= 2 && segs[0] !== 'src' && segs[0] !== 'test' && segs[0] !== 'tests'
    ? segs[0]
    : 'root';
}

function detectTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = path.posix.basename(lower);
  return (
    lower.startsWith('test/') ||
    lower.startsWith('tests/') ||
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/') ||
    base.endsWith('.test.ts') ||
    base.endsWith('.spec.ts') ||
    base.endsWith('.test.js') ||
    base.endsWith('_test.go') ||
    base.endsWith('_test.rs') ||
    base.endsWith('_test.py') ||
    base.startsWith('test_')
  );
}

function isAuthorizedRecord(
  record: { tenantId: string; repoId: string; allowedRoles: readonly string[] },
  access: GraphAccessPolicy
): boolean {
  if (!access.tenantId || record.tenantId !== access.tenantId) return false;
  if (access.repoId && record.repoId !== access.repoId) return false;
  if (record.allowedRoles.length > 0) {
    const roles = access.callerRoles ?? [];
    if (!record.allowedRoles.some((r) => roles.includes(r))) return false;
  }
  return true;
}

// ── Polyglot Symbol, Receiver Type & Call Extractor ─────────────────────

interface RawCallRef {
  readonly fromNodeId: string;
  readonly calleeName: string;
  readonly receiverHintType?: string;
  readonly receiverIdent?: string;
  readonly line: number;
}

interface ParsedFileStructure {
  readonly nodes: readonly GraphSymbolNode[];
  readonly rawCalls: readonly RawCallRef[];
  readonly importedSpecifiers: readonly string[];
  readonly explicitImpls: readonly {
    readonly concreteType: string;
    readonly baseOrInterface: string;
    readonly filePath: string;
    readonly packageName: string;
    readonly line: number;
    readonly mechanism: ImplementationHit['mechanism'];
  }[];
}

function stripLineComments(line: string, lang: GraphLanguage): string {
  if (lang === 'python') {
    const idx = line.indexOf('#');
    return idx >= 0 ? line.slice(0, idx) : line;
  }
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

function parseBlobStructure(blob: CanonicalSourceBlob): ParsedFileStructure {
  const lines = blob.content.split('\n');
  const nodes: GraphSymbolNode[] = [];
  const rawCalls: RawCallRef[] = [];
  const importedSpecifiers: string[] = [];
  const explicitImpls: {
    concreteType: string;
    baseOrInterface: string;
    filePath: string;
    packageName: string;
    line: number;
    mechanism: ImplementationHit['mechanism'];
  }[] = [];

  // Track variable -> static type annotations inside each file/scope (e.g. `gateway: PaymentGateway`, ` gw := &StripeGateway{}`)
  const varTypeHints = new Map<string, string>();

  for (const rawLine of lines) {
    const ln = stripLineComments(rawLine, blob.language);
    // TS/Python/Rust `name: TypeName`
    const typedVarRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:&(?:mut\s+)?|\*)?(?:dyn\s+|Box<\s*dyn\s+)?([A-Z][A-Za-z0-9_]*)/g;
    let tm: RegExpExecArray | null;
    while ((tm = typedVarRe.exec(ln)) !== null) {
      varTypeHints.set(tm[1], tm[2]);
    }
    // `const x = new ConcreteType(` or `x := &ConcreteType{` or `x = ConcreteType(`
    const ctorRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=)\s*(?:new\s+|&)?([A-Z][A-Za-z0-9_]*)\s*[({]/g;
    while ((tm = ctorRe.exec(ln)) !== null) {
      varTypeHints.set(tm[1], tm[2]);
    }
  }

  // Extract imports
  for (const rawLine of lines) {
    const ln = stripLineComments(rawLine, blob.language);
    const tsImp = ln.match(/from\s+['"]([^'"]+)['"]/);
    if (tsImp) importedSpecifiers.push(tsImp[1]);
    const pyImp = ln.match(/^\s*(?:from|import)\s+([A-Za-z0-9_.]+)/);
    if (pyImp && blob.language === 'python') importedSpecifiers.push(pyImp[1]);
    const rsUse = ln.match(/^\s*use\s+([A-Za-z0-9_:]+)/);
    if (rsUse && blob.language === 'rust') importedSpecifiers.push(rsUse[1]);
    const goImp = ln.match(/^\s*(?:import\s+)?"([^"]+)"/);
    if (goImp && blob.language === 'go') importedSpecifiers.push(goImp[1]);
  }

  if (blob.language === 'typescript' || blob.language === 'javascript') {
    parseTsStructure(blob, lines, nodes, explicitImpls);
  } else if (blob.language === 'go') {
    parseGoStructure(blob, lines, nodes, explicitImpls);
  } else if (blob.language === 'rust') {
    parseRustStructure(blob, lines, nodes, explicitImpls);
  } else if (blob.language === 'python') {
    parsePythonStructure(blob, lines, nodes, explicitImpls);
  }

  // Fallback module node if file has top-level calls (such as test files)
  const moduleNodeId = `${blob.filePath}::<module>`;
  if (nodes.length === 0 || blob.isTestFile) {
    nodes.push({
      nodeId: moduleNodeId,
      symbolName: '<module>',
      kind: 'function',
      filePath: blob.filePath,
      packageName: blob.packageName,
      startLine: 1,
      endLine: lines.length,
      isTestFile: blob.isTestFile,
    });
  }

  // Extract call sites per line and bind to innermost enclosing symbol node
  const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'function', 'fn', 'func', 'def',
    'class', 'interface', 'struct', 'trait', 'impl', 'typeof', 'super', 'import', 'from',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const cleanLine = stripLineComments(lines[i], blob.language)
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/`(?:\\.|[^`\\])*`/g, '``');

    // Find innermost non-<module> symbol containing lineNo
    const candidates = nodes.filter(
      (n) =>
        n.symbolName !== '<module>' &&
        (n.kind === 'function' || n.kind === 'method') &&
        lineNo >= n.startLine &&
        lineNo <= n.endLine
    );
    const enclosing =
      candidates.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0] ??
      nodes.find((n) => n.nodeId === moduleNodeId) ??
      nodes[0];

    const callRe = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|::)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(cleanLine)) !== null) {
      const recv = cm[1];
      const callee = cm[2];
      if (KEYWORDS.has(callee)) continue;
      // Ignore the function/method declaration header line itself
      if (lineNo === enclosing.startLine && callee === enclosing.symbolName && !recv) {
        continue;
      }

      let receiverHintType: string | undefined;
      if (recv === 'this' || recv === 'self') {
        receiverHintType = enclosing.ownerType;
      } else if (recv) {
        receiverHintType = varTypeHints.get(recv) ?? (/^[A-Z]/.test(recv) ? recv : undefined);
      }

      rawCalls.push({
        fromNodeId: enclosing.nodeId,
        calleeName: callee,
        receiverHintType,
        receiverIdent: recv,
        line: lineNo,
      });
    }
  }

  return {
    nodes,
    rawCalls,
    importedSpecifiers,
    explicitImpls,
  };
}

function findBlockEndLine(lines: readonly string[], startIdx: number): number {
  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < lines.length; i++) {
    const clean = lines[i]
      .replace(/\/\/.*$/, '')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
    for (const ch of clean) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
        if (opened && depth <= 0) return i + 1;
      }
    }
  }
  return Math.min(lines.length, startIdx + 10);
}

function parseTsStructure(
  blob: CanonicalSourceBlob,
  lines: readonly string[],
  nodes: GraphSymbolNode[],
  explicitImpls: {
    concreteType: string;
    baseOrInterface: string;
    filePath: string;
    packageName: string;
    line: number;
    mechanism: ImplementationHit['mechanism'];
  }[]
): void {
  for (let i = 0; i < lines.length; i++) {
    const ln = stripLineComments(lines[i], 'typescript');

    // Interface declaration
    const ifaceMatch = ln.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (ifaceMatch) {
      const ifaceName = ifaceMatch[1];
      const endLine = findBlockEndLine(lines, i);
      const declaredMethods: string[] = [];
      for (let k = i + 1; k < endLine - 1; k++) {
        const mm = stripLineComments(lines[k], 'typescript').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (mm) {
          declaredMethods.push(mm[1]);
          nodes.push({
            nodeId: `${blob.filePath}::${ifaceName}.${mm[1]}`,
            symbolName: mm[1],
            ownerType: ifaceName,
            kind: 'method',
            filePath: blob.filePath,
            packageName: blob.packageName,
            startLine: k + 1,
            endLine: k + 1,
            isTestFile: blob.isTestFile,
          });
        }
      }
      nodes.push({
        nodeId: `${blob.filePath}::${ifaceName}`,
        symbolName: ifaceName,
        kind: 'interface',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine,
        isTestFile: blob.isTestFile,
        declaredMethods,
      });
      continue;
    }

    // Class declaration (`extends Base`, `implements I1, I2`)
    const clsMatch = ln.match(
      /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_][A-Za-z0-9_]*))?(?:\s+implements\s+([^{]+))?/
    );
    if (clsMatch) {
      const clsName = clsMatch[1];
      const ext = clsMatch[2]?.trim();
      const implRaw = clsMatch[3]?.trim();
      const endLine = findBlockEndLine(lines, i);
      const implList: string[] = [];
      if (ext) {
        implList.push(ext);
        explicitImpls.push({
          concreteType: clsName,
          baseOrInterface: ext,
          filePath: blob.filePath,
          packageName: blob.packageName,
          line: i + 1,
          mechanism: 'explicit_implements',
        });
      }
      if (implRaw) {
        for (const item of implRaw.split(',')) {
          const base = item.trim().replace(/<.*>$/, '').trim();
          if (base) {
            implList.push(base);
            explicitImpls.push({
              concreteType: clsName,
              baseOrInterface: base,
              filePath: blob.filePath,
              packageName: blob.packageName,
              line: i + 1,
              mechanism: 'explicit_implements',
            });
          }
        }
      }

      const methods: string[] = [];
      for (let k = i + 1; k < endLine - 1; k++) {
        const mLine = stripLineComments(lines[k], 'typescript');
        const methMatch = mLine.match(
          /^\s*(?:public\s+|private\s+|protected\s+|async\s+|override\s+|static\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/
        );
        if (methMatch && methMatch[1] !== 'constructor' && !['if', 'for', 'while', 'switch', 'catch'].includes(methMatch[1])) {
          const mName = methMatch[1];
          const mEnd = findBlockEndLine(lines, k);
          methods.push(mName);
          nodes.push({
            nodeId: `${blob.filePath}::${clsName}.${mName}`,
            symbolName: mName,
            ownerType: clsName,
            kind: 'method',
            filePath: blob.filePath,
            packageName: blob.packageName,
            startLine: k + 1,
            endLine: mEnd,
            isTestFile: blob.isTestFile,
          });
          k = Math.max(k, mEnd - 1);
        }
      }

      nodes.push({
        nodeId: `${blob.filePath}::${clsName}`,
        symbolName: clsName,
        kind: 'class',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine,
        isTestFile: blob.isTestFile,
        declaredMethods: methods,
        declaredImplements: implList,
      });
      continue;
    }

    // Standalone function
    const fnMatch = ln.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/);
    if (fnMatch) {
      const fnName = fnMatch[1];
      const endLine = findBlockEndLine(lines, i);
      nodes.push({
        nodeId: `${blob.filePath}::${fnName}`,
        symbolName: fnName,
        kind: 'function',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine,
        isTestFile: blob.isTestFile,
      });
    }
  }
}

function parseGoStructure(
  blob: CanonicalSourceBlob,
  lines: readonly string[],
  nodes: GraphSymbolNode[],
  _explicitImpls: unknown[]
): void {
  const structMethods = new Map<string, string[]>();
  const structLines = new Map<string, { start: number; end: number }>();

  for (let i = 0; i < lines.length; i++) {
    const ln = stripLineComments(lines[i], 'go');

    const ifaceMatch = ln.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\s*\{/);
    if (ifaceMatch) {
      const ifaceName = ifaceMatch[1];
      const endLine = findBlockEndLine(lines, i);
      const methods: string[] = [];
      for (let k = i + 1; k < endLine - 1; k++) {
        const mm = stripLineComments(lines[k], 'go').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (mm) {
          methods.push(mm[1]);
          nodes.push({
            nodeId: `${blob.filePath}::${ifaceName}.${mm[1]}`,
            symbolName: mm[1],
            ownerType: ifaceName,
            kind: 'method',
            filePath: blob.filePath,
            packageName: blob.packageName,
            startLine: k + 1,
            endLine: k + 1,
            isTestFile: blob.isTestFile,
          });
        }
      }
      nodes.push({
        nodeId: `${blob.filePath}::${ifaceName}`,
        symbolName: ifaceName,
        kind: 'interface',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine,
        isTestFile: blob.isTestFile,
        declaredMethods: methods,
      });
      continue;
    }

    const structMatch = ln.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{/);
    if (structMatch) {
      const sName = structMatch[1];
      structLines.set(sName, { start: i + 1, end: findBlockEndLine(lines, i) });
      continue;
    }

    const recvFnMatch = ln.match(
      /^\s*func\s*\(\s*[A-Za-z0-9_]+\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/
    );
    if (recvFnMatch) {
      const recvType = recvFnMatch[1];
      const mName = recvFnMatch[2];
      const endLine = findBlockEndLine(lines, i);
      const list = structMethods.get(recvType) ?? [];
      list.push(mName);
      structMethods.set(recvType, list);
      nodes.push({
        nodeId: `${blob.filePath}::${recvType}.${mName}`,
        symbolName: mName,
        ownerType: recvType,
        kind: 'method',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine,
        isTestFile: blob.isTestFile,
      });
      continue;
    }

    const freeFnMatch = ln.match(/^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (freeFnMatch) {
      const fnName = freeFnMatch[1];
      nodes.push({
        nodeId: `${blob.filePath}::${fnName}`,
        symbolName: fnName,
        kind: 'function',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine: findBlockEndLine(lines, i),
        isTestFile: blob.isTestFile,
      });
    }
  }

  const allStructs = new Set<string>([...structLines.keys(), ...structMethods.keys()]);
  for (const sName of allStructs) {
    const loc = structLines.get(sName) ?? { start: 1, end: 1 };
    nodes.push({
      nodeId: `${blob.filePath}::${sName}`,
      symbolName: sName,
      kind: 'struct',
      filePath: blob.filePath,
      packageName: blob.packageName,
      startLine: loc.start,
      endLine: loc.end,
      isTestFile: blob.isTestFile,
      declaredMethods: structMethods.get(sName) ?? [],
    });
  }
}

function parseRustStructure(
  blob: CanonicalSourceBlob,
  lines: readonly string[],
  nodes: GraphSymbolNode[],
  explicitImpls: {
    concreteType: string;
    baseOrInterface: string;
    filePath: string;
    packageName: string;
    line: number;
    mechanism: ImplementationHit['mechanism'];
  }[]
): void {
  for (let i = 0; i < lines.length; i++) {
    const ln = stripLineComments(lines[i], 'rust');

    const traitMatch = ln.match(/^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (traitMatch) {
      const tName = traitMatch[1];
      const endLine = findBlockEndLine(lines, i);
      const methods: string[] = [];
      for (let k = i + 1; k < endLine - 1; k++) {
        const fnm = stripLineComments(lines[k], 'rust').match(/^\s*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (fnm) {
          methods.push(fnm[1]);
          nodes.push({
            nodeId: `${blob.filePath}::${tName}.${fnm[1]}`,
            symbolName: fnm[1],
            ownerType: tName,
            kind: 'method',
            filePath: blob.filePath,
            packageName: blob.packageName,
            startLine: k + 1,
            endLine: k + 1,
            isTestFile: blob.isTestFile,
          });
        }
      }
      nodes.push({
        nodeId: `${blob.filePath}::${tName}`,
        symbolName: tName,
        kind: 'trait',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine,
        isTestFile: blob.isTestFile,
        declaredMethods: methods,
      });
      continue;
    }

    const implTraitMatch = ln.match(
      /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s+for\s+([A-Za-z_][A-Za-z0-9_]*)/
    );
    if (implTraitMatch) {
      const traitName = implTraitMatch[1];
      const structName = implTraitMatch[2];
      const endLine = findBlockEndLine(lines, i);
      explicitImpls.push({
        concreteType: structName,
        baseOrInterface: traitName,
        filePath: blob.filePath,
        packageName: blob.packageName,
        line: i + 1,
        mechanism: 'rust_trait_impl',
      });
      const methods: string[] = [];
      for (let k = i + 1; k < endLine - 1; k++) {
        const fnm = stripLineComments(lines[k], 'rust').match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (fnm) {
          const mEnd = findBlockEndLine(lines, k);
          methods.push(fnm[1]);
          nodes.push({
            nodeId: `${blob.filePath}::${structName}.${fnm[1]}`,
            symbolName: fnm[1],
            ownerType: structName,
            kind: 'method',
            filePath: blob.filePath,
            packageName: blob.packageName,
            startLine: k + 1,
            endLine: mEnd,
            isTestFile: blob.isTestFile,
          });
          k = Math.max(k, mEnd - 1);
        }
      }
      nodes.push({
        nodeId: `${blob.filePath}::${structName}`,
        symbolName: structName,
        kind: 'struct',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine,
        isTestFile: blob.isTestFile,
        declaredMethods: methods,
        declaredImplements: [traitName],
      });
      i = Math.max(i, endLine - 1);
      continue;
    }

    const implInherent = ln.match(/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
    if (implInherent) {
      const structName = implInherent[1];
      const endLine = findBlockEndLine(lines, i);
      for (let k = i + 1; k < endLine - 1; k++) {
        const fnm = stripLineComments(lines[k], 'rust').match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (fnm) {
          const mEnd = findBlockEndLine(lines, k);
          nodes.push({
            nodeId: `${blob.filePath}::${structName}.${fnm[1]}`,
            symbolName: fnm[1],
            ownerType: structName,
            kind: 'method',
            filePath: blob.filePath,
            packageName: blob.packageName,
            startLine: k + 1,
            endLine: mEnd,
            isTestFile: blob.isTestFile,
          });
          k = Math.max(k, mEnd - 1);
        }
      }
      i = Math.max(i, endLine - 1);
      continue;
    }

    const freeFn = ln.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (freeFn) {
      nodes.push({
        nodeId: `${blob.filePath}::${freeFn[1]}`,
        symbolName: freeFn[1],
        kind: 'function',
        filePath: blob.filePath,
        packageName: blob.packageName,
        startLine: i + 1,
        endLine: findBlockEndLine(lines, i),
        isTestFile: blob.isTestFile,
      });
    }
  }
}

function parsePythonStructure(
  blob: CanonicalSourceBlob,
  lines: readonly string[],
  nodes: GraphSymbolNode[],
  explicitImpls: {
    concreteType: string;
    baseOrInterface: string;
    filePath: string;
    packageName: string;
    line: number;
    mechanism: ImplementationHit['mechanism'];
  }[]
): void {
  let activeClass: { name: string; indent: number; startLine: number; methods: string[]; bases: string[] } | null = null;

  const flushClass = (endLine: number) => {
    if (!activeClass) return;
    nodes.push({
      nodeId: `${blob.filePath}::${activeClass.name}`,
      symbolName: activeClass.name,
      kind: 'class',
      filePath: blob.filePath,
      packageName: blob.packageName,
      startLine: activeClass.startLine,
      endLine,
      isTestFile: blob.isTestFile,
      declaredMethods: activeClass.methods,
      declaredImplements: activeClass.bases,
    });
    activeClass = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = (raw.match(/^[ \t]*/) ?? [''])[0].length;

    if (activeClass && indent <= activeClass.indent) {
      flushClass(i);
    }

    const clsMatch = raw.match(/^([ \t]*)class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*:/);
    if (clsMatch) {
      const clsName = clsMatch[2];
      const bases = (clsMatch[3] ?? '')
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b && b !== 'ABC' && b !== 'Protocol' && b !== 'object');
      for (const base of bases) {
        explicitImpls.push({
          concreteType: clsName,
          baseOrInterface: base,
          filePath: blob.filePath,
          packageName: blob.packageName,
          line: i + 1,
          mechanism: 'python_subclass',
        });
      }
      activeClass = {
        name: clsName,
        indent: clsMatch[1].length,
        startLine: i + 1,
        methods: [],
        bases,
      };
      continue;
    }

    const defMatch = raw.match(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (defMatch) {
      const defIndent = defMatch[1].length;
      const fnName = defMatch[2];
      let endLine = i + 1;
      for (let k = i + 1; k < lines.length; k++) {
        const kt = lines[k].trim();
        if (!kt || kt.startsWith('#')) continue;
        const ki = (lines[k].match(/^[ \t]*/) ?? [''])[0].length;
        if (ki <= defIndent) break;
        endLine = k + 1;
      }
      if (activeClass && defIndent > activeClass.indent) {
        activeClass.methods.push(fnName);
        nodes.push({
          nodeId: `${blob.filePath}::${activeClass.name}.${fnName}`,
          symbolName: fnName,
          ownerType: activeClass.name,
          kind: 'method',
          filePath: blob.filePath,
          packageName: blob.packageName,
          startLine: i + 1,
          endLine,
          isTestFile: blob.isTestFile,
        });
      } else {
        nodes.push({
          nodeId: `${blob.filePath}::${fnName}`,
          symbolName: fnName,
          kind: 'function',
          filePath: blob.filePath,
          packageName: blob.packageName,
          startLine: i + 1,
          endLine,
          isTestFile: blob.isTestFile,
        });
      }
    }
  }
  flushClass(lines.length);
}

// ── RepoGraph Engine (Derived Index + 6 Reasoning Tools) ────────────────

interface ScopedDerivedGraph {
  readonly nodesById: ReadonlyMap<string, GraphSymbolNode>;
  readonly nodesBySymbol: ReadonlyMap<string, readonly GraphSymbolNode[]>;
  readonly outgoingEdges: ReadonlyMap<string, readonly GraphDirectedEdge[]>;
  readonly incomingEdges: ReadonlyMap<string, readonly GraphDirectedEdge[]>;
  readonly implementationsByBase: ReadonlyMap<string, readonly ImplementationHit[]>;
  readonly coChangeCoupling: ReadonlyMap<string, readonly CoChangeCouplingHit[]>;
  readonly falseStaticEdgesPruned: number;
}

export class RepoGraphEngine {
  private readonly canonicalBlobs = new Map<string, CanonicalSourceBlob>();
  private readonly canonicalTraces = new Map<string, CanonicalRuntimeTrace>();
  private readonly canonicalFailures = new Map<string, CanonicalFailureRecord>();
  private readonly canonicalCommits = new Map<string, CanonicalGitCommit>();

  // Derived per-blob parsed structure cache (purely derived from canonicalBlobs)
  private derivedBlobCache = new Map<string, ParsedFileStructure>();

  constructor(init?: {
    blobs?: readonly SourceBlobNodeInput[];
    traces?: readonly RuntimeTraceSpanInput[];
    failures?: readonly RecentFailureInput[];
    commits?: readonly GitCommitInput[];
  }) {
    for (const b of init?.blobs ?? []) this.upsertBlob(b);
    for (const t of init?.traces ?? []) this.upsertRuntimeTrace(t);
    for (const f of init?.failures ?? []) this.upsertFailure(f);
    for (const c of init?.commits ?? []) this.upsertCommit(c);
  }

  public upsertBlob(input: SourceBlobNodeInput): CanonicalSourceBlob {
    const filePath = normalizeGraphPath(input.filePath);
    const commitSha = (input.commitSha ?? 'HEAD').trim() || 'HEAD';
    const digest = sha256(input.content);
    const key = `${input.tenantId}:${input.repoId}:${filePath}`;
    const record: CanonicalSourceBlob = {
      blobId: `${key}@${commitSha}:${digest.slice(0, 16)}`,
      tenantId: input.tenantId,
      repoId: input.repoId,
      packageName: input.packageName ?? detectPackage(filePath),
      filePath,
      commitSha,
      sha256: digest,
      language: input.language ?? detectGraphLanguage(filePath),
      isTestFile: input.isTestFile ?? detectTestFile(filePath),
      allowedRoles: input.allowedRoles ? [...input.allowedRoles] : [],
      content: input.content,
    };
    this.canonicalBlobs.set(key, record);
    this.derivedBlobCache.set(record.blobId, parseBlobStructure(record));
    return record;
  }

  public upsertRuntimeTrace(input: RuntimeTraceSpanInput): CanonicalRuntimeTrace {
    const record: CanonicalRuntimeTrace = {
      traceId: input.traceId,
      tenantId: input.tenantId,
      repoId: input.repoId,
      commitSha: input.commitSha ?? 'HEAD',
      entryPoint: normalizeGraphPath(input.entryPoint),
      callerFile: normalizeGraphPath(input.callerFile),
      callerSymbol: input.callerSymbol,
      calleeFile: normalizeGraphPath(input.calleeFile),
      calleeSymbol: input.calleeSymbol,
      calleeOwnerType: input.calleeOwnerType,
      calleeLine: input.calleeLine ?? 1,
      invocations: Math.max(1, input.invocations),
      errorCount: Math.max(0, input.errorCount ?? 0),
      p95LatencyMs: Math.max(0, input.p95LatencyMs ?? 0),
      allowedRoles: input.allowedRoles ? [...input.allowedRoles] : [],
    };
    this.canonicalTraces.set(`${record.tenantId}:${record.repoId}:${record.traceId}`, record);
    return record;
  }

  public upsertFailure(input: RecentFailureInput): CanonicalFailureRecord {
    const record: CanonicalFailureRecord = {
      failureId: input.failureId,
      tenantId: input.tenantId,
      repoId: input.repoId,
      commitSha: input.commitSha,
      testFile: normalizeGraphPath(input.testFile),
      errorMessage: input.errorMessage,
      stackFrames: input.stackFrames.map((sf) => ({
        filePath: normalizeGraphPath(sf.filePath),
        symbolName: sf.symbolName,
        line: sf.line,
      })),
      allowedRoles: input.allowedRoles ? [...input.allowedRoles] : [],
    };
    this.canonicalFailures.set(`${record.tenantId}:${record.repoId}:${record.failureId}`, record);
    return record;
  }

  public upsertCommit(input: GitCommitInput): CanonicalGitCommit {
    const record: CanonicalGitCommit = {
      commitSha: input.commitSha,
      parentSha: input.parentSha ?? '',
      tenantId: input.tenantId,
      repoId: input.repoId,
      timestampEpochSec: input.timestampEpochSec,
      author: input.author,
      message: input.message,
      touchedFiles: input.touchedFiles.map((tf) => ({
        filePath: normalizeGraphPath(tf.filePath),
        changedLines: tf.changedLines ? [...tf.changedLines] : [],
        touchedSymbols: tf.touchedSymbols ? [...tf.touchedSymbols] : [],
      })),
      allowedRoles: input.allowedRoles ? [...input.allowedRoles] : [],
    };
    this.canonicalCommits.set(`${record.tenantId}:${record.repoId}:${record.commitSha}`, record);
    return record;
  }

  /**
   * Discards all derived AST/graph caches and rebuilds them purely from canonical blob identities.
   */
  public rebuildDerivedGraph(): string {
    this.derivedBlobCache.clear();
    for (const blob of this.canonicalBlobs.values()) {
      this.derivedBlobCache.set(blob.blobId, parseBlobStructure(blob));
    }
    return this.getDerivedSnapshotDigest();
  }

  public getDerivedSnapshotDigest(): string {
    const entries = [...this.derivedBlobCache.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([blobId, parsed]) => {
        const nodeIds = parsed.nodes.map((n) => `${n.nodeId}@${n.startLine}-${n.endLine}`).join(',');
        const calls = parsed.rawCalls.map((c) => `${c.fromNodeId}->${c.receiverHintType ?? ''}.${c.calleeName}:${c.line}`).join(',');
        return `${blobId}|${nodeIds}|${calls}`;
      });
    return sha256(entries.join('\n'));
  }

  private buildAuthorizedGraph(access: GraphAccessPolicy): {
    graph: ScopedDerivedGraph;
    blobs: readonly CanonicalSourceBlob[];
    traces: readonly CanonicalRuntimeTrace[];
    failures: readonly CanonicalFailureRecord[];
    commits: readonly CanonicalGitCommit[];
  } {
    if (!access.tenantId || !access.tenantId.trim()) {
      throw new RepoGraphError('TENANT_ISOLATION_VIOLATION', 'tenantId is mandatory for RepoGraph queries');
    }

    const blobs = [...this.canonicalBlobs.values()].filter((b) => isAuthorizedRecord(b, access));
    const traces = [...this.canonicalTraces.values()].filter((t) => isAuthorizedRecord(t, access));
    const failures = [...this.canonicalFailures.values()].filter((f) => isAuthorizedRecord(f, access));
    const commits = [...this.canonicalCommits.values()].filter((c) => isAuthorizedRecord(c, access));

    const nodesById = new Map<string, GraphSymbolNode>();
    const nodesBySymbol = new Map<string, GraphSymbolNode[]>();
    const allRawCalls: { blob: CanonicalSourceBlob; call: RawCallRef }[] = [];
    const implMap = new Map<string, ImplementationHit[]>();

    for (const blob of blobs) {
      let parsed = this.derivedBlobCache.get(blob.blobId);
      if (!parsed) {
        parsed = parseBlobStructure(blob);
        this.derivedBlobCache.set(blob.blobId, parsed);
      }
      for (const n of parsed.nodes) {
        nodesById.set(n.nodeId, n);
        const list = nodesBySymbol.get(n.symbolName) ?? [];
        list.push(n);
        nodesBySymbol.set(n.symbolName, list);
      }
      for (const rc of parsed.rawCalls) {
        allRawCalls.push({ blob, call: rc });
      }
      for (const imp of parsed.explicitImpls) {
        const arr = implMap.get(imp.baseOrInterface) ?? [];
        arr.push({
          interfaceOrBase: imp.baseOrInterface,
          concreteType: imp.concreteType,
          filePath: imp.filePath,
          packageName: imp.packageName,
          line: imp.line,
          mechanism: imp.mechanism,
          runtimeInvocations: 0,
          confidence: 0.96,
        });
        implMap.set(imp.baseOrInterface, arr);
      }
    }

    // Go structural interface satisfaction across authorized Go structs & interfaces
    const goInterfaces = [...nodesById.values()].filter(
      (n) => n.kind === 'interface' && n.filePath.endsWith('.go') && (n.declaredMethods?.length ?? 0) > 0
    );
    const goStructs = [...nodesById.values()].filter(
      (n) => n.kind === 'struct' && n.filePath.endsWith('.go') && (n.declaredMethods?.length ?? 0) > 0
    );
    for (const iface of goInterfaces) {
      const reqMethods = iface.declaredMethods ?? [];
      for (const st of goStructs) {
        const stMethods = new Set(st.declaredMethods ?? []);
        if (reqMethods.every((m) => stMethods.has(m))) {
          const arr = implMap.get(iface.symbolName) ?? [];
          arr.push({
            interfaceOrBase: iface.symbolName,
            concreteType: st.symbolName,
            filePath: st.filePath,
            packageName: st.packageName,
            line: st.startLine,
            mechanism: 'go_structural_interface',
            runtimeInvocations: 0,
            confidence: 0.94,
          });
          implMap.set(iface.symbolName, arr);
        }
      }
    }

    // Index runtime trace aggregates
    const runtimeEdgeStats = new Map<string, { invocations: number; errors: number; line: number }>();
    for (const tr of traces) {
      const fromNode =
        this.resolveNodeInFile(nodesById, tr.callerFile, tr.callerSymbol) ??
        `${tr.callerFile}::${tr.callerSymbol}`;
      const toNode =
        this.resolveNodeInFile(nodesById, tr.calleeFile, tr.calleeSymbol, tr.calleeOwnerType) ??
        `${tr.calleeFile}::${tr.calleeOwnerType ? tr.calleeOwnerType + '.' : ''}${tr.calleeSymbol}`;
      const key = `${fromNode}|${toNode}`;
      const prev = runtimeEdgeStats.get(key) ?? { invocations: 0, errors: 0, line: tr.calleeLine };
      runtimeEdgeStats.set(key, {
        invocations: prev.invocations + tr.invocations,
        errors: prev.errors + tr.errorCount,
        line: tr.calleeLine,
      });

      // Update runtime invocations on matching concrete implementation hits
      if (tr.calleeOwnerType) {
        for (const [base, hits] of implMap.entries()) {
          const updated = hits.map((h) =>
            h.concreteType === tr.calleeOwnerType
              ? { ...h, runtimeInvocations: h.runtimeInvocations + tr.invocations }
              : h
          );
          implMap.set(base, updated);
        }
      }
    }

    // Build directed edges with receiver & interface disambiguation
    const edgeDedup = new Map<string, GraphDirectedEdge>();
    let falseStaticEdgesPruned = 0;

    const addEdge = (edge: GraphDirectedEdge) => {
      const k = `${edge.fromNodeId}|${edge.toNodeId}|${edge.kind}`;
      const existing = edgeDedup.get(k);
      if (!existing || edge.confidence > existing.confidence) {
        edgeDedup.set(k, edge);
      }
    };

    // Add `implements` edges between interface method nodes and concrete method nodes
    for (const [baseName, implHits] of implMap.entries()) {
      const baseNodes = nodesBySymbol.get(baseName) ?? [];
      for (const bNode of baseNodes) {
        for (const hit of implHits) {
          const concreteNodes = (nodesBySymbol.get(hit.concreteType) ?? []).filter(
            (n) => n.filePath === hit.filePath
          );
          for (const cNode of concreteNodes) {
            addEdge({
              fromNodeId: bNode.nodeId,
              toNodeId: cNode.nodeId,
              kind: 'implements',
              callLine: hit.line,
              confidence: hit.confidence,
              runtimeInvocations: hit.runtimeInvocations,
              runtimeErrors: 0,
            });
          }
          // Link interface methods -> concrete methods (`PaymentPort.charge` -> `StripeGateway.charge`)
          for (const mName of bNode.declaredMethods ?? []) {
            const ifaceMethodId = `${bNode.filePath}::${baseName}.${mName}`;
            const concreteMethod = (nodesBySymbol.get(mName) ?? []).find(
              (n) => n.ownerType === hit.concreteType
            );
            if (nodesById.has(ifaceMethodId) && concreteMethod) {
              addEdge({
                fromNodeId: ifaceMethodId,
                toNodeId: concreteMethod.nodeId,
                kind: 'implements',
                callLine: concreteMethod.startLine,
                confidence: hit.runtimeInvocations > 0 ? 0.98 : 0.88,
                runtimeInvocations: hit.runtimeInvocations,
                runtimeErrors: 0,
              });
            }
          }
        }
      }
    }

    // Resolve static calls with receiver-type pruning
    for (const { call } of allRawCalls) {
      const targets = nodesBySymbol.get(call.calleeName) ?? [];
      if (targets.length === 0) continue;

      const acceptedTargets: { node: GraphSymbolNode; kind: GraphEdgeKind; conf: number }[] = [];

      for (const candidate of targets) {
        if (candidate.nodeId === call.fromNodeId) continue;

        if (call.receiverHintType) {
          // Direct owner match
          if (candidate.ownerType === call.receiverHintType) {
            acceptedTargets.push({ node: candidate, kind: 'static_call', conf: 0.95 });
            continue;
          }
          // Receiver hint is an interface/base implemented by candidate.ownerType
          const implsOfHint = implMap.get(call.receiverHintType) ?? [];
          if (
            candidate.ownerType &&
            implsOfHint.some((ih) => ih.concreteType === candidate.ownerType)
          ) {
            acceptedTargets.push({ node: candidate, kind: 'interface_dispatch', conf: 0.9 });
            continue;
          }
          // Receiver type explicitly known and incompatible with candidate's ownerType -> PRUNE FALSE PATH!
          if (candidate.ownerType && candidate.ownerType !== call.receiverHintType) {
            falseStaticEdgesPruned++;
            continue;
          }
        }

        // Unqualified or untyped receiver call
        const conf = candidate.ownerType ? 0.68 : 0.92;
        acceptedTargets.push({ node: candidate, kind: 'static_call', conf });
      }

      for (const acc of acceptedTargets) {
        const rt = runtimeEdgeStats.get(`${call.fromNodeId}|${acc.node.nodeId}`);
        addEdge({
          fromNodeId: call.fromNodeId,
          toNodeId: acc.node.nodeId,
          kind: acc.kind,
          callLine: call.line,
          confidence: rt ? Math.min(0.99, acc.conf + 0.06) : acc.conf,
          runtimeInvocations: rt?.invocations ?? 0,
          runtimeErrors: rt?.errors ?? 0,
        });
      }
    }

    // Add pure runtime-observed edges (e.g. dynamic dispatch / reflection with zero static call syntax)
    for (const [key, stats] of runtimeEdgeStats.entries()) {
      const [fromNodeId, toNodeId] = key.split('|');
      if (!nodesById.has(fromNodeId) || !nodesById.has(toNodeId)) continue;
      addEdge({
        fromNodeId,
        toNodeId,
        kind: 'runtime_trace',
        callLine: stats.line,
        confidence: 0.97,
        runtimeInvocations: stats.invocations,
        runtimeErrors: stats.errors,
      });
    }

    const outgoingEdges = new Map<string, GraphDirectedEdge[]>();
    const incomingEdges = new Map<string, GraphDirectedEdge[]>();
    for (const edge of edgeDedup.values()) {
      const out = outgoingEdges.get(edge.fromNodeId) ?? [];
      out.push(edge);
      outgoingEdges.set(edge.fromNodeId, out);

      const inc = incomingEdges.get(edge.toNodeId) ?? [];
      inc.push(edge);
      incomingEdges.set(edge.toNodeId, inc);
    }

    // Compute Git co-change coupling matrix: P(fileB | fileA) across authorized commit history
    const fileCommitCounts = new Map<string, number>();
    const pairCommitCounts = new Map<string, number>();
    for (const c of commits) {
      const uniqueFiles = [...new Set(c.touchedFiles.map((tf) => tf.filePath))];
      for (const f of uniqueFiles) {
        fileCommitCounts.set(f, (fileCommitCounts.get(f) ?? 0) + 1);
      }
      for (let i = 0; i < uniqueFiles.length; i++) {
        for (let j = 0; j < uniqueFiles.length; j++) {
          if (i === j) continue;
          const pk = `${uniqueFiles[i]}|${uniqueFiles[j]}`;
          pairCommitCounts.set(pk, (pairCommitCounts.get(pk) ?? 0) + 1);
        }
      }
    }

    const coChangeCoupling = new Map<string, CoChangeCouplingHit[]>();
    for (const [pk, coCount] of pairCommitCounts.entries()) {
      const [src, dst] = pk.split('|');
      const baseCount = fileCommitCounts.get(src) ?? 1;
      const prob = Number((coCount / baseCount).toFixed(3));
      if (coCount >= 2 || prob >= 0.5) {
        const arr = coChangeCoupling.get(src) ?? [];
        arr.push({
          sourceFile: src,
          coupledFile: dst,
          coChangeCommits: coCount,
          couplingProbability: prob,
        });
        coChangeCoupling.set(src, arr);
      }
    }

    return {
      graph: {
        nodesById,
        nodesBySymbol,
        outgoingEdges,
        incomingEdges,
        implementationsByBase: implMap,
        coChangeCoupling,
        falseStaticEdgesPruned,
      },
      blobs,
      traces,
      failures,
      commits,
    };
  }

  private resolveNodeInFile(
    nodesById: ReadonlyMap<string, GraphSymbolNode>,
    filePath: string,
    symbolName: string,
    ownerType?: string
  ): string | undefined {
    if (ownerType) {
      const qualified = `${filePath}::${ownerType}.${symbolName}`;
      if (nodesById.has(qualified)) return qualified;
    }
    const direct = `${filePath}::${symbolName}`;
    if (nodesById.has(direct)) return direct;
    for (const n of nodesById.values()) {
      if (n.filePath === filePath && n.symbolName === symbolName) {
        return n.nodeId;
      }
    }
    return undefined;
  }

  private matchQueryTargetNodes(
    graph: ScopedDerivedGraph,
    symbolOrNode: string,
    ownerType?: string,
    filePath?: string
  ): GraphSymbolNode[] {
    const normFile = filePath ? normalizeGraphPath(filePath) : undefined;
    if (graph.nodesById.has(symbolOrNode)) {
      return [graph.nodesById.get(symbolOrNode)!];
    }
    // Support `OwnerType.methodName` shorthand
    let sym = symbolOrNode;
    let owner = ownerType;
    if (!owner && symbolOrNode.includes('.') && !symbolOrNode.includes('/')) {
      const [o, m] = symbolOrNode.split('.');
      owner = o;
      sym = m;
    }

    const candidates = [...(graph.nodesBySymbol.get(sym) ?? [])];
    return candidates.filter((n) => {
      if (owner && n.ownerType !== owner) return false;
      if (normFile && n.filePath !== normFile) return false;
      return true;
    });
  }

  // ── 1. find_callers ───────────────────────────────────────────────────

  public findCallers(
    params: {
      readonly symbol: string;
      readonly ownerType?: string;
      readonly filePath?: string;
      readonly maxDepth?: number;
      readonly includeTests?: boolean;
    },
    access: GraphAccessPolicy
  ): { readonly callers: readonly CallerHit[]; readonly falsePathsPruned: number } {
    const { graph } = this.buildAuthorizedGraph(access);
    const maxDepth = Math.max(1, Math.min(8, params.maxDepth ?? 3));
    const includeTests = params.includeTests ?? true;
    const seeds = this.matchQueryTargetNodes(graph, params.symbol, params.ownerType, params.filePath);

    // Also include interface/base method nodes that implement/dispatch to any seed concrete method
    const startIds = new Set<string>(seeds.map((s) => s.nodeId));
    for (const s of seeds) {
      for (const inc of graph.incomingEdges.get(s.nodeId) ?? []) {
        if (inc.kind === 'implements') {
          startIds.add(inc.fromNodeId);
        }
      }
    }

    const bestByNode = new Map<string, CallerHit>();
    const queue: { nodeId: string; depth: number; conf: number }[] = [...startIds].map((id) => ({
      nodeId: id,
      depth: 0,
      conf: 1.0,
    }));
    const visitedDepth = new Map<string, number>();
    for (const id of startIds) visitedDepth.set(id, 0);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth >= maxDepth) continue;

      const incoming = graph.incomingEdges.get(cur.nodeId) ?? [];
      for (const edge of incoming) {
        if (edge.kind === 'implements') continue;
        const callerNode = graph.nodesById.get(edge.fromNodeId);
        if (!callerNode) continue;
        if (!includeTests && callerNode.isTestFile) continue;

        const nextDepth = cur.depth + 1;
        if (nextDepth > maxDepth) continue;
        const nextConf = Number((cur.conf * edge.confidence).toFixed(3));

        if (!startIds.has(callerNode.nodeId)) {
          const prevHit = bestByNode.get(callerNode.nodeId);
          const mergedProv = prevHit
            ? [...new Set([...prevHit.provenance, edge.kind])]
            : [edge.kind];
          if (!prevHit || nextDepth < prevHit.hopDistance || nextConf > prevHit.confidence) {
            bestByNode.set(callerNode.nodeId, {
              nodeId: callerNode.nodeId,
              callerSymbol: callerNode.symbolName,
              callerOwnerType: callerNode.ownerType,
              filePath: callerNode.filePath,
              packageName: callerNode.packageName,
              line: edge.callLine,
              hopDistance: Math.max(1, nextDepth),
              provenance: mergedProv,
              runtimeInvocations: Math.max(prevHit?.runtimeInvocations ?? 0, edge.runtimeInvocations),
              confidence: nextConf,
            });
          }
        }

        const seenD = visitedDepth.get(callerNode.nodeId);
        if (seenD === undefined || nextDepth < seenD) {
          visitedDepth.set(callerNode.nodeId, nextDepth);
          queue.push({ nodeId: callerNode.nodeId, depth: nextDepth, conf: nextConf });
        }
      }
    }

    const callers = [...bestByNode.values()].sort(
      (a, b) =>
        a.hopDistance - b.hopDistance ||
        b.runtimeInvocations - a.runtimeInvocations ||
        b.confidence - a.confidence
    );

    return {
      callers,
      falsePathsPruned: graph.falseStaticEdgesPruned,
    };
  }

  // ── 2. find_implementations ───────────────────────────────────────────

  public findImplementations(
    params: {
      readonly interfaceOrSymbol: string;
      readonly methodName?: string;
    },
    access: GraphAccessPolicy
  ): readonly ImplementationHit[] {
    const { graph, traces } = this.buildAuthorizedGraph(access);
    let ifaceName = params.interfaceOrSymbol;
    let methodName = params.methodName;
    if (!methodName && ifaceName.includes('.')) {
      const parts = ifaceName.split('.');
      ifaceName = parts[0];
      methodName = parts[1];
    }

    const baseHits = [...(graph.implementationsByBase.get(ifaceName) ?? [])];
    const results: ImplementationHit[] = [];

    for (const h of baseHits) {
      if (methodName) {
        const concreteMethod = (graph.nodesBySymbol.get(methodName) ?? []).find(
          (n) => n.ownerType === h.concreteType
        );
        if (!concreteMethod) continue;
        results.push({
          ...h,
          methodName,
          filePath: concreteMethod.filePath,
          line: concreteMethod.startLine,
        });
      } else {
        results.push(h);
      }
    }

    // Augment with runtime polymorphic dispatch observations if not statically declared
    if (methodName) {
      for (const tr of traces) {
        if (tr.calleeSymbol === methodName && tr.calleeOwnerType && tr.calleeOwnerType !== ifaceName) {
          const already = results.some((r) => r.concreteType === tr.calleeOwnerType);
          if (!already) {
            results.push({
              interfaceOrBase: ifaceName,
              concreteType: tr.calleeOwnerType,
              methodName,
              filePath: tr.calleeFile,
              packageName: detectPackage(tr.calleeFile),
              line: tr.calleeLine,
              mechanism: 'runtime_polymorphic',
              runtimeInvocations: tr.invocations,
              confidence: 0.93,
            });
          }
        }
      }
    }

    return results.sort(
      (a, b) => b.runtimeInvocations - a.runtimeInvocations || b.confidence - a.confidence
    );
  }

  // ── 3. trace_dependency ───────────────────────────────────────────────

  public traceDependency(
    params: {
      readonly from: string;
      readonly to: string;
      readonly maxDepth?: number;
      readonly maxPaths?: number;
    },
    access: GraphAccessPolicy
  ): DependencyTraceResult {
    const { graph } = this.buildAuthorizedGraph(access);
    const maxDepth = Math.max(1, Math.min(8, params.maxDepth ?? 5));
    const maxPaths = Math.max(1, Math.min(10, params.maxPaths ?? 3));

    const resolveEndpoint = (spec: string): GraphSymbolNode[] => {
      const bySym = this.matchQueryTargetNodes(graph, spec);
      if (bySym.length > 0) return bySym;
      const norm = normalizeGraphPath(spec);
      return [...graph.nodesById.values()].filter((n) => n.filePath === norm);
    };

    const startNodes = resolveEndpoint(params.from);
    const targetIds = new Set(resolveEndpoint(params.to).map((n) => n.nodeId));
    if (startNodes.length === 0 || targetIds.size === 0) {
      return {
        reachable: false,
        shortestHopCount: null,
        paths: [],
        falsePathsPruned: graph.falseStaticEdgesPruned,
      };
    }

    const foundPaths: { hops: DependencyPathHop[]; pathConfidence: number }[] = [];
    const bfsQueue: {
      currentId: string;
      visited: Set<string>;
      hops: DependencyPathHop[];
      conf: number;
    }[] = startNodes.map((s) => ({
      currentId: s.nodeId,
      visited: new Set([s.nodeId]),
      hops: [],
      conf: 1.0,
    }));

    while (bfsQueue.length > 0 && foundPaths.length < maxPaths) {
      const state = bfsQueue.shift()!;
      if (targetIds.has(state.currentId) && state.hops.length > 0) {
        foundPaths.push({
          hops: state.hops,
          pathConfidence: Number(state.conf.toFixed(3)),
        });
        continue;
      }
      if (state.hops.length >= maxDepth) continue;

      for (const edge of graph.outgoingEdges.get(state.currentId) ?? []) {
        if (state.visited.has(edge.toNodeId)) continue;
        const fromNode = graph.nodesById.get(edge.fromNodeId);
        const nextVisited = new Set(state.visited);
        nextVisited.add(edge.toNodeId);
        bfsQueue.push({
          currentId: edge.toNodeId,
          visited: nextVisited,
          hops: [
            ...state.hops,
            {
              fromNodeId: edge.fromNodeId,
              toNodeId: edge.toNodeId,
              edgeKind: edge.kind,
              filePath: fromNode?.filePath ?? '',
              line: edge.callLine,
              confidence: edge.confidence,
            },
          ],
          conf: state.conf * edge.confidence,
        });
      }
    }

    foundPaths.sort((a, b) => a.hops.length - b.hops.length || b.pathConfidence - a.pathConfidence);
    return {
      reachable: foundPaths.length > 0,
      shortestHopCount: foundPaths.length > 0 ? foundPaths[0].hops.length : null,
      paths: foundPaths,
      falsePathsPruned: graph.falseStaticEdgesPruned,
    };
  }

  // ── 4. find_related_tests ─────────────────────────────────────────────

  public findRelatedTests(
    params: {
      readonly symbols?: readonly string[];
      readonly files?: readonly string[];
      readonly maxTests?: number;
    },
    access: GraphAccessPolicy
  ): readonly RelatedTestHit[] {
    const { graph, traces, failures } = this.buildAuthorizedGraph(access);
    const maxTests = Math.max(1, params.maxTests ?? 10);

    const seedSymbols = new Set<string>(params.symbols ?? []);
    const seedFiles = new Set<string>((params.files ?? []).map(normalizeGraphPath));

    for (const n of graph.nodesById.values()) {
      if (seedFiles.has(n.filePath) && n.symbolName !== '<module>') {
        seedSymbols.add(
          n.ownerType ? `${n.ownerType}.${n.symbolName}` : n.symbolName
        );
      }
    }

    const testScores = new Map<
      string,
      {
        score: number;
        reasons: Set<string>;
        minHop: number | null;
        runtimeInvocations: number;
        recentFailures: number;
      }
    >();

    const ensureTest = (testFile: string) => {
      let rec = testScores.get(testFile);
      if (!rec) {
        rec = {
          score: 0,
          reasons: new Set<string>(),
          minHop: null,
          runtimeInvocations: 0,
          recentFailures: 0,
        };
        testScores.set(testFile, rec);
      }
      return rec;
    };

    // 1. Static + interface caller reachability from tests
    for (const sym of seedSymbols) {
      const callerRes = this.findCallers({ symbol: sym, maxDepth: 4, includeTests: true }, access);
      for (const hit of callerRes.callers) {
        const node = graph.nodesById.get(hit.nodeId);
        if (!node?.isTestFile) continue;
        const rec = ensureTest(hit.filePath);
        const hopGain = 1.0 / hit.hopDistance;
        rec.score += hopGain * hit.confidence;
        rec.reasons.add(`Static/graph caller of '${sym}' at hop=${hit.hopDistance}`);
        rec.minHop = rec.minHop === null ? hit.hopDistance : Math.min(rec.minHop, hit.hopDistance);
      }
    }

    // 2. Runtime trace coverage from entryPoint test files
    for (const tr of traces) {
      if (!detectTestFile(tr.entryPoint)) continue;
      const qualified = tr.calleeOwnerType
        ? `${tr.calleeOwnerType}.${tr.calleeSymbol}`
        : tr.calleeSymbol;
      if (
        seedSymbols.has(tr.calleeSymbol) ||
        seedSymbols.has(qualified) ||
        seedFiles.has(tr.calleeFile)
      ) {
        const rec = ensureTest(tr.entryPoint);
        rec.score += 1.25 + Math.min(0.5, Math.log10(tr.invocations + 1) * 0.2);
        rec.runtimeInvocations += tr.invocations;
        rec.reasons.add(`Runtime trace '${tr.traceId}' observed ${tr.invocations} call(s)`);
      }
    }

    // 3. Recent failure stack-frame overlap
    for (const fail of failures) {
      const overlaps = fail.stackFrames.some(
        (sf) =>
          seedFiles.has(sf.filePath) ||
          seedSymbols.has(sf.symbolName)
      );
      if (overlaps) {
        const rec = ensureTest(fail.testFile);
        rec.score += 1.1;
        rec.recentFailures += 1;
        rec.reasons.add(`Recent failure '${fail.failureId}' stack traversed target`);
      }
    }

    // 4. Git co-change coupling to test files
    for (const f of seedFiles) {
      for (const cc of graph.coChangeCoupling.get(f) ?? []) {
        if (detectTestFile(cc.coupledFile)) {
          const rec = ensureTest(cc.coupledFile);
          rec.score += 0.6 * cc.couplingProbability;
          rec.reasons.add(
            `Git co-changed with '${f}' in ${cc.coChangeCommits} commit(s) (p=${cc.couplingProbability})`
          );
        }
      }
    }

    return [...testScores.entries()]
      .map(([testFile, v]) => ({
        testFile,
        score: Number(v.score.toFixed(3)),
        reasons: [...v.reasons],
        minHopDistance: v.minHop,
        runtimeInvocations: v.runtimeInvocations,
        recentFailures: v.recentFailures,
      }))
      .sort((a, b) => b.score - a.score || a.testFile.localeCompare(b.testFile))
      .slice(0, maxTests);
  }

  // ── 5. explain_change_impact ──────────────────────────────────────────

  public explainChangeImpact(
    params: {
      readonly symbols?: readonly string[];
      readonly files?: readonly string[];
      readonly maxDepth?: number;
    },
    access: GraphAccessPolicy
  ): ChangeImpactReport {
    const { graph, traces, failures } = this.buildAuthorizedGraph(access);
    const maxDepth = Math.max(1, Math.min(6, params.maxDepth ?? 3));

    const targetFiles = new Set<string>((params.files ?? []).map(normalizeGraphPath));
    const targetSymbols = new Set<string>(params.symbols ?? []);

    for (const n of graph.nodesById.values()) {
      if (targetFiles.has(n.filePath) && n.symbolName !== '<module>' && !n.isTestFile) {
        targetSymbols.add(n.ownerType ? `${n.ownerType}.${n.symbolName}` : n.symbolName);
      }
    }

    const impactedMap = new Map<
      string,
      {
        nodeId: string;
        symbolName: string;
        ownerType?: string;
        filePath: string;
        packageName: string;
        line: number;
        hopDistance: number;
        score: number;
        reasons: Set<string>;
      }
    >();

    const affectedImpls: ImplementationHit[] = [];
    const seenImplKey = new Set<string>();

    for (const sym of targetSymbols) {
      const { callers } = this.findCallers(
        { symbol: sym, maxDepth, includeTests: false },
        access
      );
      for (const c of callers) {
        const prev = impactedMap.get(c.nodeId);
        const runtimeBoost = c.runtimeInvocations > 0 ? Math.min(0.6, Math.log10(c.runtimeInvocations + 1) * 0.25) : 0;
        const baseScore = (1.0 / c.hopDistance) * c.confidence + runtimeBoost;
        const reasons = prev?.reasons ?? new Set<string>();
        reasons.add(
          `Calls '${sym}' (${c.provenance.join('+')}, hop=${c.hopDistance}` +
            (c.runtimeInvocations > 0 ? `, runtime_calls=${c.runtimeInvocations}` : '') +
            ')'
        );
        if (!prev || baseScore > prev.score) {
          impactedMap.set(c.nodeId, {
            nodeId: c.nodeId,
            symbolName: c.callerSymbol,
            ownerType: c.callerOwnerType,
            filePath: c.filePath,
            packageName: c.packageName,
            line: c.line,
            hopDistance: prev ? Math.min(prev.hopDistance, c.hopDistance) : c.hopDistance,
            score: (prev?.score ?? 0) + baseScore,
            reasons,
          });
        }
      }

      // Check interface / base-class implementation impact if `sym` is an interface or `Interface.method`
      const impls = this.findImplementations({ interfaceOrSymbol: sym }, access);
      for (const imp of impls) {
        const ik = `${imp.concreteType}:${imp.methodName ?? '*'}:${imp.filePath}`;
        if (!seenImplKey.has(ik)) {
          seenImplKey.add(ik);
          affectedImpls.push(imp);
        }
        const nodeId = imp.methodName
          ? `${imp.filePath}::${imp.concreteType}.${imp.methodName}`
          : `${imp.filePath}::${imp.concreteType}`;
        if (!impactedMap.has(nodeId)) {
          impactedMap.set(nodeId, {
            nodeId,
            symbolName: imp.methodName ?? imp.concreteType,
            ownerType: imp.methodName ? imp.concreteType : undefined,
            filePath: imp.filePath,
            packageName: imp.packageName,
            line: imp.line,
            hopDistance: 1,
            score: 0.95 + (imp.runtimeInvocations > 0 ? 0.3 : 0),
            reasons: new Set([`Implements '${imp.interfaceOrBase}' via ${imp.mechanism}`]),
          });
        }
      }

      // Also include seed files for co-change lookup
      for (const seedNode of this.matchQueryTargetNodes(graph, sym)) {
        targetFiles.add(seedNode.filePath);
      }
    }

    // Boost impacted symbols appearing in recent failure stacks or high-latency/error runtime traces
    for (const fail of failures) {
      for (const sf of fail.stackFrames) {
        for (const entry of impactedMap.values()) {
          if (entry.filePath === sf.filePath && entry.symbolName === sf.symbolName) {
            entry.score += 0.45;
            entry.reasons.add(`Appeared in recent failure '${fail.failureId}'`);
          }
        }
      }
    }

    let maxRuntimeErrors = 0;
    let totalRuntimeTraffic = 0;
    for (const tr of traces) {
      const qual = tr.calleeOwnerType ? `${tr.calleeOwnerType}.${tr.calleeSymbol}` : tr.calleeSymbol;
      if (targetSymbols.has(tr.calleeSymbol) || targetSymbols.has(qual) || targetFiles.has(tr.calleeFile)) {
        totalRuntimeTraffic += tr.invocations;
        maxRuntimeErrors = Math.max(maxRuntimeErrors, tr.errorCount);
      }
    }

    const coChangeList: CoChangeCouplingHit[] = [];
    for (const tf of targetFiles) {
      for (const cc of graph.coChangeCoupling.get(tf) ?? []) {
        if (!targetFiles.has(cc.coupledFile) && !detectTestFile(cc.coupledFile)) {
          coChangeList.push(cc);
        }
      }
    }
    coChangeList.sort((a, b) => b.couplingProbability - a.couplingProbability || b.coChangeCommits - a.coChangeCommits);

    const impactedSymbols: ImpactedSymbolEntry[] = [...impactedMap.values()]
      .map((e) => ({
        nodeId: e.nodeId,
        symbolName: e.symbolName,
        ownerType: e.ownerType,
        filePath: e.filePath,
        packageName: e.packageName,
        line: e.line,
        hopDistance: e.hopDistance,
        impactScore: Number(e.score.toFixed(3)),
        reasons: [...e.reasons],
      }))
      .sort((a, b) => b.impactScore - a.impactScore || a.hopDistance - b.hopDistance);

    const relatedTests = this.findRelatedTests(
      { symbols: [...targetSymbols], files: [...targetFiles] },
      access
    );

    let overallRisk: ChangeImpactReport['overallRisk'] = 'low';
    if (
      impactedSymbols.length >= 4 ||
      (affectedImpls.length >= 2 && totalRuntimeTraffic >= 100) ||
      maxRuntimeErrors > 0
    ) {
      overallRisk = 'critical';
    } else if (impactedSymbols.length >= 2 || affectedImpls.length >= 1 || coChangeList.length >= 1) {
      overallRisk = 'high';
    } else if (impactedSymbols.length === 1 || relatedTests.length > 0) {
      overallRisk = 'medium';
    }

    const summary =
      `Risk=${overallRisk.toUpperCase()}: ${impactedSymbols.length} non-test symbol(s) impacted, ` +
      `${affectedImpls.length} interface implementation(s), ${coChangeList.length} Git co-changed file(s), ` +
      `${relatedTests.length} related test suite(s) (${graph.falseStaticEdgesPruned} false static path(s) pruned).`;

    return {
      overallRisk,
      impactedSymbols,
      affectedImplementations: affectedImpls,
      coChangeCoupledFiles: coChangeList,
      relatedTests,
      falsePathsPruned: graph.falseStaticEdgesPruned,
      summary,
    };
  }

  // ── 6. find_regression_origin ─────────────────────────────────────────

  public findRegressionOrigin(
    params: {
      readonly failureId?: string;
      readonly failingTestFile?: string;
      readonly stackFrames?: readonly StackFrameRef[];
      readonly maxCandidates?: number;
    },
    access: GraphAccessPolicy
  ): readonly RegressionOriginCandidate[] {
    const { graph, traces, failures, commits } = this.buildAuthorizedGraph(access);
    const maxCandidates = Math.max(1, params.maxCandidates ?? 5);

    let frames: readonly StackFrameRef[] = params.stackFrames ?? [];
    let testFile = params.failingTestFile ? normalizeGraphPath(params.failingTestFile) : undefined;

    if (params.failureId) {
      const failRec = failures.find((f) => f.failureId === params.failureId);
      if (failRec) {
        frames = failRec.stackFrames;
        testFile = failRec.testFile;
      }
    }

    // Build forward dependency reachability slice from stack frames + failing test
    // (In a regression, the failing test/frame calls INTO the defective downstream callee!)
    const sliceDistance = new Map<string, number>(); // nodeId -> distance from failure site
    const bfs: { nodeId: string; dist: number }[] = [];

    for (let idx = 0; idx < frames.length; idx++) {
      const sf = frames[idx];
      const matches = [...graph.nodesById.values()].filter(
        (n) => n.filePath === normalizeGraphPath(sf.filePath) && n.symbolName === sf.symbolName
      );
      for (const m of matches) {
        // Top of stack (idx === 0) gets distance 0; deeper frames get slight offset
        const d = idx * 0.4;
        if (!sliceDistance.has(m.nodeId) || d < sliceDistance.get(m.nodeId)!) {
          sliceDistance.set(m.nodeId, d);
          bfs.push({ nodeId: m.nodeId, dist: d });
        }
      }
    }

    if (testFile) {
      for (const n of graph.nodesById.values()) {
        if (n.filePath === testFile) {
          sliceDistance.set(n.nodeId, 1.0);
          bfs.push({ nodeId: n.nodeId, dist: 1.0 });
        }
      }
    }

    while (bfs.length > 0) {
      const cur = bfs.shift()!;
      if (cur.dist >= 4) continue;
      for (const edge of graph.outgoingEdges.get(cur.nodeId) ?? []) {
        const step = edge.kind === 'runtime_trace' || edge.runtimeInvocations > 0 ? 0.65 : 1.0;
        const nextDist = cur.dist + step;
        const prev = sliceDistance.get(edge.toNodeId);
        if (prev === undefined || nextDist < prev) {
          sliceDistance.set(edge.toNodeId, nextDist);
          bfs.push({ nodeId: edge.toNodeId, dist: nextDist });
        }
      }
    }

    // Score (commit, node/file) pairs by combining:
    //  1) Backward-slice reachability from failure frames (`sliceScore`)
    //  2) Commit hunk overlap with symbol line spans (`symbolOverlapScore`)
    //  3) Runtime trace error count on that symbol (`runtimeErrorScore`)
    //  4) Commit recency rank (`recencyScore`)
    const sortedCommits = [...commits].sort((a, b) => b.timestampEpochSec - a.timestampEpochSec);
    const maxTs = sortedCommits[0]?.timestampEpochSec ?? 1;
    const minTs = sortedCommits[sortedCommits.length - 1]?.timestampEpochSec ?? 0;
    const tsSpan = Math.max(1, maxTs - minTs);

    const rawCandidates: Omit<RegressionOriginCandidate, 'rank'>[] = [];

    for (const commit of sortedCommits) {
      const recency = (commit.timestampEpochSec - minTs) / tsSpan; // [0..1]

      for (const tf of commit.touchedFiles) {
        if (detectTestFile(tf.filePath)) continue;
        const fileNodes = [...graph.nodesById.values()].filter(
          (n) => n.filePath === tf.filePath && n.symbolName !== '<module>'
        );

        for (const node of fileNodes) {
          const hasExplicitEmptySyms =
            tf.touchedSymbols !== undefined && tf.touchedSymbols.length === 0;
          const symHit = (tf.touchedSymbols ?? []).includes(node.symbolName);
          const lineHit =
            !hasExplicitEmptySyms &&
            (tf.changedLines ?? []).some((ln) => ln >= node.startLine && ln <= node.endLine);
          if (!lineHit && !symHit && !hasExplicitEmptySyms && tf.changedLines?.length) {
            continue;
          }

          const dist = sliceDistance.get(node.nodeId);
          // Candidate must either be in the dependency/failure slice or directly named in frames
          const inFrames = frames.some(
            (sf) => normalizeGraphPath(sf.filePath) === node.filePath && sf.symbolName === node.symbolName
          );
          if (dist === undefined && !inFrames) continue;

          const evidence: string[] = [];
          let score = 0;

          if (inFrames) {
            score += 1.1;
            evidence.push('Present in failure stack trace');
          }
          if (dist !== undefined) {
            const reachScore = 2.0 / (1 + dist * 0.5);
            score += reachScore;
            evidence.push(`Reachable in failure dependency slice (distance=${dist.toFixed(2)})`);
          }
          if (symHit || lineHit) {
            score += 1.6;
            evidence.push(`Symbol '${node.symbolName}' modified in commit '${commit.commitSha}' by ${commit.author}`);
          } else if (hasExplicitEmptySyms) {
            score += 0.15;
            evidence.push(`File touched without symbol body mutation in '${commit.commitSha}'`);
          }

          // Runtime trace error signal on this callee
          const traceErrors = traces
            .filter(
              (tr) =>
                tr.calleeFile === node.filePath &&
                tr.calleeSymbol === node.symbolName &&
                tr.errorCount > 0
            )
            .reduce((acc, tr) => acc + tr.errorCount, 0);
          if (traceErrors > 0) {
            score += 2.4;
            evidence.push(`Runtime traces recorded ${traceErrors} error(s) originating in '${node.symbolName}'`);
          }

          score += 0.95 * recency;
          evidence.push(`Commit recency weight=${recency.toFixed(2)}`);

          rawCandidates.push({
            commitSha: commit.commitSha,
            author: commit.author,
            commitMessage: commit.message,
            filePath: node.filePath,
            symbolName: node.ownerType ? `${node.ownerType}.${node.symbolName}` : node.symbolName,
            line: tf.changedLines?.[0] ?? node.startLine,
            suspiciousnessScore: Number(score.toFixed(3)),
            evidence,
          });
        }
      }
    }

    rawCandidates.sort((a, b) => b.suspiciousnessScore - a.suspiciousnessScore);
    return rawCandidates.slice(0, maxCandidates).map((c, idx) => ({
      rank: idx + 1,
      ...c,
    }));
  }
}
