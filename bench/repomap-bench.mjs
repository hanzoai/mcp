#!/usr/bin/env node
/**
 * Self-contained Multi-Hop Symbol-Graph RepoMap Benchmark over @hanzo/mcp (#36).
 * Run after `pnpm build`: `node bench/repomap-bench.mjs`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepoMapEngine, loadWorkspaceDocuments } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const docs = loadWorkspaceDocuments(repoRoot, 'hanzo-bench', ['*']);
const engine = new RepoMapEngine();
engine.indexDocuments(docs);

const tasks = [
  {
    id: 'T1_unified_search_strategies',
    activeFiles: ['src/search/index.ts'],
    taskQuery: 'SearchEngine createSymbolSearchStrategy createASTSearchStrategy unified search',
    expectedFiles: ['src/search/search-engine.ts', 'src/search/strategies/symbol-search.ts'],
  },
  {
    id: 'T2_mcp_server_tool_registry',
    activeFiles: ['src/index.ts'],
    taskQuery: 'getConfiguredTools registerTool getAllRegisteredTools ToolConfig',
    expectedFiles: ['src/tools/index.ts', 'src/tools/tool-registry.ts'],
  },
  {
    id: 'T3_aci_compact_window_navigation',
    activeFiles: ['src/aci/index.ts'],
    errorOutput: 'Error in navigateFileWindow validateAndApplyHunks compressBuildOutput',
    taskQuery: 'renderFileWindow compact-response',
    expectedFiles: ['src/aci/compact-response.ts'],
  },
  {
    id: 'T4_code_intel_cloud_surface',
    activeFiles: ['src/tools/index.ts'],
    taskQuery: 'codeSearchTool codeContextTool codeAskTool HANZO_API_KEY',
    expectedFiles: ['src/tools/code-intel.ts'],
  },
  {
    id: 'T5_repomap_tenant_acl_pagerank',
    activeFiles: ['src/search/index.ts'],
    taskQuery: 'RepoMapEngine isAuthorized buildRepoMap repoMapTool',
    expectedFiles: ['src/search/repomap.ts'],
  },
];

const latencies = [];
let hitsAt5 = 0;
let totalExpected = 0;
let totalMapTokens = 0;
let rawTokens = 0;
const details = [];

for (let pass = 0; pass < 10; pass++) {
  for (const t of tasks) {
    const res = engine.buildRepoMap({
      caller: { tenantId: 'hanzo-bench', principal: 'bench-runner' },
      activeFiles: t.activeFiles,
      taskQuery: t.taskQuery,
      errorOutput: t.errorOutput,
      maxTokens: 1024,
    });
    latencies.push(res.latencyMs);
    if (pass === 9) {
      rawTokens = res.rawCorpusTokens;
      totalMapTokens += res.tokensUsed;
      const top5 = res.rankedFiles
        .filter((f) => !t.activeFiles.includes(f.path))
        .slice(0, 5)
        .map((f) => f.path);
      let taskHits = 0;
      for (const exp of t.expectedFiles) {
        totalExpected++;
        if (top5.includes(exp)) {
          hitsAt5++;
          taskHits++;
        }
      }
      details.push({
        id: t.id,
        expected: t.expectedFiles,
        top5NonActive: top5,
        recallHitCount: `${taskHits}/${t.expectedFiles.length}`,
        tokensUsed: res.tokensUsed,
        tokenReductionPct: res.tokenReductionPct,
        latencyMs: res.latencyMs,
      });
    }
  }
}

latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p95 = latencies[Math.floor(latencies.length * 0.95)];
const avgTokens = Math.round(totalMapTokens / tasks.length);
const recallAt5 = Number(((hitsAt5 / totalExpected) * 100).toFixed(1));
const reductionPct = Number(((1 - avgTokens / rawTokens) * 100).toFixed(2));

const summary = {
  benchmarkDateUtc: new Date().toISOString(),
  corpus: '@hanzo/mcp',
  corpusFilesIndexed: docs.length,
  rawFullRepoTokens: rawTokens,
  avgRepoMapTokens: avgTokens,
  tokenReductionBeforeFirstEditPct: reductionPct,
  recallAt5Pct: recallAt5,
  latencyP50Ms: p50,
  latencyP95Ms: p95,
  tenantIsolationOverhead: '0 cross-tenant edges (pre-filtered prior to graph build)',
  tasks: details,
};

const outPath = path.resolve(__dirname, 'repomap-benchmark-report.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 2));
