#!/usr/bin/env tsx
/**
 * CLI Runner for the ToolEmu Risky-Tool Effect Simulation Benchmark (HIP-1348 / HIP-1347).
 *
 * Usage:
 *   pnpm exec tsx bench/toolemu/eval.ts --seed 1348 --out-dir docs/research/hip-1348-toolemu
 *   pnpm exec tsx bench/toolemu/eval.ts --seed 1348 --json
 *   pnpm exec tsx bench/toolemu/eval.ts --external-toolemu-json /path/to/cases.json --json
 */

import * as fsSync from 'fs';
import * as path from 'path';
import {
  renderHip1348ResearchReadme,
  renderToolEmuScoreTableMarkdown,
  runToolEmuBenchmark,
} from '../../src/security/toolemu-benchmark.js';

interface CliArgs {
  seed: number;
  outDir?: string;
  json: boolean;
  externalJson?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { seed: 1348, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed)) args.seed = parsed;
    } else if (a === '--out-dir' && argv[i + 1]) {
      args.outDir = argv[++i];
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--external-toolemu-json' && argv[i + 1]) {
      args.externalJson = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx bench/toolemu/eval.ts [--seed <int>] [--out-dir <dir>] [--json] [--external-toolemu-json <path>]'
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const report = await runToolEmuBenchmark({
    seed: cli.seed,
    externalCasesPath: cli.externalJson,
  });

  if (cli.outDir) {
    const outPath = path.resolve(cli.outDir);
    fsSync.mkdirSync(outPath, { recursive: true });
    fsSync.writeFileSync(
      path.join(outPath, 'raw_results.json'),
      JSON.stringify(report, null, 2) + '\n',
      'utf8'
    );
    fsSync.writeFileSync(
      path.join(outPath, 'score_table.md'),
      renderToolEmuScoreTableMarkdown(report) + '\n',
      'utf8'
    );
    fsSync.writeFileSync(
      path.join(outPath, 'README.md'),
      renderHip1348ResearchReadme(report) + '\n',
      'utf8'
    );
  }

  if (cli.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderToolEmuScoreTableMarkdown(report));
    if (cli.outDir) {
      console.log(`\nArtifacts written to: ${path.resolve(cli.outDir)}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
