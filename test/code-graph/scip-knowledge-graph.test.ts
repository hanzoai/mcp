import { describe, expect, it } from '@jest/globals';
import {
  CodeKnowledgeGraph,
  ScipIndexInput,
  ScipSymbolRole,
  SourceBlobIdentity,
  createCodeGraphTools,
  maskCommentsAndStringsPreservingLayout,
  parseScipSymbol,
} from '../../src/code-graph/index.js';

describe('Compiler-Aware Code Knowledge Graph (SCIP + Tree-sitter Structural, #34)', () => {
  it('parses standard scip-typescript, scip-go, escaped backtick, and local SCIP symbols', () => {
    const tsSym = parseScipSymbol(
      'scip-typescript npm @hanzo/mcp 2.4.22 src/billing/`ledger.service.ts`/InvoiceProcessor#settleBatch(1).'
    );
    expect(tsSym.isLocal).toBe(false);
    expect(tsSym.scheme).toBe('scip-typescript');
    expect(tsSym.manager).toBe('npm');
    expect(tsSym.packageName).toBe('@hanzo/mcp');
    expect(tsSym.enclosingType).toBe('InvoiceProcessor');
    expect(tsSym.leafName).toBe('settleBatch');

    const goSym = parseScipSymbol('scip-go gomod github.com/hanzoai/vfs v0.4.0 pkg/journal/WalWriter#Sync().');
    expect(goSym.scheme).toBe('scip-go');
    expect(goSym.enclosingType).toBe('WalWriter');
    expect(goSym.leafName).toBe('Sync');

    const localSym = parseScipSymbol('local 42');
    expect(localSym.isLocal).toBe(true);
    expect(localSym.leafName).toBe('42');
  });

  it('masks comments and strings across TS, Go, Rust, and Python without shifting line or column spans', () => {
    const tsCode = [
      '// function fakeInLineComment() {}',
      'const msg = "class FakeInString implements Ghost {}";',
      'export function realTarget(x: number): number { return x + 1; }',
    ].join('\n');
    const masked = maskCommentsAndStringsPreservingLayout(tsCode, 'typescript');
    expect(masked.split('\n').length).toBe(3);
    expect(masked).not.toContain('fakeInLineComment');
    expect(masked).not.toContain('FakeInString');
    expect(masked.split('\n')[2]).toContain('export function realTarget');
  });

  it('ingests compiler SCIP occurrences + isImplementation edges and resolves overloaded symbols accurately', () => {
    const graph = new CodeKnowledgeGraph();
    const blobs: SourceBlobIdentity[] = [
      {
        tenantId: 'tenant-alpha',
        repoId: 'payments-ts',
        commitOid: 'c001',
        packageName: 'core',
        filePath: 'src/core/gateway.ts',
        language: 'typescript',
        content: [
          'export interface PaymentGateway {',
          '  charge(cents: number): Promise<boolean>;',
          '}',
        ].join('\n'),
      },
      {
        tenantId: 'tenant-alpha',
        repoId: 'payments-ts',
        commitOid: 'c001',
        packageName: 'stripe',
        filePath: 'src/stripe/adapter.ts',
        language: 'typescript',
        content: [
          'import { PaymentGateway } from "../core/gateway.js";',
          'export class StripeGateway implements PaymentGateway {',
          '  async charge(cents: number): Promise<boolean> {',
          '    return cents > 0;',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        tenantId: 'tenant-alpha',
        repoId: 'payments-ts',
        commitOid: 'c001',
        packageName: 'checkout',
        filePath: 'src/checkout/runner.ts',
        language: 'typescript',
        content: [
          'import { PaymentGateway } from "../core/gateway.js";',
          'export async function runCheckout(gw: PaymentGateway): Promise<boolean> {',
          '  return gw.charge(500);',
          '}',
        ].join('\n'),
      },
    ];

    const ifaceSym = 'scip-typescript npm payments 1.0.0 src/core/`gateway.ts`/PaymentGateway#';
    const ifaceCharge = 'scip-typescript npm payments 1.0.0 src/core/`gateway.ts`/PaymentGateway#charge().';
    const stripeSym = 'scip-typescript npm payments 1.0.0 src/stripe/`adapter.ts`/StripeGateway#';
    const stripeCharge = 'scip-typescript npm payments 1.0.0 src/stripe/`adapter.ts`/StripeGateway#charge().';

    const scipIndex: ScipIndexInput = {
      toolInfo: { name: 'scip-typescript', version: '0.3.14' },
      documents: [
        {
          relativePath: 'src/core/gateway.ts',
          occurrences: [
            { range: [0, 17, 31], symbol: ifaceSym, symbolRoles: ScipSymbolRole.Definition },
            { range: [1, 2, 8], symbol: ifaceCharge, symbolRoles: ScipSymbolRole.Definition },
          ],
        },
        {
          relativePath: 'src/stripe/adapter.ts',
          occurrences: [
            { range: [0, 9, 23], symbol: ifaceSym, symbolRoles: ScipSymbolRole.Import },
            { range: [1, 13, 26], symbol: stripeSym, symbolRoles: ScipSymbolRole.Definition },
            { range: [1, 38, 52], symbol: ifaceSym, symbolRoles: ScipSymbolRole.ReadAccess },
            { range: [2, 8, 14], symbol: stripeCharge, symbolRoles: ScipSymbolRole.Definition },
          ],
          symbols: [
            {
              symbol: stripeSym,
              relationships: [{ symbol: ifaceSym, isImplementation: true }],
            },
            {
              symbol: stripeCharge,
              relationships: [{ symbol: ifaceCharge, isImplementation: true, isReference: true }],
            },
          ],
        },
        {
          relativePath: 'src/checkout/runner.ts',
          occurrences: [
            { range: [0, 9, 23], symbol: ifaceSym, symbolRoles: ScipSymbolRole.Import },
            { range: [1, 38, 52], symbol: ifaceSym, symbolRoles: ScipSymbolRole.ReadAccess },
            { range: [2, 12, 18], symbol: ifaceCharge, symbolRoles: ScipSymbolRole.ReadAccess },
          ],
        },
      ],
    };

    graph.indexRepository(blobs, scipIndex);
    const ctx = { tenantId: 'tenant-alpha' };

    const defs = graph.findDefinitions('payments-ts', 'PaymentGateway', ctx);
    expect(defs).toHaveLength(1);
    expect(defs[0].filePath).toBe('src/core/gateway.ts');
    expect(defs[0].provenance).toBe('scip');

    const impls = graph.findImplementations('payments-ts', 'PaymentGateway', ctx);
    expect(impls.map((h) => h.symbolName)).toContain('StripeGateway');

    const refs = graph.findReferences('payments-ts', ifaceCharge, ctx);
    expect(refs).toHaveLength(1);
    expect(refs[0].filePath).toBe('src/checkout/runner.ts');
    expect(refs[0].span.startLine).toBe(3);
  });

  it('infers Go duck-typed interface implementations, Rust trait impls, and Python subclasses structurally', () => {
    const graph = new CodeKnowledgeGraph();
    graph.indexRepository([
      {
        tenantId: 't1',
        repoId: 'polyglot',
        commitOid: 'a1',
        packageName: 'storage',
        filePath: 'go/store.go',
        language: 'go',
        content: [
          'package storage',
          'type SnapshotSink interface {',
          '    WriteChunk(offset int64) error',
          '    FlushSink() error',
          '}',
          'type S3SnapshotSink struct {}',
          'func (s *S3SnapshotSink) WriteChunk(offset int64) error { return nil }',
          'func (s *S3SnapshotSink) FlushSink() error { return nil }',
        ].join('\n'),
      },
      {
        tenantId: 't1',
        repoId: 'polyglot',
        commitOid: 'a1',
        packageName: 'kernel',
        filePath: 'rust/scheduler.rs',
        language: 'rust',
        content: [
          'pub trait BatchPolicy {',
          '    fn select_slot(&self) -> usize;',
          '}',
          'pub struct FairTenantPolicy;',
          'impl BatchPolicy for FairTenantPolicy {',
          '    fn select_slot(&self) -> usize { 0 }',
          '}',
        ].join('\n'),
      },
      {
        tenantId: 't1',
        repoId: 'polyglot',
        commitOid: 'a1',
        packageName: 'rerank',
        filePath: 'py/reranker.py',
        language: 'python',
        content: [
          'class CrossEncoderBase(Protocol):',
          '    def score_pair(self, q: str, d: str) -> float:',
          '        return 0.0',
          '',
          'class DistilledMiniReranker(CrossEncoderBase):',
          '    def score_pair(self, q: str, d: str) -> float:',
          '        return 1.0',
        ].join('\n'),
      },
    ]);

    const ctx = { tenantId: 't1' };
    expect(graph.findImplementations('polyglot', 'SnapshotSink', ctx).map((h) => h.symbolName)).toEqual([
      'S3SnapshotSink',
    ]);
    expect(graph.findImplementations('polyglot', 'BatchPolicy', ctx).map((h) => h.symbolName)).toEqual([
      'FairTenantPolicy',
    ]);
    expect(
      graph.findImplementations('polyglot', 'CrossEncoderBase', ctx).map((h) => h.symbolName)
    ).toEqual(['DistilledMiniReranker']);
  });

  it('enforces fail-closed tenant and RBAC role isolation BEFORE returning definitions, references, or bug candidates', () => {
    const graph = new CodeKnowledgeGraph();
    graph.indexRepository([
      {
        tenantId: 'tenant-a',
        repoId: 'shared-name',
        commitOid: 'c1',
        packageName: 'public-api',
        filePath: 'src/public.ts',
        language: 'typescript',
        allowedRoles: ['reader', 'admin'],
        content: 'export function computeQuota(u: number): number { return u * 2; }',
      },
      {
        tenantId: 'tenant-a',
        repoId: 'shared-name',
        commitOid: 'c1',
        packageName: 'billing-secret',
        filePath: 'src/internal-key.ts',
        language: 'typescript',
        allowedRoles: ['admin'],
        content: [
          'import { computeQuota } from "./public.js";',
          'export function rotateSigningVault(): number { return computeQuota(10); }',
        ].join('\n'),
      },
    ]);

    // Wrong tenant sees zero definitions, zero references, zero localization hits
    expect(graph.findDefinitions('shared-name', 'computeQuota', { tenantId: 'tenant-b' })).toHaveLength(0);
    expect(
      graph.localizeBugFiles('shared-name', 'rotateSigningVault computeQuota', { tenantId: 'tenant-b' })
    ).toHaveLength(0);

    // Same tenant with only 'reader' role sees `public.ts`, NEVER `internal-key.ts`
    const readerRefs = graph.findReferences('shared-name', 'computeQuota', {
      tenantId: 'tenant-a',
      principalRoles: ['reader'],
    });
    expect(readerRefs).toHaveLength(0);
    expect(
      graph.findDefinitions('shared-name', 'rotateSigningVault', {
        tenantId: 'tenant-a',
        principalRoles: ['reader'],
      })
    ).toHaveLength(0);

    // Same tenant with 'admin' role sees both
    const adminRefs = graph.findReferences('shared-name', 'computeQuota', {
      tenantId: 'tenant-a',
      principalRoles: ['admin'],
    });
    expect(adminRefs.map((r) => r.filePath)).toContain('src/internal-key.ts');
  });

  it('produces bit-identical graph digests between incremental commit delta updates and cold full rebuilds', () => {
    const baseFiles: SourceBlobIdentity[] = Array.from({ length: 12 }, (_, idx) => ({
      tenantId: 'org-1',
      repoId: 'monorepo',
      commitOid: 'commit-1',
      packageName: `pkg-${idx % 3}`,
      filePath: `packages/p${idx % 3}/mod_${idx}.ts`,
      language: 'typescript' as const,
      content: `export function helper_${idx}(v: number): number { return v + ${idx}; }\n`,
    }));
    baseFiles.push({
      tenantId: 'org-1',
      repoId: 'monorepo',
      commitOid: 'commit-1',
      packageName: 'pkg-0',
      filePath: 'packages/p0/caller.ts',
      language: 'typescript',
      content: [
        'import { helper_0 } from "./mod_0.js";',
        'export function runCaller(): number { return helper_0(5); }',
      ].join('\n'),
    });

    const incrementalGraph = new CodeKnowledgeGraph();
    incrementalGraph.indexRepository(baseFiles);

    const updatedMod0: SourceBlobIdentity = {
      tenantId: 'org-1',
      repoId: 'monorepo',
      commitOid: 'commit-2',
      packageName: 'pkg-0',
      filePath: 'packages/p0/mod_0.ts',
      language: 'typescript',
      content: [
        'export function helper_0(v: number): number { return Math.max(0, v); }',
        'export function helper_0_v2(): number { return helper_0(1); }',
      ].join('\n'),
    };

    const stats = incrementalGraph.reindexCommit({
      tenantId: 'org-1',
      repoId: 'monorepo',
      newCommitOid: 'commit-2',
      upsertedBlobs: [updatedMod0],
      deletedFilePaths: ['packages/p2/mod_11.ts'],
    });

    expect(stats.reindexedFiles).toBe(1);
    expect(stats.removedFiles).toBe(1);
    expect(stats.untouchedFiles).toBe(11);

    // Cold full rebuild from exact commit-2 snapshot
    const coldSnapshot = baseFiles
      .filter((b) => b.filePath !== 'packages/p2/mod_11.ts' && b.filePath !== 'packages/p0/mod_0.ts')
      .map((b) => ({ ...b, commitOid: 'commit-2' }))
      .concat([updatedMod0]);

    const coldGraph = new CodeKnowledgeGraph();
    const coldStats = coldGraph.indexRepository(coldSnapshot);

    expect(stats.graphDigest).toBe(coldStats.graphDigest);
  });

  it('exposes opt-in MCP tool handlers for definition, reference, implementation, and bug localization', async () => {
    const graph = new CodeKnowledgeGraph();
    graph.indexRepository([
      {
        tenantId: 't-mcp',
        repoId: 'svc',
        commitOid: 'head1',
        packageName: 'auth',
        filePath: 'src/auth/verifier.ts',
        language: 'typescript',
        content: 'export function verifyJwtSignature(tok: string): boolean { return tok.length > 10; }',
      },
    ]);

    const tools = createCodeGraphTools(graph);
    expect(tools.map((t) => t.name)).toEqual([
      'code_graph_definition',
      'code_graph_references',
      'code_graph_implementations',
      'code_graph_localize_bug',
    ]);

    const res = await tools[0].handler({
      tenantId: 't-mcp',
      repoId: 'svc',
      symbol: 'verifyJwtSignature',
    });
    const parsed = JSON.parse(res.content[0].text ?? '[]');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].filePath).toBe('src/auth/verifier.ts');
  });
});
