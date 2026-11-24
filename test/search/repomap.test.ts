/**
 * Dynamic Symbol-Graph RepoMap Test Suite (HIP-1347 / Bounty #36).
 */

import { describe, test, expect } from '@jest/globals';
import {
  RepoMapEngine,
  defaultExtractSymbols,
  isAuthorized,
  repoMapTool,
} from '../../src/search/repomap.js';

describe('Dynamic Symbol-Graph RepoMap (HIP-1347 / #36)', () => {
  test('extracts symbol definitions across TypeScript, Python, Rust, and Go', () => {
    const ts = defaultExtractSymbols(
      'src/router.ts',
      'export interface RouteConfig { path: string }\nexport async function dispatchRoute(cfg: RouteConfig) { return cfg; }',
    );
    expect(ts.defs.map((d) => d.name)).toEqual(['RouteConfig', 'dispatchRoute']);

    const py = defaultExtractSymbols(
      'worker/pipeline.py',
      'class IngestionWorker:\n    def process_batch(self, items):\n        pass\ndef run_pipeline():\n    pass',
    );
    expect(py.defs.map((d) => d.name)).toEqual(['IngestionWorker', 'process_batch', 'run_pipeline']);

    const rs = defaultExtractSymbols(
      'rust/src/index.rs',
      'pub struct SymbolGraph { nodes: usize }\npub async fn rank_symbols() -> usize { 0 }',
    );
    expect(rs.defs.map((d) => d.name)).toEqual(['SymbolGraph', 'rank_symbols']);

    const go = defaultExtractSymbols(
      'go/pkg/server.go',
      'type GatewayServer struct {}\nfunc (s *GatewayServer) ServeHTTP() {}',
    );
    expect(go.defs.map((d) => d.name)).toEqual(['GatewayServer', 'ServeHTTP']);
  });

  test('enforces mandatory pre-query Tenant & ACL isolation before graph construction (0 cross-tenant leaks)', () => {
    const engine = new RepoMapEngine();
    engine.indexDocuments([
      {
        path: 'src/public_api.ts',
        tenantId: 'tenant-alpha',
        acl: ['*'],
        content:
          "import { SecretVaultKey } from './vault';\nexport function handleRequest() { return SecretVaultKey(); }",
      },
      {
        path: 'src/vault.ts',
        tenantId: 'tenant-alpha',
        acl: ['role:security-admin'],
        content: "export function SecretVaultKey() { return 'top-secret'; }",
      },
      {
        path: 'src/other_tenant.ts',
        tenantId: 'tenant-beta',
        acl: ['*'],
        content: "export function SecretVaultKey() { return 'beta-secret'; }",
      },
    ]);

    const res = engine.buildRepoMap({
      caller: { tenantId: 'tenant-alpha', principal: 'dev@alpha.io', roles: ['engineer'] },
      taskQuery: 'SecretVaultKey handleRequest',
      maxTokens: 512,
    });

    expect(res.candidateFilesAuthorized).toBe(1);
    expect(res.candidateFilesFilteredOut).toBe(2);
    expect(res.mapText).toContain('src/public_api.ts');
    expect(res.mapText).not.toContain('src/vault.ts');
    expect(res.mapText).not.toContain('src/other_tenant.ts');
    expect(
      isAuthorized(
        { path: 'x.ts', content: '', tenantId: 't1', acl: ['alice'] },
        { tenantId: 't2', principal: 'alice' },
      ),
    ).toBe(false);
  });

  test('ranks multi-hop symbol dependencies ahead of noise files via Personalized PageRank within maxTokens', () => {
    const engine = new RepoMapEngine();
    const docs = [
      {
        path: 'src/agent/runner.ts',
        tenantId: 'hanzo',
        content:
          "import { DeadlockDetector } from '../runtime/deadlock';\nexport class AgentRunner {\n  finish() { return new DeadlockDetector().record_finish(); }\n}",
      },
      {
        path: 'src/runtime/deadlock.ts',
        tenantId: 'hanzo',
        content:
          "import { LeaseTable } from './lease_table';\nexport class DeadlockDetector {\n  record_finish() { return acquireLeaseLock(); }\n}",
      },
      {
        path: 'src/runtime/lease_table.ts',
        tenantId: 'hanzo',
        content:
          'export function acquireLeaseLock() { return true; }\nexport class LeaseTable {}',
      },
    ];

    for (let i = 0; i < 35; i++) {
      docs.push({
        path: `src/unrelated/module_${i}.ts`,
        tenantId: 'hanzo',
        content:
          `export function unrelatedHelper_${i}() { return ${i}; }\nexport class NoiseComponent_${i} {}\n` +
          '// filler\n'.repeat(30),
      });
    }
    engine.indexDocuments(docs);

    const res = engine.buildRepoMap({
      caller: { tenantId: 'hanzo', principal: 'agent-1' },
      activeFiles: ['src/agent/runner.ts'],
      errorOutput: 'Error: deadlock in record_finish',
      maxTokens: 220,
    });

    const top3 = res.rankedFiles.slice(0, 3).map((f) => f.path);
    expect(top3).toContain('src/runtime/deadlock.ts');
    expect(top3).toContain('src/agent/runner.ts');

    const leaseRank = res.rankedFiles.findIndex((f) => f.path === 'src/runtime/lease_table.ts');
    expect(leaseRank).toBeGreaterThanOrEqual(0);
    expect(leaseRank).toBeLessThan(5);
    expect(res.tokensUsed).toBeLessThanOrEqual(220);
    expect(res.tokenReductionPct).toBeGreaterThan(80);
  });

  test('repoMapTool handler enforces caller identity and returns compact map', async () => {
    const missingAuth = await repoMapTool.handler({ tenantId: '', principal: '' });
    expect(missingAuth.isError).toBe(true);
  });
});
