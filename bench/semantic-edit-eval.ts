#!/usr/bin/env node
/**
 * CLI Benchmark Runner for HIP-1347 Semantic Change Planner (#38).
 * Run with: `npx tsx bench/semantic-edit-eval.ts`
 */

import { evaluateSemanticEditBenchmark } from '../src/semantic-edit/index.js';

const report = evaluateSemanticEditBenchmark();

console.log('=== HIP-1347 Semantic Change Planner Benchmark (#38) ===\n');
console.log('| Strategy | Success Rate | Compile Failures | Regression Escapes | Mean Tests / Change | Test Reduction | Mean Planner (ms) | Mean / p50 / p95 Total (ms) |');
console.log('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const agg of report.aggregates) {
  console.log(
    `| \`${agg.strategy}\` | ${agg.refactoringSuccessRatePct.toFixed(2)}% | ${agg.compileFailureRatePct.toFixed(2)}% | ${agg.regressionEscapeRatePct.toFixed(2)}% | ${agg.meanTestsPerChange.toFixed(2)} / 12 | ${agg.testReductionVsFullPct.toFixed(2)}% | ${agg.meanPlannerLatencyMs.toFixed(3)} | ${agg.meanEndToEndCompletionMs.toFixed(2)} / ${agg.p50TotalCompletionMs.toFixed(2)} / ${agg.p95TotalCompletionMs.toFixed(2)} |`
  );
}

console.log('\n=== Per-Task Breakdown ===\n');
console.log('| Task ID | Lang | Strategy | Succeeded | Compile Fail | Escaped | Tests Run |');
console.log('| :--- | :--- | :--- | :---: | :---: | :---: | ---: |');
for (const row of report.primaryTasks) {
  console.log(
    `| \`${row.taskId}\` | ${row.language} | \`${row.strategy}\` | ${row.refactoringSucceeded ? 'yes' : 'no'} | ${row.compileFailed ? 'yes' : 'no'} | ${row.regressionEscaped ? 'YES' : 'no'} | ${row.testsExecuted} |`
  );
}

console.log('\n=== Negative Controls (Comment/Formatting-Only Edits) ===');
console.log(JSON.stringify(report.negativeControls, null, 2));
