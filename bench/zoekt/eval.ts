#!/usr/bin/env tsx
/**
 * CLI runner for the HIP-1347 Zoekt Trigram Code Search benchmark suite.
 *
 * Usage:
 *   pnpm exec tsx bench/zoekt/eval.ts --seed 1347 --out-dir docs/research/hip-1347-zoekt
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  renderZoektResearchReadme,
  renderZoektScoreTableMarkdown,
  runZoektBenchmark,
} from '../../src/search/zoekt-benchmark.js';

function parseArgs(argv: readonly string[]): {
  seed: number;
  lines: number;
  outDir: string;
} {
  let seed = 1347;
  let lines = 120_000;
  let outDir = 'docs/research/hip-1347-zoekt';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed' && argv[i + 1]) {
      seed = Number.parseInt(argv[++i], 10);
    } else if (arg === '--lines' && argv[i + 1]) {
      lines = Number.parseInt(argv[++i], 10);
    } else if (arg === '--out-dir' && argv[i + 1]) {
      outDir = argv[++i];
    }
  }

  return {
    seed: Number.isFinite(seed) ? seed : 1347,
    lines: Number.isFinite(lines) && lines >= 10_000 ? lines : 120_000,
    outDir,
  };
}

function main(): void {
  const { seed, lines, outDir } = parseArgs(process.argv.slice(2));
  const repoRoot = fs.realpathSync(process.cwd());
  const report = runZoektBenchmark({
    seed,
    targetGeneratedLines: lines,
    repoRoot,
  });

  const absOutDir = path.resolve(repoRoot, outDir);
  fs.mkdirSync(absOutDir, { recursive: true });

  const rawPath = path.join(absOutDir, 'raw_results.json');
  const scoreTablePath = path.join(absOutDir, 'score_table.md');
  const readmePath = path.join(absOutDir, 'README.md');

  const scoreTableMd = renderZoektScoreTableMarkdown(report);
  const readmeMd = renderZoektResearchReadme(report);

  fs.writeFileSync(rawPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(scoreTablePath, scoreTableMd, 'utf8');
  fs.writeFileSync(readmePath, readmeMd, 'utf8');

  console.log(scoreTableMd);
  console.log(`Artifacts written to ${outDir}:`);
  console.log(`  - ${path.join(outDir, 'raw_results.json')}`);
  console.log(`  - ${path.join(outDir, 'score_table.md')}`);
  console.log(`  - ${path.join(outDir, 'README.md')}`);
}

main();
