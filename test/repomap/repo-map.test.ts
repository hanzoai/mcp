/**
 * Dynamic Repository Map Ranked by Symbol Graph Test Suite
 * (HIP-1347 / hanzoai/mcp#36).
 */

import { describe, test, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DerivedSymbolCache,
  NormalizedSourceBlob,
  SourceBlobRecord,
  SymbolExtractorAdapter,
  authorizeSourceBlobs,
  buildSymbolGraph,
  computeBlobSha,
  defaultStructuralExtractor,
  estimateRepoMapTokens,
  evaluateRepoMapBenchmark,
  extractDiagnosticSpans,
  extractGitDiffChanges,
  generateRepoMap,
  generateWorkspaceRepoMap,
  rankSymbolGraph,
  renderRepoMap,
} from '../../src/repomap/index.js';

describe('RepoMap Symbol Graph & Personalized PageRank (HIP-1347 / #36)', () => {
  test('extracts definitions, imports, and references across TS, Rust, Python, and Go while ignoring comments and strings', () => {
    const tsBlob: NormalizedSourceBlob = {
      filePath: 'packages/core/src/service.ts',
      language: 'typescript',
      blobSha: computeBlobSha('ts'),
      commitRevision: 'rev-1',
      allowedRoles: [],
      aclTags: [],
      content: [
        '// import { fakeFromComment } from "./commented.js";',
        '/* export function fakeBlockCommentFn() {} */',
        'import { settleInvoice as runSettle } from "./ledger.js";',
        'const fakeLiteral = "export function notARealFunction() { ghostCall(); }";',
        'export interface InvoicePayload {',
        '  invoiceId: string;',
        '}',
        'export class BillingController {',
        '  async processInvoice(payload: InvoicePayload): Promise<boolean> {',
        '    void fakeLiteral;',
        '    return runSettle(payload.invoiceId);',
        '  }',
        '}',
      ].join('\n'),
    };

    const tsExtracted = defaultStructuralExtractor.extract(tsBlob);
    const tsDefNames = tsExtracted.definitions.map((d) => d.name);
    expect(tsDefNames).toEqual(['InvoicePayload', 'BillingController', 'processInvoice']);
    expect(tsDefNames).not.toContain('fakeBlockCommentFn');
    expect(tsDefNames).not.toContain('notARealFunction');
    expect(tsExtracted.imports).toHaveLength(1);
    expect(tsExtracted.imports[0].moduleSpecifier).toBe('./ledger.js');
    expect(tsExtracted.imports[0].aliasMap?.runSettle).toBe('settleInvoice');
    expect(tsExtracted.references.some((r) => r.name === 'ghostCall')).toBe(false);
    expect(
      tsExtracted.references.some(
        (r) => r.name === 'runSettle' && r.isCall && r.enclosingSymbol === 'processInvoice'
      )
    ).toBe(true);

    const rustBlob: NormalizedSourceBlob = {
      filePath: 'crates/vault/src/lib.rs',
      language: 'rust',
      blobSha: computeBlobSha('rs'),
      commitRevision: 'rev-1',
      allowedRoles: [],
      aclTags: [],
      content: [
        'use crate::crypto::{verify_ed25519, Digest32};',
        'pub struct VaultHeader {',
        '    pub epoch: u64,',
        '}',
        'impl VaultHeader {',
        '    pub fn check_seal(&self, sig: &[u8], digest: &Digest32) -> bool {',
        '        verify_ed25519(sig, digest)',
        '    }',
        '}',
      ].join('\n'),
    };
    const rustExtracted = defaultStructuralExtractor.extract(rustBlob);
    expect(rustExtracted.definitions.map((d) => `${d.kind}:${d.name}`)).toEqual([
      'struct:VaultHeader',
      'method:check_seal',
    ]);
    expect(rustExtracted.definitions[1].parentSymbol).toBe('VaultHeader');
    expect(rustExtracted.imports[0].importedSymbols).toEqual(['verify_ed25519', 'Digest32']);

    const pyBlob: NormalizedSourceBlob = {
      filePath: 'services/risk/scorer.py',
      language: 'python',
      blobSha: computeBlobSha('py'),
      commitRevision: 'rev-1',
      allowedRoles: [],
      aclTags: [],
      content: [
        '"""',
        'from .phantom import fake_docstring_import',
        'def fake_docstring_fn(): pass',
        '"""',
        'from .thresholds import load_limit_table',
        'class RiskEvaluator:',
        '    def score_transfer(self, amount: int) -> int:',
        '        table = load_limit_table()',
        '        return amount - table',
      ].join('\n'),
    };
    const pyExtracted = defaultStructuralExtractor.extract(pyBlob);
    expect(pyExtracted.imports).toHaveLength(1);
    expect(pyExtracted.imports[0].moduleSpecifier).toBe('.thresholds');
    expect(pyExtracted.definitions.map((d) => `${d.kind}:${d.name}`)).toEqual([
      'class:RiskEvaluator',
      'method:score_transfer',
    ]);

    const goBlob: NormalizedSourceBlob = {
      filePath: 'internal/consensus/proposer.go',
      language: 'go',
      blobSha: computeBlobSha('go'),
      commitRevision: 'rev-1',
      allowedRoles: [],
      aclTags: [],
      content: [
        'package consensus',
        'import (',
        '    "github.com/hanzoai/chain/internal/quorum"',
        ')',
        'type BlockProposal struct {',
        '    Height uint64',
        '}',
        'func (p *BlockProposal) ValidateCommit(votes []string) bool {',
        '    return quorum.HasSupermajority(votes)',
        '}',
      ].join('\n'),
    };
    const goExtracted = defaultStructuralExtractor.extract(goBlob);
    expect(goExtracted.imports[0].moduleSpecifier).toBe(
      'github.com/hanzoai/chain/internal/quorum'
    );
    expect(goExtracted.definitions.map((d) => `${d.kind}:${d.name}:${d.exported}`)).toEqual([
      'struct:BlockProposal:true',
      'method:ValidateCommit:true',
    ]);
  });

  test('supports pluggable custom AST / Tree-sitter SymbolExtractorAdapter and rebuildable DerivedSymbolCache', () => {
    let customExtractCalls = 0;
    const customTreeSitterAdapter: SymbolExtractorAdapter = {
      name: 'mock-tree-sitter-ts',
      supports: (lang) => lang === 'typescript',
      extract: (blob) => {
        customExtractCalls++;
        return {
          filePath: blob.filePath,
          language: blob.language,
          blobSha: blob.blobSha,
          commitRevision: blob.commitRevision,
          definitions: [
            {
              id: `${blob.filePath}#function:customAstSymbol:1`,
              name: 'customAstSymbol',
              kind: 'function',
              filePath: blob.filePath,
              line: 1,
              endLine: 3,
              exported: true,
              signature: 'export function customAstSymbol(): void',
              blobSha: blob.blobSha,
              commitRevision: blob.commitRevision,
            },
          ],
          imports: [],
          references: [],
        };
      },
    };

    const cache = new DerivedSymbolCache();
    const initialRecords: SourceBlobRecord[] = [
      {
        filePath: 'src/alpha.ts',
        content: 'export function ignoredByCustomAdapter() {}',
        commitRevision: 'c1',
      },
      {
        filePath: 'src/helper.py',
        content: 'def fallback_python_symbol():\n    return 1\n',
        commitRevision: 'c1',
      },
    ];

    const firstGraph = buildSymbolGraph(initialRecords, {
      adapters: [customTreeSitterAdapter],
      cache,
    });
    expect(customExtractCalls).toBe(1);
    expect(firstGraph.files.get('src/alpha.ts')?.definitions[0].name).toBe('customAstSymbol');
    expect(firstGraph.files.get('src/helper.py')?.definitions[0].name).toBe(
      'fallback_python_symbol'
    );

    // Second build with identical blobSha hits derived cache without re-parsing.
    buildSymbolGraph(initialRecords, { adapters: [customTreeSitterAdapter], cache });
    expect(customExtractCalls).toBe(1);
    expect(cache.stats().hits).toBe(2);

    // Wiping derived cache and rebuilding reproduces identical derived definitions from immutable source identities.
    cache.clear();
    const rebuiltGraph = buildSymbolGraph(initialRecords, {
      adapters: [customTreeSitterAdapter],
      cache,
    });
    expect(customExtractCalls).toBe(2);
    expect(rebuiltGraph.files.get('src/alpha.ts')?.definitions).toEqual(
      firstGraph.files.get('src/alpha.ts')?.definitions
    );
  });

  test('enforces strict tenant, RBAC role, ACL tag, and path-traversal isolation BEFORE graph ranking and hit return', () => {
    const records: SourceBlobRecord[] = [
      {
        filePath: 'packages/api/src/handler.ts',
        tenantId: 'tenant-alpha',
        allowedRoles: ['developer', 'admin'],
        aclTags: ['repo:read'],
        content: [
          'import { computeSharedSettlement } from "../../core/src/settle.js";',
          'export function handleAlphaRequest(v: number): number {',
          '  return computeSharedSettlement(v) + ultraSecretBetaOracle(v);',
          '}',
        ].join('\n'),
      },
      {
        filePath: 'packages/core/src/settle.ts',
        tenantId: 'tenant-alpha',
        allowedRoles: ['developer'],
        aclTags: ['repo:read'],
        content: 'export function computeSharedSettlement(v: number): number { return v * 2; }',
      },
      // Cross-tenant blob declaring `ultraSecretBetaOracle` referenced by name above AND matching taskQuery!
      {
        filePath: 'packages/oracle/src/secret-beta.ts',
        tenantId: 'tenant-beta',
        allowedRoles: ['developer'],
        aclTags: ['repo:read'],
        content: 'export function ultraSecretBetaOracle(v: number): number { return v * 999; }',
      },
      // Unlabeled blob without tenantId (must fail closed when requireTenantMatch is true).
      {
        filePath: 'packages/unlabeled/src/leak.ts',
        content: 'export function unlabeledHelper(): number { return 0; }',
      },
      // Same tenant, but requires `security-auditor` role not held by caller.
      {
        filePath: 'packages/audit/src/internal-keys.ts',
        tenantId: 'tenant-alpha',
        allowedRoles: ['security-auditor'],
        aclTags: ['repo:read'],
        content: 'export function rotateHsmMasterKey(): void {}',
      },
      // Same tenant and role, but requires extra `pii:clearance` ACL tag.
      {
        filePath: 'packages/compliance/src/pii-vault.ts',
        tenantId: 'tenant-alpha',
        allowedRoles: ['developer'],
        aclTags: ['repo:read', 'pii:clearance'],
        content: 'export function exportRawTaxIdentifiers(): string[] { return []; }',
      },
      // Denied path prefix and path traversal attempt.
      {
        filePath: 'secrets/production-kms.ts',
        tenantId: 'tenant-alpha',
        allowedRoles: ['developer'],
        aclTags: ['repo:read'],
        content: 'export const KMS_SEED = "secret";',
      },
      {
        filePath: '../../etc/passwd.ts',
        tenantId: 'tenant-alpha',
        content: 'export const ROOT = true;',
      },
    ];

    const policy = {
      tenantId: 'tenant-alpha',
      principalRoles: ['developer'],
      principalAclTags: ['repo:read'],
      deniedPathPrefixes: ['secrets/'],
    };

    const result = generateRepoMap(
      records,
      {
        activeFiles: ['packages/api/src/handler.ts'],
        taskQuery: 'investigate ultraSecretBetaOracle rotateHsmMasterKey exportRawTaxIdentifiers',
        mentionedSymbols: ['ultraSecretBetaOracle', 'rotateHsmMasterKey'],
        accessControl: policy,
      },
      { maxTokens: 800 }
    );

    expect(result.metrics.totalSourceFiles).toBe(8);
    expect(result.metrics.authorizedFiles).toBe(2);
    expect(result.metrics.excludedByAccessControl).toBe(6);
    expect(result.graph.excludedByReason).toEqual({
      invalid_path: 1,
      denied_path: 1,
      tenant_mismatch: 1,
      missing_tenant: 1,
      role_denied: 1,
      acl_tag_denied: 1,
    });

    // Zero unauthorized files or cross-tenant symbols enter graph nodes, edges, rankings, or text.
    expect(Array.from(result.graph.files.keys())).toEqual([
      'packages/api/src/handler.ts',
      'packages/core/src/settle.ts',
    ]);
    expect(result.graph.edges.every((e) => e.toSymbol !== 'ultraSecretBetaOracle')).toBe(true);
    expect(result.text).toContain('computeSharedSettlement');
    expect(result.text).not.toContain('ultraSecretBetaOracle');
    expect(result.text).not.toContain('secret-beta');
    expect(result.text).not.toContain('rotateHsmMasterKey');
    expect(result.text).not.toContain('exportRawTaxIdentifiers');
    expect(result.text).not.toContain('KMS_SEED');

    // Tenant-scoped blobs must also fail closed when caller omits policy.tenantId entirely.
    const unauthenticated = authorizeSourceBlobs(records.slice(0, 2), undefined);
    expect(unauthenticated.authorized).toHaveLength(0);
    expect(unauthenticated.excludedByReason.tenant_mismatch).toBe(2);
  });

  test('Personalized PageRank converges, is order-invariant, boosts error spans & git diffs, and damps ubiquitous hubs', () => {
    const blobs: SourceBlobRecord[] = [
      {
        filePath: 'packages/common/src/logger.ts',
        content: 'export function logEvent(msg: string): void { void msg; }',
      },
      {
        filePath: 'packages/pricing/src/rebate-math.ts',
        content: [
          'export function computeVolumeRebateCents(units: number, unitPrice: number): number {',
          '  return Math.floor(units * unitPrice * 0.05);',
          '}',
        ].join('\n'),
      },
      {
        filePath: 'packages/orders/src/invoice-builder.ts',
        content: [
          'import { computeVolumeRebateCents } from "../../pricing/src/rebate-math.js";',
          'import { logEvent } from "../../common/src/logger.js";',
          'export function buildFinalInvoice(units: number, unitPrice: number): number {',
          '  logEvent("building");',
          '  const rebate = computeVolumeRebateCents(units, unitPrice);',
          '  return units * unitPrice - rebate;',
          '}',
        ].join('\n'),
      },
      {
        filePath: 'packages/api/src/checkout-route.ts',
        content: [
          'import { buildFinalInvoice } from "../../orders/src/invoice-builder.js";',
          'import { logEvent } from "../../common/src/logger.js";',
          'export function postCheckoutOrder(units: number, price: number): number {',
          '  logEvent("checkout");',
          '  return buildFinalInvoice(units, price);',
          '}',
        ].join('\n'),
      },
    ];

    // Add 30 unrelated background callers of `logEvent` so `logger.ts` has huge raw in-degree.
    for (let i = 0; i < 30; i++) {
      const id = String(i + 1).padStart(2, '0');
      blobs.push({
        filePath: `packages/misc/src/worker-${id}.ts`,
        content: [
          'import { logEvent } from "../../common/src/logger.js";',
          `export function runBackgroundJob${id}(): void { logEvent("job-${id}"); }`,
        ].join('\n'),
      });
    }

    const graphA = buildSymbolGraph(blobs);
    const rankedA = rankSymbolGraph(graphA, {
      diagnosticText:
        'Error: negative invoice total\n    at buildFinalInvoice (packages/orders/src/invoice-builder.ts:5:18)',
      gitDiffText: [
        '--- a/packages/pricing/src/rebate-math.ts',
        '+++ b/packages/pricing/src/rebate-math.ts',
        '@@ -1,3 +1,3 @@',
      ].join('\n'),
    });

    expect(rankedA.converged).toBe(true);
    expect(rankedA.residual).toBeLessThan(1e-7);

    const scoreSum = rankedA.rankedFiles.reduce((acc, f) => acc + f.pageRankScore, 0);
    expect(Math.abs(scoreSum - 1.0)).toBeLessThan(1e-6);

    // Top 3 files must be the causal chain (invoice-builder, rebate-math, checkout-route),
    // beating the ubiquitous 32-caller logger hub AND all 30 background workers!
    const top3Paths = rankedA.rankedFiles.slice(0, 3).map((f) => f.filePath);
    expect(top3Paths).toContain('packages/orders/src/invoice-builder.ts');
    expect(top3Paths).toContain('packages/pricing/src/rebate-math.ts');
    expect(top3Paths).toContain('packages/api/src/checkout-route.ts');

    const rebateRank = rankedA.rankedFiles.findIndex(
      (f) => f.filePath === 'packages/pricing/src/rebate-math.ts'
    );
    const loggerRank = rankedA.rankedFiles.findIndex(
      (f) => f.filePath === 'packages/common/src/logger.ts'
    );
    expect(rebateRank).toBeLessThan(loggerRank);

    // Reversing input blob order produces byte-identical ranking and RepoMap output.
    const reversedBlobs = [...blobs].reverse();
    const mapForward = generateRepoMap(
      blobs,
      { activeFiles: ['packages/orders/src/invoice-builder.ts'] },
      { maxTokens: 320 }
    );
    const mapReverse = generateRepoMap(
      reversedBlobs,
      { activeFiles: ['packages/orders/src/invoice-builder.ts'] },
      { maxTokens: 320 }
    );
    expect(mapReverse.text).toBe(mapForward.text);
    expect(() => rankSymbolGraph(graphA, {}, { dampingFactor: 1.0 })).toThrow();
    expect(() => rankSymbolGraph(graphA, {}, { dampingFactor: 0 })).toThrow();
  });

  test('extractDiagnosticSpans and extractGitDiffChanges parse multi-language compiler & diff formats', () => {
    const diag = [
      'src/router/dispatch.ts(44,12): error TS2345: Argument not assignable',
      '  --> crates/core/src/merkle.rs:109:5',
      '  File "services/etl/loader.py", line 88, in transform_batch',
      'internal/raft/log.go:211:9: undefined: CommitEntry',
    ].join('\n');

    const spans = extractDiagnosticSpans(diag);
    expect(spans.map((s) => `${s.filePath}:${s.line}`)).toEqual([
      'src/router/dispatch.ts:44',
      'crates/core/src/merkle.rs:109',
      'services/etl/loader.py:88',
      'internal/raft/log.go:211',
    ]);

    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +12,6 @@ export function alpha()',
      '@@ -40,0 +48 @@ export function beta()',
    ].join('\n');

    const changes = extractGitDiffChanges(diff);
    expect(changes).toEqual([
      {
        filePath: 'src/a.ts',
        changedRanges: [
          { startLine: 12, endLine: 17 },
          { startLine: 48, endLine: 48 },
        ],
      },
    ]);
  });

  test('renderRepoMap strictly enforces maxTokens across tight and medium budgets while preserving call edges', () => {
    const blobs: SourceBlobRecord[] = Array.from({ length: 60 }, (_, idx) => {
      const nextIdx = (idx + 1) % 60;
      const pad = String(idx).padStart(2, '0');
      const nextPad = String(nextIdx).padStart(2, '0');
      return {
        filePath: `packages/mod-${pad}/src/step-${pad}.ts`,
        content: [
          `import { executePipelineStep${nextPad} } from "../../mod-${nextPad}/src/step-${nextPad}.js";`,
          `export function executePipelineStep${pad}(input: number): number {`,
          `  return executePipelineStep${nextPad}(input + ${idx});`,
          `}`,
        ].join('\n'),
      };
    });

    const graph = buildSymbolGraph(blobs);
    const ranked = rankSymbolGraph(graph, {
      activeFiles: ['packages/mod-00/src/step-00.ts'],
    });

    for (const budget of [12, 45, 120, 260, 600, 1200]) {
      const rendered = renderRepoMap(ranked, { maxTokens: budget });
      expect(rendered.estimatedTokens).toBeLessThanOrEqual(budget);
      expect(estimateRepoMapTokens(rendered.text)).toBeLessThanOrEqual(budget);
      if (budget >= 120) {
        expect(rendered.includedFiles[0]).toBe('packages/mod-00/src/step-00.ts');
        expect(rendered.includedFiles).toContain('packages/mod-01/src/step-01.ts');
        expect(rendered.includedFiles.length).toBeLessThan(60);
        expect(rendered.text).toContain('-> packages/mod-01/src/step-01.ts#executePipelineStep01');
      }
    }
  });

  test('generateWorkspaceRepoMap scans real filesystem directories and ignores node_modules/dist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzo-repomap-ws-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src', 'billing'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'noise-pkg'), { recursive: true });

      fs.writeFileSync(
        path.join(tmpDir, 'src', 'billing', 'tax.ts'),
        'export function calculateVatCents(subtotal: number): number { return Math.round(subtotal * 0.2); }\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'billing', 'checkout.ts'),
        [
          'import { calculateVatCents } from "./tax.js";',
          'export function finalizeCheckoutTotal(subtotal: number): number {',
          '  return subtotal + calculateVatCents(subtotal);',
          '}',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(tmpDir, 'node_modules', 'noise-pkg', 'index.ts'),
        'export function shouldNeverBeIndexed(): void {}\n'
      );

      const res = await generateWorkspaceRepoMap(
        tmpDir,
        { activeFiles: ['src/billing/checkout.ts'] },
        { maxTokens: 300, commitRevision: 'head-sha-001', tenantId: 'org-1', accessControl: { tenantId: 'org-1' } }
      );

      expect(res.metrics.authorizedFiles).toBe(2);
      expect(res.includedFiles).toEqual(['src/billing/checkout.ts', 'src/billing/tax.ts']);
      expect(res.text).toContain('calculateVatCents');
      expect(res.text).not.toContain('shouldNeverBeIndexed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('matched-baseline benchmark demonstrates quantitative RepoMap lift over naive_dump_100 and lexical_topk plus honest negative control', () => {
    const report = evaluateRepoMapBenchmark(undefined, { maxTokens: 650 });

    const naive = report.strategies.naive_dump_100;
    const lexical = report.strategies.lexical_topk;
    const repomap = report.strategies.symbol_graph_repomap;

    // Identical token budget respected by all 3 systems.
    expect(naive.meanMapTokens).toBeLessThanOrEqual(650);
    expect(lexical.meanMapTokens).toBeLessThanOrEqual(650);
    expect(repomap.meanMapTokens).toBeLessThanOrEqual(650);

    // Symbol-graph RepoMap outperforms both naive 100-file dump and lexical BM25 top-k
    // on target file recall, full multi-hop file selection, tokens before first useful edit,
    // navigation tool calls, and downstream multi-file task completion.
    expect(repomap.meanTargetFileRecall).toBeGreaterThan(lexical.meanTargetFileRecall);
    expect(repomap.meanTargetFileRecall).toBeGreaterThan(naive.meanTargetFileRecall);
    expect(repomap.meanTargetFileRecall).toBeGreaterThanOrEqual(0.95);

    expect(repomap.fullTargetSelectionRate).toBeGreaterThan(lexical.fullTargetSelectionRate);
    expect(repomap.fullTargetSelectionRate).toBeGreaterThan(naive.fullTargetSelectionRate);

    expect(repomap.meanTokensBeforeFirstUsefulEdit).toBeLessThan(
      lexical.meanTokensBeforeFirstUsefulEdit
    );
    expect(repomap.meanTokensBeforeFirstUsefulEdit).toBeLessThan(
      naive.meanTokensBeforeFirstUsefulEdit
    );

    expect(repomap.meanNavigationToolCalls).toBeLessThan(lexical.meanNavigationToolCalls);
    expect(repomap.meanNavigationToolCalls).toBeLessThan(naive.meanNavigationToolCalls);

    expect(repomap.taskCompletionRate).toBeGreaterThan(lexical.taskCompletionRate);
    expect(repomap.taskCompletionRate).toBeGreaterThan(naive.taskCompletionRate);

    // Negative / boundary control: on 50 disconnected standalone scripts with 0 edges,
    // graph ranking adds zero artificial lift over lexical matching.
    expect(report.negativeControl.graphEdgeCount).toBe(0);
    expect(Math.abs(report.negativeControl.recallLiftOverLexical)).toBeLessThanOrEqual(0.01);
  });

  test('resolves 2-hop TypeScript barrel re-exports (export * and named export-from) into direct symbol graph edges', () => {
    const blobs: SourceBlobRecord[] = [
      {
        filePath: 'packages/math/src/decimal.ts',
        content: 'export function roundBankersHalfEven(val: number): number { return Math.round(val); }',
      },
      {
        filePath: 'packages/math/src/internal.ts',
        content: 'export * from "./decimal.js";',
      },
      {
        filePath: 'packages/math/src/index.ts',
        content: 'export { roundBankersHalfEven } from "./internal.js";',
      },
      {
        filePath: 'apps/checkout/src/total.ts',
        content: [
          'import { roundBankersHalfEven } from "../../../packages/math/src/index.js";',
          'export function computeOrderTotal(raw: number): number {',
          '  return roundBankersHalfEven(raw);',
          '}',
        ].join('\n'),
      },
    ];

    const res = generateRepoMap(
      blobs,
      { activeFiles: ['apps/checkout/src/total.ts'] },
      { maxTokens: 400 }
    );

    expect(
      res.graph.edges.some(
        (e) =>
          e.fromFile === 'apps/checkout/src/total.ts' &&
          e.toFile === 'packages/math/src/decimal.ts' &&
          e.toSymbol === 'roundBankersHalfEven' &&
          e.kind === 'import_call'
      )
    ).toBe(true);
    expect(res.includedFiles).toContain('packages/math/src/decimal.ts');
  });

  test('invalidates DerivedSymbolCache entry cleanly when file blobSha changes across commits', () => {
    const cache = new DerivedSymbolCache();
    const v1: SourceBlobRecord[] = [
      {
        filePath: 'src/codec.ts',
        content: 'export function encodeFrameV1(): string { return "v1"; }',
        commitRevision: 'commit-1',
      },
    ];
    const g1 = buildSymbolGraph(v1, { cache });
    expect(g1.files.get('src/codec.ts')?.definitions[0].name).toBe('encodeFrameV1');
    expect(cache.stats().misses).toBe(1);

    const v2: SourceBlobRecord[] = [
      {
        filePath: 'src/codec.ts',
        content: 'export function encodeFrameV2(): string { return "v2"; }',
        commitRevision: 'commit-2',
      },
    ];
    const g2 = buildSymbolGraph(v2, { cache });
    expect(g2.files.get('src/codec.ts')?.definitions[0].name).toBe('encodeFrameV2');
    expect(cache.stats().misses).toBe(2);
  });

  test('handles empty corpora, dangling isolated nodes, and custom tokenCounter strictly', () => {
    const empty = generateRepoMap([], { taskQuery: 'anything' }, { maxTokens: 256 });
    expect(empty.text).toBe('');
    expect(empty.includedFiles).toEqual([]);
    expect(empty.metrics.estimatedTokens).toBe(0);

    const isolated: SourceBlobRecord[] = [
      { filePath: 'src/island-a.ts', content: 'export function alphaIsland(): number { return 1; }' },
      { filePath: 'src/island-b.ts', content: 'export function betaIsland(): number { return 2; }' },
    ];
    // Strict custom word-based token counter
    const customCounter = (txt: string) => (txt ? txt.trim().split(/\s+/).length : 0);
    const map = generateRepoMap(
      isolated,
      {},
      { maxTokens: 12, tokenCounter: customCounter, includeHeader: false }
    );
    expect(map.metrics.pprConverged).toBe(true);
    expect(customCounter(map.text)).toBeLessThanOrEqual(12);
    expect(map.metrics.estimatedTokens).toBeLessThanOrEqual(12);
  });

  test('maintains strict isolation across concurrent multi-tenant RepoMap evaluations', async () => {
    const sharedPool: SourceBlobRecord[] = [
      {
        filePath: 'src/alpha-engine.ts',
        tenantId: 'tenant-a',
        content: 'export function runTenantAlphaEngine(): string { return "alpha"; }',
      },
      {
        filePath: 'src/beta-engine.ts',
        tenantId: 'tenant-b',
        content: 'export function runTenantBetaEngine(): string { return "beta"; }',
      },
    ];

    const cache = new DerivedSymbolCache();
    const runs = await Promise.all(
      Array.from({ length: 16 }, (_, idx) => {
        const tenantId = idx % 2 === 0 ? 'tenant-a' : 'tenant-b';
        return Promise.resolve().then(() =>
          generateRepoMap(
            sharedPool,
            {
              taskQuery: 'runTenantAlphaEngine runTenantBetaEngine',
              accessControl: { tenantId },
            },
            { cache, maxTokens: 300 }
          )
        );
      })
    );

    runs.forEach((res, idx) => {
      if (idx % 2 === 0) {
        expect(res.includedFiles).toEqual(['src/alpha-engine.ts']);
        expect(res.text).not.toContain('runTenantBetaEngine');
      } else {
        expect(res.includedFiles).toEqual(['src/beta-engine.ts']);
        expect(res.text).not.toContain('runTenantAlphaEngine');
      }
    });
  });

  test('re-exports RepoMap API cleanly from root src/index.ts entrypoint', async () => {
    const rootModule = await import('../../src/index.js');
    expect(typeof rootModule.generateRepoMap).toBe('function');
    expect(typeof rootModule.buildSymbolGraph).toBe('function');
    expect(typeof rootModule.rankSymbolGraph).toBe('function');
    expect(typeof rootModule.renderRepoMap).toBe('function');
    expect(typeof rootModule.evaluateRepoMapBenchmark).toBe('function');
  });
});
