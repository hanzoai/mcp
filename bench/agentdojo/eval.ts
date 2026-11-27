#!/usr/bin/env npx tsx
/**
 * Reproducible AgentDojo Prompt-Injection Resistance Benchmark CLI for `@hanzo/mcp` (HIP-1348).
 *
 * Usage:
 *   npx tsx bench/agentdojo/eval.ts
 *   npx tsx bench/agentdojo/eval.ts --seed 1348 --out-dir docs/research/hip-1348-agentdojo
 *   npx tsx bench/agentdojo/eval.ts --external-agentdojo-json path/to/suite.json
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  loadExternalAgentDojoJson,
  renderScoreTableMarkdown,
  runAgentDojoBenchmark,
} from '../../src/security/agentdojo-benchmark.js';

function parseArgs(argv: string[]): {
  seed: number;
  externalJson?: string;
  outDir?: string;
  jsonOnly: boolean;
} {
  let seed = 1348;
  let externalJson: string | undefined;
  let outDir: string | undefined;
  let jsonOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed' && argv[i + 1]) {
      seed = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(seed)) {
        throw new Error(`Invalid --seed value: ${argv[i]}`);
      }
    } else if (arg === '--external-agentdojo-json' && argv[i + 1]) {
      externalJson = argv[++i];
    } else if (arg === '--out-dir' && argv[i + 1]) {
      outDir = argv[++i];
    } else if (arg === '--json') {
      jsonOnly = true;
    }
  }

  return { seed, externalJson, outDir, jsonOnly };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const scenarios = opts.externalJson
    ? await loadExternalAgentDojoJson(opts.externalJson)
    : undefined;

  const report = await runAgentDojoBenchmark({
    seed: opts.seed,
    scenarios,
    externalSourcePath: opts.externalJson ? path.basename(opts.externalJson) : undefined,
  });

  const markdown = renderScoreTableMarkdown(report);

  if (opts.outDir) {
    await fs.mkdir(opts.outDir, { recursive: true });
    await fs.writeFile(
      path.join(opts.outDir, 'raw_results.json'),
      JSON.stringify(report, null, 2) + '\n',
      'utf8'
    );
    await fs.writeFile(path.join(opts.outDir, 'score_table.md'), markdown, 'utf8');
  }

  if (opts.jsonOnly) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(markdown);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
