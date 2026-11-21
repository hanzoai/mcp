import { describe, expect, test } from '@jest/globals';
import {
  RepoGraphEngine,
  RepoGraphError,
  createRepoGraphTools,
  evaluateRepoGraphBenchmark,
} from '../../src/repograph/index.js';

describe('HIP-1347 RepoGraph Architectural Reasoning (#37)', () => {
  const access = { tenantId: 't-prod', repoId: 'core-monorepo' };

  test('find_callers and find_implementations resolve TS interfaces while pruning unrelated receiver decoys', () => {
    const engine = new RepoGraphEngine({
      blobs: [
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/ledger/src/port.ts',
          content: 'export interface LedgerSink {\n  append(entry: string): boolean;\n}\n',
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/ledger/src/postgres_sink.ts',
          content: [
            'export class PostgresSink implements LedgerSink {',
            '  append(entry: string): boolean {',
            '    return entry.length > 0;',
            '  }',
            '}',
          ].join('\n'),
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/api/src/audit.ts',
          content: [
            'export function recordAudit(sink: LedgerSink, msg: string): boolean {',
            '  return sink.append(msg);',
            '}',
          ].join('\n'),
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/ui/src/dom_list.ts',
          content: [
            'export class DomList {',
            '  append(label: string): void { void label; }',
            '}',
            'export function renderMenu(): void {',
            '  const list: DomList = new DomList();',
            '  list.append("home");',
            '}',
          ].join('\n'),
        },
      ],
      traces: [
        {
          traceId: 'tr-sink-1',
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          entryPoint: 'packages/api/test/audit.test.ts',
          callerFile: 'packages/api/src/audit.ts',
          callerSymbol: 'recordAudit',
          calleeFile: 'packages/ledger/src/postgres_sink.ts',
          calleeSymbol: 'append',
          calleeOwnerType: 'PostgresSink',
          invocations: 320,
        },
      ],
    });

    const impls = engine.findImplementations({ interfaceOrSymbol: 'LedgerSink.append' }, access);
    expect(impls).toHaveLength(1);
    expect(impls[0].concreteType).toBe('PostgresSink');
    expect(impls[0].runtimeInvocations).toBe(320);

    const callerRes = engine.findCallers(
      { symbol: 'PostgresSink.append', includeTests: false },
      access
    );
    expect(callerRes.callers.map((c) => c.callerSymbol)).toEqual(['recordAudit']);
    // Unrelated `DomList.append` caller `renderMenu` is pruned!
    expect(callerRes.callers.some((c) => c.callerSymbol === 'renderMenu')).toBe(false);
    expect(callerRes.falsePathsPruned).toBeGreaterThanOrEqual(1);
  });

  test('resolves Go structural interfaces, Rust trait impls, and Python subclasses', () => {
    const engine = new RepoGraphEngine({
      blobs: [
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'services/kv/iface.go',
          language: 'go',
          content: 'package kv\ntype SnapshotStore interface {\n\tOpen(id string) error\n\tClose() error\n}\n',
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'services/kv/mem.go',
          language: 'go',
          content: [
            'package kv',
            'type MemSnapshot struct {}',
            'func (m *MemSnapshot) Open(id string) error { return nil }',
            'func (m *MemSnapshot) Close() error { return nil }',
          ].join('\n'),
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'crates/idx/src/lib.rs',
          language: 'rust',
          content: [
            'pub trait VectorIndex {',
            '    fn query(&self, k: usize) -> usize;',
            '}',
            'impl VectorIndex for HnswIndex {',
            '    fn query(&self, k: usize) -> usize { k }',
            '}',
          ].join('\n'),
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/agents/runner.py',
          language: 'python',
          content: [
            'class BaseExecutor:',
            '    def execute(self, cmd: str) -> int:',
            '        return 0',
            'class SandboxExecutor(BaseExecutor):',
            '    def execute(self, cmd: str) -> int:',
            '        return 1',
          ].join('\n'),
        },
      ],
    });

    const goImpls = engine.findImplementations({ interfaceOrSymbol: 'SnapshotStore' }, access);
    expect(goImpls).toHaveLength(1);
    expect(goImpls[0].concreteType).toBe('MemSnapshot');
    expect(goImpls[0].mechanism).toBe('go_structural_interface');

    const rustImpls = engine.findImplementations({ interfaceOrSymbol: 'VectorIndex.query' }, access);
    expect(rustImpls).toHaveLength(1);
    expect(rustImpls[0].concreteType).toBe('HnswIndex');
    expect(rustImpls[0].mechanism).toBe('rust_trait_impl');

    const pyImpls = engine.findImplementations({ interfaceOrSymbol: 'BaseExecutor.execute' }, access);
    expect(pyImpls).toHaveLength(1);
    expect(pyImpls[0].concreteType).toBe('SandboxExecutor');
    expect(pyImpls[0].mechanism).toBe('python_subclass');
  });

  test('trace_dependency, explain_change_impact, find_related_tests, and find_regression_origin fuse static, runtime, failure, and Git signals', () => {
    const engine = new RepoGraphEngine({
      blobs: [
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/crypto/src/signer.ts',
          content: 'export function signDigest(payload: string): string {\n  return "sig:" + payload;\n}\n',
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/tokens/src/mint.ts',
          content: 'export function mintJwt(body: string): string {\n  return signDigest(body);\n}\n',
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/gateway/src/login.ts',
          content: 'export function loginEndpoint(user: string): string {\n  return mintJwt(user);\n}\n',
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/schema/jwt_wire.json.ts',
          content: 'export const WIRE_VERSION = 2;\n',
        },
        {
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          filePath: 'packages/gateway/test/login.test.ts',
          content: 'export function testLogin() { return loginEndpoint("alice"); }\n',
        },
      ],
      traces: [
        {
          traceId: 'tr-jwt',
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          entryPoint: 'packages/gateway/test/login.test.ts',
          callerFile: 'packages/tokens/src/mint.ts',
          callerSymbol: 'mintJwt',
          calleeFile: 'packages/crypto/src/signer.ts',
          calleeSymbol: 'signDigest',
          invocations: 450,
          errorCount: 9,
        },
      ],
      failures: [
        {
          failureId: 'f-jwt-99',
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          commitSha: 'sha-3',
          testFile: 'packages/gateway/test/login.test.ts',
          errorMessage: 'Invalid JWT signature prefix',
          stackFrames: [
            { filePath: 'packages/gateway/src/login.ts', symbolName: 'loginEndpoint', line: 2 },
          ],
        },
      ],
      commits: [
        {
          commitSha: 'sha-1',
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          timestampEpochSec: 1700100100,
          author: 'dev1',
          message: 'feat: sync signer and wire schema v1',
          touchedFiles: [
            { filePath: 'packages/crypto/src/signer.ts', changedLines: [2], touchedSymbols: ['signDigest'] },
            { filePath: 'packages/schema/jwt_wire.json.ts', changedLines: [1] },
          ],
        },
        {
          commitSha: 'sha-2',
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          timestampEpochSec: 1700100200,
          author: 'dev2',
          message: 'refactor: change signDigest prefix without updating schema',
          touchedFiles: [
            { filePath: 'packages/crypto/src/signer.ts', changedLines: [2], touchedSymbols: ['signDigest'] },
            { filePath: 'packages/schema/jwt_wire.json.ts', changedLines: [1] },
          ],
        },
        {
          commitSha: 'sha-3',
          tenantId: 't-prod',
          repoId: 'core-monorepo',
          timestampEpochSec: 1700100300,
          author: 'dev3',
          message: 'docs: unrelated comment in schema',
          touchedFiles: [
            { filePath: 'packages/schema/jwt_wire.json.ts', changedLines: [1], touchedSymbols: [] },
          ],
        },
      ],
    });

    const dep = engine.traceDependency(
      { from: 'loginEndpoint', to: 'signDigest' },
      access
    );
    expect(dep.reachable).toBe(true);
    expect(dep.shortestHopCount).toBe(2);

    const impact = engine.explainChangeImpact({ symbols: ['signDigest'] }, access);
    expect(impact.overallRisk).toBe('critical');
    expect(impact.impactedSymbols.map((s) => s.symbolName)).toEqual(
      expect.arrayContaining(['mintJwt', 'loginEndpoint'])
    );
    expect(impact.coChangeCoupledFiles.map((c) => c.coupledFile)).toContain(
      'packages/schema/jwt_wire.json.ts'
    );
    expect(impact.relatedTests[0].testFile).toBe('packages/gateway/test/login.test.ts');

    const origins = engine.findRegressionOrigin({ failureId: 'f-jwt-99' }, access);
    expect(origins.length).toBeGreaterThan(0);
    expect(origins[0].commitSha).toBe('sha-2');
    expect(origins[0].filePath).toBe('packages/crypto/src/signer.ts');
  });

  test('enforces strict pre-retrieval multi-tenant & RBAC isolation and bit-identical derived rebuild', () => {
    const engine = new RepoGraphEngine({
      blobs: [
        {
          tenantId: 'tenant-secret',
          repoId: 'r1',
          filePath: 'packages/sec/kdf.ts',
          allowedRoles: ['auditor'],
          content: 'export function deriveKey(seed: string): string { return seed; }\n',
        },
        {
          tenantId: 'tenant-secret',
          repoId: 'r1',
          filePath: 'packages/sec/vault.ts',
          allowedRoles: ['auditor'],
          content: 'export function unlockVault(s: string): string { return deriveKey(s); }\n',
        },
      ],
    });

    // Other tenant sees zero callers
    expect(
      engine.findCallers(
        { symbol: 'deriveKey' },
        { tenantId: 'tenant-public', repoId: 'r1', callerRoles: ['auditor'] }
      ).callers
    ).toHaveLength(0);

    // Same tenant without required role sees zero callers
    expect(
      engine.findCallers(
        { symbol: 'deriveKey' },
        { tenantId: 'tenant-secret', repoId: 'r1', callerRoles: ['guest'] }
      ).callers
    ).toHaveLength(0);

    // Authorized caller sees `unlockVault`
    expect(
      engine
        .findCallers(
          { symbol: 'deriveKey' },
          { tenantId: 'tenant-secret', repoId: 'r1', callerRoles: ['auditor'] }
        )
        .callers.map((c) => c.callerSymbol)
    ).toEqual(['unlockVault']);

    // Empty tenantId throws RepoGraphError
    expect(() => engine.findCallers({ symbol: 'deriveKey' }, { tenantId: '' })).toThrow(
      RepoGraphError
    );

    // Derived graph rebuilds deterministically from canonical records
    const beforeDigest = engine.getDerivedSnapshotDigest();
    const afterDigest = engine.rebuildDerivedGraph();
    expect(afterDigest).toBe(beforeDigest);
  });

  test('exposes all 6 opt-in MCP tools cleanly via createRepoGraphTools()', async () => {
    const engine = new RepoGraphEngine({
      blobs: [
        {
          tenantId: 'mcp',
          repoId: 'demo',
          filePath: 'src/a.ts',
          content: 'export function leaf(): number { return 1; }\n',
        },
        {
          tenantId: 'mcp',
          repoId: 'demo',
          filePath: 'src/b.ts',
          content: 'export function root(): number { return leaf(); }\n',
        },
      ],
    });

    const tools = createRepoGraphTools({
      engine,
      defaultTenantId: 'mcp',
      defaultRepoId: 'demo',
    });
    expect(tools.map((t) => t.name)).toEqual([
      'find_callers',
      'find_implementations',
      'trace_dependency',
      'explain_change_impact',
      'find_related_tests',
      'find_regression_origin',
    ]);

    const res = await tools[0].handler({ symbol: 'leaf' });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(body.callers[0].callerSymbol).toBe('root');
  });

  test('reproduces benchmark lift across impact F1, false path pruning, root-cause Top-1, and repair rate', () => {
    const report = evaluateRepoGraphBenchmark();
    const lex = report.aggregates.find((a) => a.strategy === 'lexical_grep_gitlog')!;
    const stat = report.aggregates.find((a) => a.strategy === 'static_graph_only')!;
    const hyb = report.aggregates.find((a) => a.strategy === 'hybrid_repograph')!;

    expect(hyb.meanImpactF1Pct).toBe(100);
    expect(hyb.meanFalseDependencyPathPct).toBe(0);
    expect(hyb.rootCauseTop1AccuracyPct).toBe(100);
    expect(hyb.guidedRepairSuccessRatePct).toBe(100);
    expect(hyb.meanImpactF1Pct).toBeGreaterThan(stat.meanImpactF1Pct);
    expect(hyb.meanImpactF1Pct).toBeGreaterThan(lex.meanImpactF1Pct);
    expect(hyb.meanFalseDependencyPathPct).toBeLessThan(stat.meanFalseDependencyPathPct);
    expect(report.negativeControl.zeroSpuriousImpactEdges).toBe(true);
    expect(report.negativeControl.zeroFalseCallers).toBe(true);
  });
});
