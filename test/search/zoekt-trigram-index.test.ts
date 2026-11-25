/**
 * Comprehensive test suite for HIP-1347 Trigram Code Search (Zoekt).
 *
 * Covers:
 * - 100% exact-match recall on CUDA_ERROR_STREAM_CAPTURE_INVALIDATED across .cu/.yaml/.toml/CRLF
 * - Sound regex trigram planning (AND, OR alternation, optional groups, fallback)
 * - Path/filename queries and multi-language symbol definition ranking
 * - Hybrid ranking invariant (exact fast path always beats approximate lexical matches)
 * - Incremental upsert/delete, SHA-256 unchanged fast skip, and branch delta freshness
 * - Strict pre-return multi-tenant ACL isolation (tenantId, aclScope, allowedRepos, branch)
 * - Derived index wipe & bit-identical rebuildability from canonical source blobs
 * - Symlinked TMPDIR resolution via fs.realpathSync
 * - 10-tenant parallel Promise.all concurrency isolation
 * - Honest negative regimes (embedding-only miss, short/wildcard regex fallback, cold amortization)
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TrigramAccessContext,
  TrigramCodeIndex,
  TrigramSourceBlobInput,
  planRegexTrigrams,
} from '../../src/search/trigram-index.js';
import { runZoektBenchmark } from '../../src/search/zoekt-benchmark.js';

const ALPHA_ACCESS: TrigramAccessContext = {
  tenantId: 'tenant-alpha',
  allowedScopes: ['team:core'],
  branch: 'main',
};

describe('TrigramCodeIndex (HIP-1347 Zoekt Clean-Room Engine)', () => {
  it('achieves 100% exact-match recall on CUDA_ERROR_STREAM_CAPTURE_INVALIDATED across .cu, .yaml, .toml, and CRLF files via fast path', () => {
    const index = new TrigramCodeIndex();
    const plantedPaths = [
      'kernels/stream_capture.cu',
      'config/runtime.toml',
      'config/alerts.yaml',
      'src/handler.ts',
    ];

    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'gpu-core',
      branch: 'main',
      path: 'kernels/stream_capture.cu',
      content: 'enum Err {\r\n  CUDA_ERROR_STREAM_CAPTURE_INVALIDATED = 901,\r\n};\r\n',
      aclScope: ['team:core'],
    });
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'gpu-core',
      branch: 'main',
      path: 'config/runtime.toml',
      content: '[cuda]\r\nfatal = "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED"\r\n',
      aclScope: ['team:core'],
    });
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'gpu-core',
      branch: 'main',
      path: 'config/alerts.yaml',
      content: 'alerts:\r\n  - code: CUDA_ERROR_STREAM_CAPTURE_INVALIDATED\r\n',
      aclScope: ['team:core'],
    });
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'gpu-core',
      branch: 'main',
      path: 'src/handler.ts',
      content: 'export const ERR = "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED";\n',
      aclScope: ['team:core'],
    });

    // Add 40 unrelated noise files so trigram candidate pruning is exercised
    for (let i = 0; i < 40; i++) {
      index.upsertFile({
        tenantId: 'tenant-alpha',
        repoId: 'gpu-core',
        branch: 'main',
        path: `noise/mod_${i}.ts`,
        content: `export function unrelatedHelper${i}(x: number) { return x + ${i}; }\n`,
        aclScope: ['team:core'],
      });
    }

    const res = index.search({
      query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED',
      kind: 'exact',
      caseSensitive: true,
      access: ALPHA_ACCESS,
    });

    expect(res.stats.usedFastPath).toBe(true);
    expect(res.stats.authorizedDocs).toBe(44);
    expect(res.stats.candidateDocs).toBe(4);
    expect(res.hits.map(h => h.path).sort()).toEqual(plantedPaths.sort());
    for (const hit of res.hits) {
      expect(hit.excerpt).not.toContain('\r');
      expect(hit.excerpt).toContain('CUDA_ERROR_STREAM_CAPTURE_INVALIDATED');
      expect(hit.exactMatch).toBe(true);
    }
  });

  it('plans selective AND/OR regex trigrams soundly and ranks symbol definitions above references', () => {
    const andPlan = planRegexTrigrams('CUDA_ERROR_[A-Z_]+INVALIDATED');
    expect(andPlan.selective).toBe(true);
    expect(andPlan.mode).toBe('and');
    expect(andPlan.branches[0]).toEqual(['CUDA_ERROR_', 'INVALIDATED']);

    const orPlan = planRegexTrigrams('CUDA_ERROR_STREAM|ERR_SHARD_EPOCH');
    expect(orPlan.selective).toBe(true);
    expect(orPlan.mode).toBe('or');
    expect(orPlan.branches).toHaveLength(2);

    // Optional group before required literal must NOT drop matching docs
    const optPlan = planRegexTrigrams('(?:optional_)?REQUIRED_TOKEN_99');
    expect(optPlan.selective).toBe(true);
    expect(optPlan.branches[0]).toEqual(['REQUIRED_TOKEN_99']);

    const index = new TrigramCodeIndex();
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'core',
      branch: 'main',
      path: 'rust/planner.rs',
      content: [
        'pub fn validate_capture_graph(epoch: u64) -> bool { epoch > 0 }',
        'pub const CODE: &str = "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED";',
      ].join('\n'),
      aclScope: ['team:core'],
    });
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'core',
      branch: 'main',
      path: 'rust/caller.rs',
      content: [
        'fn run() {',
        '    let ok = validate_capture_graph(42);',
        '    let _ = ok;',
        '}',
      ].join('\n'),
      aclScope: ['team:core'],
    });
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'core',
      branch: 'main',
      path: 'ts/bridge.ts',
      content: 'export const X = "REQUIRED_TOKEN_99";\n',
      aclScope: ['team:core'],
    });

    const regexRes = index.search({
      query: 'CUDA_ERROR_[A-Z_]+INVALIDATED',
      kind: 'regex',
      caseSensitive: true,
      access: ALPHA_ACCESS,
    });
    expect(regexRes.stats.usedFastPath).toBe(true);
    expect(regexRes.hits).toHaveLength(1);
    expect(regexRes.hits[0].path).toBe('rust/planner.rs');

    const optRes = index.search({
      query: '(?:optional_)?REQUIRED_TOKEN_99',
      kind: 'regex',
      caseSensitive: true,
      access: ALPHA_ACCESS,
    });
    expect(optRes.hits).toHaveLength(1);
    expect(optRes.hits[0].path).toBe('ts/bridge.ts');

    const symRes = index.search({
      query: 'validate_capture_graph',
      kind: 'symbol',
      caseSensitive: true,
      access: ALPHA_ACCESS,
    });
    expect(symRes.hits.length).toBe(2);
    expect(symRes.hits[0].mark).toBe('definition');
    expect(symRes.hits[0].path).toBe('rust/planner.rs');
    expect(symRes.hits[1].mark).toBe('reference');
    expect(symRes.hits[1].path).toBe('rust/caller.rs');

    const pathRes = index.search({
      query: 'planner.rs',
      kind: 'path',
      caseSensitive: false,
      access: ALPHA_ACCESS,
    });
    expect(pathRes.hits).toHaveLength(1);
    expect(pathRes.hits[0].path).toBe('rust/planner.rs');
  });

  it('keeps exact-match fast path at rank #1 in hybrid mode', () => {
    const index = new TrigramCodeIndex();
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'core',
      branch: 'main',
      path: 'docs/boilerplate.md',
      content: Array.from({ length: 30 }, () => 'cuda stream capture error invalidated recovery').join('\n'),
      aclScope: ['team:core'],
    });
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'core',
      branch: 'main',
      path: 'cuda/exact.cu',
      content: 'return CUDA_ERROR_STREAM_CAPTURE_INVALIDATED;\n',
      aclScope: ['team:core'],
    });

    const res = index.search({
      query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED',
      kind: 'hybrid',
      caseSensitive: true,
      semanticBoostWeight: 0.2,
      access: ALPHA_ACCESS,
    });

    expect(res.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.hits[0].path).toBe('cuda/exact.cu');
    expect(res.hits[0].exactMatch).toBe(true);
    expect(res.hits[0].score).toBeGreaterThan(800);
  });

  it('supports incremental upsertFile (SHA-256 skip), deleteFile, and branch-delta freshness without polluting base branch', () => {
    const index = new TrigramCodeIndex();
    const first = index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'mcp',
      branch: 'main',
      path: 'src/a.ts',
      content: 'export const OLD_TOKEN = "LEGACY_ALPHA_1";\n',
      aclScope: ['team:core'],
    });
    expect(first.action).toBe('inserted');

    const skip = index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'mcp',
      branch: 'main',
      path: 'src/a.ts',
      content: 'export const OLD_TOKEN = "LEGACY_ALPHA_1";\n',
      aclScope: ['team:core'],
    });
    expect(skip.action).toBe('unchanged');

    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'mcp',
      branch: 'main',
      path: 'src/remove_me.ts',
      content: 'export const TO_DELETE = "DROP_ON_FEATURE_BRANCH";\n',
      aclScope: ['team:core'],
    });

    const delta = index.applyBranchDelta({
      tenantId: 'tenant-alpha',
      repoId: 'mcp',
      baseBranch: 'main',
      targetBranch: 'feat/new-capture',
      upserts: [
        {
          path: 'src/b.ts',
          content: 'export function freshBranchHandler() { return "FRESH_BRANCH_909"; }\n',
          aclScope: ['team:core'],
        },
      ],
      deletes: ['src/remove_me.ts'],
    });

    expect(delta.carriedUnchanged).toBe(1);
    expect(delta.upserted).toBe(1);

    const featAccess: TrigramAccessContext = {
      tenantId: 'tenant-alpha',
      allowedScopes: ['team:core'],
      branch: 'feat/new-capture',
    };

    // Feature branch sees carried file, new symbol, and does NOT see deleted file
    expect(index.search({ query: 'LEGACY_ALPHA_1', kind: 'exact', access: featAccess }).hits).toHaveLength(1);
    const symHits = index.search({ query: 'freshBranchHandler', kind: 'symbol', access: featAccess }).hits;
    expect(symHits).toHaveLength(1);
    expect(symHits[0].mark).toBe('definition');
    expect(index.search({ query: 'DROP_ON_FEATURE_BRANCH', kind: 'exact', access: featAccess }).hits).toHaveLength(0);

    // Base branch `main` stays untouched
    expect(index.search({ query: 'FRESH_BRANCH_909', kind: 'exact', access: ALPHA_ACCESS }).hits).toHaveLength(0);
    expect(index.search({ query: 'DROP_ON_FEATURE_BRANCH', kind: 'exact', access: ALPHA_ACCESS }).hits).toHaveLength(1);

    // Delete on main removes from main immediately
    expect(index.deleteFile('tenant-alpha', 'mcp', 'main', 'src/remove_me.ts')).toBe(true);
    expect(index.search({ query: 'DROP_ON_FEATURE_BRANCH', kind: 'exact', access: ALPHA_ACCESS }).hits).toHaveLength(0);
  });

  it('enforces strict pre-return multi-tenant ACL isolation across identical planted symbols and scopes', () => {
    const index = new TrigramCodeIndex();
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'repo-a',
      branch: 'main',
      path: 'src/alpha.cu',
      content: 'const char* E = "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED";\n',
      aclScope: ['team:alpha'],
    });
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'repo-secret',
      branch: 'main',
      path: 'src/restricted.cu',
      content: 'const char* E = "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED";\n',
      aclScope: ['team:security-only'],
    });
    index.upsertFile({
      tenantId: 'tenant-beta',
      repoId: 'repo-b',
      branch: 'main',
      path: 'src/beta.cu',
      content: 'const char* E = "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED";\nconst char* B = "BETA_PRIVATE_444";\n',
      aclScope: ['team:alpha', 'public'], // Even if scope name matches or is 'public', tenantId MUST isolate!
    });

    const alphaRes = index.search({
      query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED',
      kind: 'exact',
      access: {
        tenantId: 'tenant-alpha',
        allowedScopes: ['team:alpha'],
        branch: 'main',
      },
    });

    expect(alphaRes.stats.authorizedDocs).toBe(1);
    expect(alphaRes.stats.candidateDocs).toBe(1);
    expect(alphaRes.hits).toHaveLength(1);
    expect(alphaRes.hits[0].tenantId).toBe('tenant-alpha');
    expect(alphaRes.hits[0].path).toBe('src/alpha.cu');

    // Tenant Alpha probing Tenant Beta's exclusive string sees 0 authorized candidates and 0 hits
    const betaProbe = index.search({
      query: 'BETA_PRIVATE_444',
      kind: 'exact',
      access: {
        tenantId: 'tenant-alpha',
        allowedScopes: ['team:alpha', 'team:security-only'],
        branch: 'main',
      },
    });
    expect(betaProbe.hits).toHaveLength(0);
    expect(betaProbe.stats.candidateDocs).toBe(0);

    // allowedRepos restriction is also enforced pre-return
    const repoRestricted = index.search({
      query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED',
      kind: 'exact',
      access: {
        tenantId: 'tenant-alpha',
        allowedScopes: ['team:alpha', 'team:security-only'],
        allowedRepos: ['repo-secret'],
        branch: 'main',
      },
    });
    expect(repoRestricted.stats.authorizedDocs).toBe(1);
    expect(repoRestricted.hits).toHaveLength(1);
    expect(repoRestricted.hits[0].repoId).toBe('repo-secret');
  });

  it('proves derived index wipe and bit-identical deterministic rebuildability from canonical source blobs', () => {
    const blobs: TrigramSourceBlobInput[] = [
      {
        tenantId: 'tenant-alpha',
        repoId: 'core',
        branch: 'main',
        path: 'b/second.rs',
        content: 'pub fn alpha_fn() -> &\'static str { "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED" }\n',
        aclScope: ['team:core'],
      },
      {
        tenantId: 'tenant-alpha',
        repoId: 'core',
        branch: 'main',
        path: 'a/first.ts',
        content: 'export class AlphaIndex { key = "HIP_1347_TRIGRAM_GUARD"; }\n',
        aclScope: ['team:core'],
      },
    ];

    const indexA = new TrigramCodeIndex();
    const buildA = indexA.rebuildFromBlobs(blobs);

    // Wipe derived structures while keeping canonical blobs intact
    indexA.wipeDerivedIndex();
    expect(indexA.getStats().canonicalBlobCount).toBe(2);
    expect(indexA.getStats().indexedDocCount).toBe(0);
    expect(indexA.getStats().derivedIntact).toBe(false);

    // Rebuild from canonical sources -> bit-identical digest
    const rebuiltA = indexA.rebuildFromCanonicalSources();
    expect(rebuiltA.digest).toBe(buildA.digest);
    expect(indexA.getStats().derivedIntact).toBe(true);

    // Reverse input order in a brand-new index -> still bit-identical digest!
    const indexB = new TrigramCodeIndex();
    const buildB = indexB.rebuildFromBlobs([...blobs].reverse());
    expect(buildB.digest).toBe(buildA.digest);

    const hitsA = indexA.search({ query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED', access: ALPHA_ACCESS }).hits;
    const hitsB = indexB.search({ query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED', access: ALPHA_ACCESS }).hits;
    expect(hitsA).toEqual(hitsB);
  });

  it('resolves symlinked TMPDIR workspace roots safely via fs.realpathSync', () => {
    const baseTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trigram-symlink-')));
    const realWorkspace = path.join(baseTmp, 'real-repo');
    const symlinkWorkspace = path.join(baseTmp, 'symlink-repo');
    fs.mkdirSync(path.join(realWorkspace, 'cuda'), { recursive: true });
    fs.writeFileSync(
      path.join(realWorkspace, 'cuda', 'capture.cu'),
      'const int E = CUDA_ERROR_STREAM_CAPTURE_INVALIDATED;\r\n',
      'utf8'
    );
    fs.symlinkSync(realWorkspace, symlinkWorkspace, 'dir');

    try {
      const index = new TrigramCodeIndex();
      const stats = index.indexDirectory(symlinkWorkspace, {
        tenantId: 'tenant-alpha',
        repoId: 'symlink-test',
        branch: 'main',
        aclScope: ['team:core'],
      });
      expect(stats.resolvedRoot).toBe(fs.realpathSync(realWorkspace));
      expect(stats.filesIndexed).toBe(1);

      const res = index.search({
        query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED',
        kind: 'exact',
        access: ALPHA_ACCESS,
      });
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0].path).toBe('cuda/capture.cu');
    } finally {
      fs.rmSync(baseTmp, { recursive: true, force: true });
    }
  });

  it('maintains zero cross-tenant leakage under 10-tenant parallel Promise.all concurrency', async () => {
    const index = new TrigramCodeIndex();
    const tenantIds = Array.from({ length: 10 }, (_, i) => `tenant-${i}`);

    await Promise.all(
      tenantIds.map(async (tid, idx) => {
        index.upsertFile({
          tenantId: tid,
          repoId: `repo-${idx}`,
          branch: 'main',
          path: `src/service_${idx}.ts`,
          content: [
            `export const SHARED_ERR = "CUDA_ERROR_STREAM_CAPTURE_INVALIDATED";`,
            `export const TENANT_SECRET = "SECRET_MARKER_${tid}_ONLY";`,
            `export function handleTenant${idx}() { return TENANT_SECRET; }`,
          ].join('\n'),
          aclScope: [`scope:${tid}`],
        });
      })
    );

    const results = await Promise.all(
      tenantIds.map(async (tid, idx) => {
        const access: TrigramAccessContext = {
          tenantId: tid,
          allowedScopes: [`scope:${tid}`],
          branch: 'main',
        };
        const shared = index.search({
          query: 'CUDA_ERROR_STREAM_CAPTURE_INVALIDATED',
          kind: 'exact',
          access,
        });
        const own = index.search({
          query: `SECRET_MARKER_${tid}_ONLY`,
          kind: 'exact',
          access,
        });
        const neighborTid = tenantIds[(idx + 1) % tenantIds.length];
        const cross = index.search({
          query: `SECRET_MARKER_${neighborTid}_ONLY`,
          kind: 'exact',
          access,
        });
        return { tid, shared, own, cross };
      })
    );

    for (const r of results) {
      expect(r.shared.hits).toHaveLength(1);
      expect(r.shared.hits[0].tenantId).toBe(r.tid);
      expect(r.shared.stats.authorizedDocs).toBe(1);
      expect(r.own.hits).toHaveLength(1);
      expect(r.own.hits[0].tenantId).toBe(r.tid);
      expect(r.cross.hits).toHaveLength(0);
      expect(r.cross.stats.candidateDocs).toBe(0);
    }
  });

  it('documents honest negative regimes: short/wildcard regex fallback and embedding-only exact miss', () => {
    // 1. Short/wildcard regex fallback preserves 100% recall while reporting usedFastPath=false
    const index = new TrigramCodeIndex();
    index.upsertFile({
      tenantId: 'tenant-alpha',
      repoId: 'core',
      branch: 'main',
      path: 'src/short.ts',
      content: 'const ab = 1234;\nconst z = "a___b";\n',
      aclScope: ['team:core'],
    });

    const shortLit = index.search({ query: 'ab', kind: 'exact', access: ALPHA_ACCESS });
    expect(shortLit.stats.usedFastPath).toBe(false);
    expect(shortLit.stats.plan.mode).toBe('scan_fallback');
    expect(shortLit.hits).toHaveLength(1);

    const wildcardRe = index.search({ query: 'a.*b', kind: 'regex', access: ALPHA_ACCESS });
    expect(wildcardRe.stats.usedFastPath).toBe(false);
    expect(wildcardRe.stats.plan.mode).toBe('scan_fallback');
    expect(wildcardRe.hits).toHaveLength(2); // matches both `ab` and `a___b`

    // 2. Mini benchmark run verifies embedding-only negative control & boundary regimes end-to-end
    const report = runZoektBenchmark({
      seed: 1347,
      targetGeneratedLines: 10_000,
    });

    const zoekt = report.engines.find(e => e.engine === 'zoekt_trigram_session')!;
    const embed = report.engines.find(e => e.engine === 'embedding_only_negative')!;

    expect(zoekt.exactRecall).toBe(1);
    expect(zoekt.regexRecall).toBe(1);
    expect(zoekt.symbolRecall).toBe(1);
    expect(zoekt.downstreamTaskSuccessRate).toBe(1);
    expect(embed.exactRecall).toBeLessThan(zoekt.exactRecall);
    expect(embed.downstreamTaskSuccessRate).toBeLessThan(zoekt.downstreamTaskSuccessRate);

    expect(report.audit.tenantIsolationZeroLeakage).toBe(true);
    expect(report.audit.derivedRebuildBitIdentical).toBe(true);
    expect(report.incrementalAndBranch.branchFreshnessRecall).toBe(1);
    expect(report.incrementalAndBranch.baseBranchIsolationPassed).toBe(true);
    expect(report.boundaryRegimes.shortOrWildcardRegex.trigramFallbackCount).toBe(4);
    expect(report.boundaryRegimes.coldIndexAmortization.breakEvenQueryCount).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
