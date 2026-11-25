#!/usr/bin/env node
/**
 * CLI Benchmark Runner for HIP-1347 RepoGraph Architectural Reasoning (#37).
 * Run with: `npx tsx bench/repograph-eval.ts`
 */

import { evaluateRepoGraphBenchmark } from '../src/repograph/index.js';

const report = evaluateRepoGraphBenchmark();

console.log('=== HIP-1347 RepoGraph Change-Impact & Fault Localization Benchmark (#37) ===\n');
console.log('| Strategy | Impact F1 | Precision | Recall | False Path Rate | Root-Cause Top-1 | MRR | Repair Rate | Mean Tokens | Mean / p95 (ms) |');
console.log('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const agg of report.aggregates) {
  console.log(
    `| \`${agg.strategy}\` | ${agg.meanImpactF1Pct.toFixed(2)}% | ${agg.meanImpactPrecisionPct.toFixed(2)}% | ${agg.meanImpactRecallPct.toFixed(2)}% | ${agg.meanFalseDependencyPathPct.toFixed(2)}% | ${agg.rootCauseTop1AccuracyPct.toFixed(2)}% | ${agg.rootCauseMrr.toFixed(4)} | ${agg.guidedRepairSuccessRatePct.toFixed(2)}% | ${agg.meanContextTokens.toFixed(1)} | ${agg.meanLatencyMs.toFixed(3)} / ${agg.p95LatencyMs.toFixed(3)} |`
  );
}

console.log('\n=== Per-Scenario Breakdown ===\n');
console.log('| Scenario ID | Lang | Strategy | Impact F1 | False Paths | Root-Cause Rank | Repaired |');
console.log('| :--- | :--- | :--- | ---: | ---: | :---: | :---: |');
for (const row of report.scenarios) {
  console.log(
    `| \`${row.scenarioId}\` | ${row.language} | \`${row.strategy}\` | ${(row.impactF1 * 100).toFixed(1)}% | ${row.falsePathRatePct.toFixed(1)}% | ${row.rootCauseRank ?? 'miss'} | ${row.repairSucceeded ? 'yes' : 'no'} |`
  );
}

console.log('\n=== Negative Control (Isolated Scripts) ===');
console.log(JSON.stringify(report.negativeControl, null, 2));
