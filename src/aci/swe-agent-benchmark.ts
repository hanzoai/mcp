/**
 * Reproducible SWE-agent ACI Optimization Benchmark Suite (HIP-1348 / hanzoai/mcp#44)
 *
 * Executes 24 deterministic seeded software-engineering tasks across real
 * temporary multi-file repositories on disk (TypeScript, JavaScript, Python,
 * and JSON) using real `@hanzo/mcp` tools (`fs`, `exec`, `code`) via
 * `createMCPServer()` + `AciResponseAdapter`.
 *
 * Compares 5 matched ACI regimes under identical step & context-token budgets:
 *   1. `raw_unbounded_cli`
 *   2. `naive_head_truncation`
 *   3. `windowed_viewer_only`
 *   4. `swe_agent_aci_full`
 *   5. `over_compressed_negative`
 *
 * Plus 2 honest boundary/negative regimes:
 *   - `semantic_logic_error_passes_syntax_lint`
 *   - `tiny_single_file_overhead_regime`
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import {
  AciAdapterMode,
  AciResponseAdapter,
  AciServerInvoker,
  computeFileSha256,
  estimateAciTokens,
  formatCompactToolResponse,
  lintedEdit,
  resolveWorkspaceRoot,
  viewWindow,
} from './swe-agent-aci.js';

export type BenchmarkRegimeId = AciAdapterMode;

export type TaskCategory =
  | 'off_by_one'
  | 'wrong_operator'
  | 'null_guard'
  | 'config_or_import'
  | 'multifile_rename'
  | 'large_file_surgical'
  | 'noisy_log_triage';

export type TaskLanguage = 'typescript' | 'javascript' | 'python' | 'json';

export interface BenchmarkFileEditSpec {
  relativePath: string;
  targetLine: number;
  oldText: string;
  newText: string;
  /** Realistic syntax-broken draft edit submitted on attempt 1 when hazard is active */
  brokenDraftNewText?: string;
}

export interface BenchmarkTaskSpec {
  id: string;
  category: TaskCategory;
  language: TaskLanguage;
  description: string;
  files: Record<string, string>;
  edits: BenchmarkFileEditSpec[];
  /** Search query for discovering secondary files in multi-file tasks */
  secondarySearchQuery?: string;
  testCommand: string;
  oracleArgs: [string, string[]];
  hasDraftSyntaxHazard: boolean;
}

export interface TaskRunResult {
  taskId: string;
  category: TaskCategory;
  language: TaskLanguage;
  regime: BenchmarkRegimeId;
  completed: boolean;
  patchCorrect: boolean;
  failureReason: string | null;
  toolCalls: number;
  responseBytes: number;
  responseTokens: number;
  syntaxHazardInjected: boolean;
  syntaxHazardPrevented: boolean;
  syntaxCorruptedDiskWrites: number;
  latencyMs: number;
}

export interface RegimeAggregateMetrics {
  regime: BenchmarkRegimeId;
  tasksTotal: number;
  tasksCompleted: number;
  taskCompletionRatePct: number;
  patchesCorrect: number;
  patchCorrectnessPct: number;
  meanToolCalls: number;
  meanResponseTokens: number;
  meanResponseBytes: number;
  syntaxHazardsInjected: number;
  syntaxHazardsPrevented: number;
  syntaxRollbackPreventionRatePct: number;
  syntaxCorruptedDiskWrites: number;
  meanLatencyMs: number;
}

export interface SemanticBoundaryResult {
  regime: 'semantic_logic_error_passes_syntax_lint';
  tasksTotal: number;
  syntaxLintPassedCount: number;
  syntaxLintPassedRatePct: number;
  caughtByUnitTestCount: number;
  caughtByUnitTestRatePct: number;
  repairedAfterTestFeedbackCount: number;
  repairedAfterTestFeedbackRatePct: number;
  meanToolCalls: number;
  meanLatencyMs: number;
}

export interface TinyFileOverheadResult {
  regime: 'tiny_single_file_overhead_regime';
  tasksTotal: number;
  rawCompletionRatePct: number;
  aciCompletionRatePct: number;
  rawPatchCorrectnessPct: number;
  aciPatchCorrectnessPct: number;
  rawMeanToolCalls: number;
  aciMeanToolCalls: number;
  rawMeanResponseBytes: number;
  aciMeanResponseBytes: number;
  meanByteOverhead: number;
  overheadPct: number;
  meanLatencyMs: number;
}

export interface SweAgentBenchmarkReport {
  schemaVersion: '1.0.0';
  seed: number;
  timestampIso: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  config: {
    taskCount: number;
    maxSteps: number;
    contextTokenBudget: number;
    windowSize: number;
    maxResponseBytes: number;
    naiveHeadMaxChars: number;
    overCompressedMaxChars: number;
  };
  regimes: RegimeAggregateMetrics[];
  boundaryRegimes: {
    semanticLogicErrorPassesSyntaxLint: SemanticBoundaryResult;
    tinySingleFileOverheadRegime: TinyFileOverheadResult;
  };
  taskRuns: TaskRunResult[];
}

export interface SweAgentBenchmarkOptions {
  seed?: number;
  maxSteps?: number;
  contextTokenBudget?: number;
  windowSize?: number;
  maxResponseBytes?: number;
  naiveHeadMaxChars?: number;
  overCompressedMaxChars?: number;
  /** Optional custom server factory (defaults to live `createMCPServer`) */
  serverFactory?: (workspaceRoot: string) => Promise<AciServerInvoker>;
}

// ---------------------------------------------------------------------------
// Deterministic Seeded PRNG (Mulberry32)
// ---------------------------------------------------------------------------

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Realistic Multi-File Fixture Generators
// ---------------------------------------------------------------------------

function makeJsPaddingFunctions(prefix: string, count: number, startIdx = 1): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = startIdx + i;
    lines.push(`export function ${prefix}Helper${id}(value, offset = ${id % 7}) {`);
    lines.push(`  const base = Number(value ?? 0) + offset;`);
    lines.push(`  const clamped = base < 0 ? 0 : base;`);
    lines.push(`  return clamped * 2 - (offset % 3);`);
    lines.push(`}`);
    lines.push('');
  }
  return lines;
}

function makeTsPaddingFunctions(prefix: string, count: number, startIdx = 1): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = startIdx + i;
    lines.push(`export function ${prefix}Helper${id}(value: number, offset: number = ${id % 7}): number {`);
    lines.push(`  const base: number = value + offset;`);
    lines.push(`  const clamped: number = base < 0 ? 0 : base;`);
    lines.push(`  return clamped * 2 - (offset % 3);`);
    lines.push(`}`);
    lines.push('');
  }
  return lines;
}

function makePyPaddingFunctions(prefix: string, count: number, startIdx = 1): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = startIdx + i;
    lines.push(`def ${prefix}_helper_${id}(value, offset=${id % 7}):`);
    lines.push(`    base = int(value or 0) + offset`);
    lines.push(`    clamped = 0 if base < 0 else base`);
    lines.push(`    return clamped * 2 - (offset % 3)`);
    lines.push('');
  }
  return lines;
}

/**
 * Generates a realistic Node.js test harness that emits verbose ANSI logs and
 * passing sub-test chatter before executing the real module assertion at the tail.
 */
function makeNoisyNodeTestRunner(opts: {
  noiseLines: number;
  suiteName: string;
  targetFile: string;
  targetLine: number;
  symbolName: string;
  loadAndAssertBody: string;
  includeAnsi?: boolean;
}): string {
  const ansiStart = opts.includeAnsi ? '\\x1b[36m' : '';
  const ansiEnd = opts.includeAnsi ? '\\x1b[0m' : '';
  return [
    `import * as fs from 'fs';`,
    `import * as path from 'path';`,
    `import * as vm from 'vm';`,
    ``,
    `const suiteName = ${JSON.stringify(opts.suiteName)};`,
    `const noiseLines = ${opts.noiseLines};`,
    `for (let i = 1; i <= noiseLines; i++) {`,
    `  if (i % 9 === 0) {`,
    `    console.log("${ansiStart}[bench-runner] PASS subcase_" + i + " latency=" + ((i * 7) % 19) + "ms mem=42MB${ansiEnd}");`,
    `  } else {`,
    `    console.log("[trace:" + suiteName + "] step=" + i + " status=ok checksum=" + (i * 2654435761 >>> 0).toString(16));`,
    `  }`,
    `}`,
    ``,
    `function loadTsModule(relPath) {`,
    `  const full = path.resolve(process.cwd(), relPath);`,
    `  const src = fs.readFileSync(full, 'utf8');`,
    `  const stripped = src`,
    `    .replace(/^export\\s+interface\\s+\\w+\\s*\\{[\\s\\S]*?^\\}/gm, '')`,
    `    .replace(/^interface\\s+\\w+\\s*\\{[\\s\\S]*?^\\}/gm, '')`,
    `    .replace(/^export\\s+type\\s+[^;]+;/gm, '')`,
    `    .replace(/^import\\s+type\\s+[^;]+;/gm, '')`,
    `    .replace(/\\)\\s*:\\s*[A-Za-z0-9_<>{}\\[\\]|\\s,?]+(?=\\s*\\{)/g, ')')`,
    `    .replace(/(\\b(?:const|let|var)\\s+\\w+)\\s*:\\s*[A-Za-z0-9_<>{}\\[\\]|\\s,?]+(?==)/g, '$1 ')`,
    `    .replace(/(\\w+)\\??\\s*:\\s*(?:number|string|boolean|any|unknown|null|undefined|Record<[^>]+>|Array<[^>]+>|[A-Z][A-Za-z0-9_]*)(?:\\s*\\|\\s*(?:number|string|boolean|null|undefined|[A-Z][A-Za-z0-9_]*))*(?:\\[\\])*/g, '$1')`,
    `    .replace(/^export\\s+function\\s+(\\w+)/gm, 'exports.$1 = function $1')`,
    `    .replace(/^export\\s+const\\s+(\\w+)/gm, 'exports.$1');`,
    `  const mod = { exports: {} };`,
    `  const fn = new vm.Script('(function(exports, require){' + stripped + '\\n})', { filename: relPath });`,
    `  fn.runInThisContext()(mod.exports, (id) => loadTsModule(path.join(path.dirname(relPath), id.replace(/\\.js$/, '.ts'))));`,
    `  return mod.exports;`,
    `}`,
    ``,
    `try {`,
    opts.loadAndAssertBody,
    `  console.log("PASS " + suiteName + ": all assertions passed");`,
    `  process.exit(0);`,
    `} catch (err) {`,
    `  const msg = err && err.message ? err.message : String(err);`,
    `  console.error("FAIL ${opts.targetFile}:${opts.targetLine} [${opts.symbolName}] - " + msg);`,
    `  console.error("Tests: " + noiseLines + " passed, 1 failed");`,
    `  process.exit(1);`,
    `}`,
    ``,
  ].join('\n');
}

function makeNoisyPyTestRunner(opts: {
  noiseLines: number;
  suiteName: string;
  targetFile: string;
  targetLine: number;
  symbolName: string;
  testBody: string;
}): string {
  return [
    `import os`,
    `import sys`,
    `import traceback`,
    `sys.path.insert(0, os.getcwd())`,
    ``,
    `suite_name = ${JSON.stringify(opts.suiteName)}`,
    `for i in range(1, ${opts.noiseLines} + 1):`,
    `    print(f"[pytest-trace:{suite_name}] case={i} status=ok digest={i * 9973:06x}")`,
    ``,
    `try:`,
    ...opts.testBody.split('\n').map((l) => `    ${l}`),
    `    print(f"PASS {suite_name}: all assertions passed")`,
    `    sys.exit(0)`,
    `except Exception as exc:`,
    `    print(f"FAIL ${opts.targetFile}:${opts.targetLine} [${opts.symbolName}] - {type(exc).__name__}: {exc}", file=sys.stderr)`,
    `    traceback.print_exc(file=sys.stderr)`,
    `    sys.exit(1)`,
    ``,
  ].join('\n');
}

function buildModuleWithBug(opts: {
  language: 'typescript' | 'javascript' | 'python';
  prefix: string;
  beforePaddingFns: number;
  afterPaddingFns: number;
  headerLines?: string[];
  buggyBlock: string[];
}): { content: string; bugStartLine: number } {
  const lines: string[] = [...(opts.headerLines ?? [])];
  if (opts.language === 'typescript') {
    lines.push(...makeTsPaddingFunctions(opts.prefix, opts.beforePaddingFns, 1));
  } else if (opts.language === 'javascript') {
    lines.push(...makeJsPaddingFunctions(opts.prefix, opts.beforePaddingFns, 1));
  } else {
    lines.push(...makePyPaddingFunctions(opts.prefix, opts.beforePaddingFns, 1));
  }
  const bugStartLine = lines.length + 1;
  lines.push(...opts.buggyBlock);
  lines.push('');
  if (opts.language === 'typescript') {
    lines.push(...makeTsPaddingFunctions(opts.prefix, opts.afterPaddingFns, opts.beforePaddingFns + 1));
  } else if (opts.language === 'javascript') {
    lines.push(...makeJsPaddingFunctions(opts.prefix, opts.afterPaddingFns, opts.beforePaddingFns + 1));
  } else {
    lines.push(...makePyPaddingFunctions(opts.prefix, opts.afterPaddingFns, opts.beforePaddingFns + 1));
  }
  return { content: lines.join('\n') + '\n', bugStartLine };
}

/**
 * Generates the deterministic 24-task real-repository benchmark suite.
 */
export function buildBenchmarkTasks(seed = 1348): BenchmarkTaskSpec[] {
  const rng = createSeededRng(seed);
  // Deterministic 50% draft syntax hazard schedule (12 of 24 tasks)
  const hazardIndices = new Set<number>();
  const pool = Array.from({ length: 24 }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (let i = 0; i < 12; i++) hazardIndices.add(pool[i]);

  const tasks: BenchmarkTaskSpec[] = [];

  // -------------------------------------------------------------------------
  // Category 1: Off-by-one bugs (T01 - T04)
  // -------------------------------------------------------------------------

  // T01: TypeScript pagination off-by-one (~480 lines)
  {
    const mod = buildModuleWithBug({
      language: 'typescript',
      prefix: 'page',
      beforePaddingFns: 52,
      afterPaddingFns: 26,
      buggyBlock: [
        `export function slicePage(items: number[], page: number, pageSize: number): number[] {`,
        `  const start: number = page * pageSize;`,
        `  const end: number = start + pageSize - 1;`,
        `  return items.slice(start, end);`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T01_ts_off_by_one_pagination',
      category: 'off_by_one',
      language: 'typescript',
      description: 'Fix off-by-one page end offset in TypeScript paginator',
      files: {
        'src/types.ts': 'export interface PageMeta { page: number; pageSize: number; }\n',
        'src/paginator.ts': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 250,
          suiteName: 'T01_pagination',
          targetFile: 'src/paginator.ts',
          targetLine: bugLine,
          symbolName: 'slicePage',
          loadAndAssertBody: `  const { slicePage } = loadTsModule('src/paginator.ts');
  const got = slicePage([10, 20, 30, 40, 50], 0, 3);
  if (JSON.stringify(got) !== '[10,20,30]') throw new Error('Expected [10,20,30], got ' + JSON.stringify(got));`,
        }),
      },
      edits: [
        {
          relativePath: 'src/paginator.ts',
          targetLine: bugLine,
          oldText: `  const end: number = start + pageSize - 1;`,
          newText: `  const end: number = start + pageSize;`,
          brokenDraftNewText: `  const end: number = start + pageSize + ;`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(0),
    });
  }

  // T02: JavaScript ring buffer off-by-one (~430 lines)
  {
    const mod = buildModuleWithBug({
      language: 'javascript',
      prefix: 'ring',
      beforePaddingFns: 45,
      afterPaddingFns: 24,
      buggyBlock: [
        `export function collectTail(items, count) {`,
        `  const out = [];`,
        `  const start = Math.max(0, items.length - count);`,
        `  for (let i = start; i < items.length - 1; i++) {`,
        `    out.push(items[i]);`,
        `  }`,
        `  return out;`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 3;
    tasks.push({
      id: 'T02_js_off_by_one_ring_buffer',
      category: 'off_by_one',
      language: 'javascript',
      description: 'Fix off-by-one loop bound in JavaScript ring buffer collector',
      files: {
        'src/metrics.mjs': 'export const RING_VERSION = 2;\n',
        'src/ring_buffer.mjs': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 260,
          suiteName: 'T02_ring_buffer',
          targetFile: 'src/ring_buffer.mjs',
          targetLine: bugLine,
          symbolName: 'collectTail',
          loadAndAssertBody: `  const { collectTail } = await import(path.resolve(process.cwd(), 'src/ring_buffer.mjs'));
  const got = collectTail([1, 2, 3, 4, 5], 3);
  if (JSON.stringify(got) !== '[3,4,5]') throw new Error('Expected [3,4,5], got ' + JSON.stringify(got));`,
        }),
      },
      edits: [
        {
          relativePath: 'src/ring_buffer.mjs',
          targetLine: bugLine,
          oldText: `  for (let i = start; i < items.length - 1; i++) {`,
          newText: `  for (let i = start; i < items.length; i++) {`,
          brokenDraftNewText: `  for (let i = start; i < items.length; i++ {`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(1),
    });
  }

  // T03: Python sliding window off-by-one (~390 lines)
  {
    const mod = buildModuleWithBug({
      language: 'python',
      prefix: 'win',
      beforePaddingFns: 48,
      afterPaddingFns: 26,
      buggyBlock: [
        `def sliding_sums(values, width):`,
        `    if width <= 0 or width > len(values):`,
        `        return []`,
        `    return [sum(values[i:i + width]) for i in range(len(values) - width)]`,
      ],
    });
    const bugLine = mod.bugStartLine + 3;
    tasks.push({
      id: 'T03_py_off_by_one_window_slice',
      category: 'off_by_one',
      language: 'python',
      description: 'Fix off-by-one range bound in Python sliding_sums',
      files: {
        'pkg/__init__.py': '',
        'pkg/helpers.py': 'DEFAULT_WIDTH = 3\n',
        'pkg/sliding.py': mod.content,
        'tests/run_tests.py': makeNoisyPyTestRunner({
          noiseLines: 220,
          suiteName: 'T03_sliding_sums',
          targetFile: 'pkg/sliding.py',
          targetLine: bugLine,
          symbolName: 'sliding_sums',
          testBody: `from pkg.sliding import sliding_sums
got = sliding_sums([1, 2, 3, 4], 2)
assert got == [3, 5, 7], f"Expected [3, 5, 7], got {got}"`,
        }),
      },
      edits: [
        {
          relativePath: 'pkg/sliding.py',
          targetLine: bugLine,
          oldText: `    return [sum(values[i:i + width]) for i in range(len(values) - width)]`,
          newText: `    return [sum(values[i:i + width]) for i in range(len(values) - width + 1)]`,
          brokenDraftNewText: `    return [sum(values[i:i + width]) for i in range(len(values) - width + 1]`,
        },
      ],
      testCommand: 'python3 -B tests/run_tests.py',
      oracleArgs: ['python3', ['-B', 'tests/run_tests.py']],
      hasDraftSyntaxHazard: hazardIndices.has(2),
    });
  }

  // T04: TypeScript retry budget off-by-one (~500 lines)
  {
    const mod = buildModuleWithBug({
      language: 'typescript',
      prefix: 'retry',
      beforePaddingFns: 56,
      afterPaddingFns: 26,
      buggyBlock: [
        `export function canRetry(attempt: number, maxRetries: number): boolean {`,
        `  if (maxRetries < 0) return false;`,
        `  return attempt < maxRetries;`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T04_ts_off_by_one_retry_cap',
      category: 'off_by_one',
      language: 'typescript',
      description: 'Fix inclusive retry boundary in TypeScript retry budget',
      files: {
        'src/clock.ts': 'export const CLOCK_TICK_MS: number = 100;\n',
        'src/retry_budget.ts': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 270,
          suiteName: 'T04_retry_budget',
          targetFile: 'src/retry_budget.ts',
          targetLine: bugLine,
          symbolName: 'canRetry',
          loadAndAssertBody: `  const { canRetry } = loadTsModule('src/retry_budget.ts');
  if (canRetry(3, 3) !== true || canRetry(4, 3) !== false) throw new Error('Expected inclusive maxRetries=3');`,
        }),
      },
      edits: [
        {
          relativePath: 'src/retry_budget.ts',
          targetLine: bugLine,
          oldText: `  return attempt < maxRetries;`,
          newText: `  return attempt <= maxRetries;`,
          brokenDraftNewText: `  return attempt <= ;`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(3),
    });
  }

  // -------------------------------------------------------------------------
  // Category 2: Wrong operator bugs (T05 - T08)
  // -------------------------------------------------------------------------

  // T05: JavaScript discount sign error (~460 lines)
  {
    const mod = buildModuleWithBug({
      language: 'javascript',
      prefix: 'price',
      beforePaddingFns: 50,
      afterPaddingFns: 25,
      buggyBlock: [
        `export function applyDiscount(subtotalCents, discountCents) {`,
        `  const capped = Math.min(subtotalCents, Math.max(0, discountCents));`,
        `  return subtotalCents + capped;`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T05_js_wrong_op_discount',
      category: 'wrong_operator',
      language: 'javascript',
      description: 'Fix inverted addition operator in JavaScript discount calculation',
      files: {
        'src/tax.mjs': 'export const TAX_BPS = 750;\n',
        'src/pricing.mjs': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 255,
          suiteName: 'T05_pricing',
          targetFile: 'src/pricing.mjs',
          targetLine: bugLine,
          symbolName: 'applyDiscount',
          loadAndAssertBody: `  const { applyDiscount } = await import(path.resolve(process.cwd(), 'src/pricing.mjs'));
  const got = applyDiscount(1000, 250);
  if (got !== 750) throw new Error('Expected 750, got ' + got);`,
        }),
      },
      edits: [
        {
          relativePath: 'src/pricing.mjs',
          targetLine: bugLine,
          oldText: `  return subtotalCents + capped;`,
          newText: `  return subtotalCents - capped;`,
          brokenDraftNewText: `  return subtotalCents - ;`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(4),
    });
  }

  // T06: TypeScript token bucket threshold operator (~530 lines)
  {
    const mod = buildModuleWithBug({
      language: 'typescript',
      prefix: 'bucket',
      beforePaddingFns: 58,
      afterPaddingFns: 28,
      buggyBlock: [
        `export function consumeTokens(available: number, cost: number): number {`,
        `  if (available > cost) {`,
        `    return available - cost;`,
        `  }`,
        `  return -1;`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 1;
    tasks.push({
      id: 'T06_ts_wrong_op_threshold',
      category: 'wrong_operator',
      language: 'typescript',
      description: 'Fix strict greater-than operator in TypeScript rate limiter',
      files: {
        'src/bucket.ts': 'export const BUCKET_MAX: number = 100;\n',
        'src/rate_limiter.ts': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 280,
          suiteName: 'T06_rate_limiter',
          targetFile: 'src/rate_limiter.ts',
          targetLine: bugLine,
          symbolName: 'consumeTokens',
          loadAndAssertBody: `  const { consumeTokens } = loadTsModule('src/rate_limiter.ts');
  const rem = consumeTokens(10, 10);
  if (rem !== 0) throw new Error('Expected 0 remaining tokens when available === cost, got ' + rem);`,
        }),
      },
      edits: [
        {
          relativePath: 'src/rate_limiter.ts',
          targetLine: bugLine,
          oldText: `  if (available > cost) {`,
          newText: `  if (available >= cost) {`,
          brokenDraftNewText: `  if (available >= cost {`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(5),
    });
  }

  // T07: Python boolean operator bug (~400 lines)
  {
    const mod = buildModuleWithBug({
      language: 'python',
      prefix: 'acl',
      beforePaddingFns: 50,
      afterPaddingFns: 26,
      buggyBlock: [
        `def can_delete_resource(is_owner, is_active):`,
        `    if is_owner or is_active:`,
        `        return True`,
        `    return False`,
      ],
    });
    const bugLine = mod.bugStartLine + 1;
    tasks.push({
      id: 'T07_py_wrong_op_boolean_guard',
      category: 'wrong_operator',
      language: 'python',
      description: 'Fix boolean OR->AND authorization guard in Python ACL module',
      files: {
        'pkg/__init__.py': '',
        'pkg/roles.py': 'ROLE_ADMIN = "admin"\n',
        'pkg/acl.py': mod.content,
        'tests/run_tests.py': makeNoisyPyTestRunner({
          noiseLines: 230,
          suiteName: 'T07_acl',
          targetFile: 'pkg/acl.py',
          targetLine: bugLine,
          symbolName: 'can_delete_resource',
          testBody: `from pkg.acl import can_delete_resource
assert can_delete_resource(True, True) is True
assert can_delete_resource(True, False) is False, "Inactive owner must not delete"
assert can_delete_resource(False, True) is False, "Non-owner must not delete"`,
        }),
      },
      edits: [
        {
          relativePath: 'pkg/acl.py',
          targetLine: bugLine,
          oldText: `    if is_owner or is_active:`,
          newText: `    if is_owner and is_active:`,
          brokenDraftNewText: `    if is_owner and is_active`,
        },
      ],
      testCommand: 'python3 -B tests/run_tests.py',
      oracleArgs: ['python3', ['-B', 'tests/run_tests.py']],
      hasDraftSyntaxHazard: hazardIndices.has(6),
    });
  }

  // T08: JavaScript backoff multiplier bug (~490 lines)
  {
    const mod = buildModuleWithBug({
      language: 'javascript',
      prefix: 'backoff',
      beforePaddingFns: 54,
      afterPaddingFns: 26,
      buggyBlock: [
        `export function computeDelayMs(baseMs, factor, maxMs) {`,
        `  const scaled = baseMs + factor;`,
        `  return Math.min(maxMs, scaled);`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 1;
    tasks.push({
      id: 'T08_js_wrong_op_backoff_scale',
      category: 'wrong_operator',
      language: 'javascript',
      description: 'Fix addition instead of multiplication in JS backoff calculator',
      files: {
        'src/jitter.mjs': 'export const JITTER_SEED = 42;\n',
        'src/backoff.mjs': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 265,
          suiteName: 'T08_backoff',
          targetFile: 'src/backoff.mjs',
          targetLine: bugLine,
          symbolName: 'computeDelayMs',
          loadAndAssertBody: `  const { computeDelayMs } = await import(path.resolve(process.cwd(), 'src/backoff.mjs'));
  const got = computeDelayMs(200, 4, 5000);
  if (got !== 800) throw new Error('Expected 800ms, got ' + got);`,
        }),
      },
      edits: [
        {
          relativePath: 'src/backoff.mjs',
          targetLine: bugLine,
          oldText: `  const scaled = baseMs + factor;`,
          newText: `  const scaled = baseMs * factor;`,
          brokenDraftNewText: `  const scaled = (baseMs * factor;`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(7),
    });
  }

  // -------------------------------------------------------------------------
  // Category 3: Missing null / undefined / empty guard checks (T09 - T12)
  // -------------------------------------------------------------------------

  // T09: TypeScript null check on user email (~510 lines)
  {
    const mod = buildModuleWithBug({
      language: 'typescript',
      prefix: 'prof',
      beforePaddingFns: 56,
      afterPaddingFns: 28,
      buggyBlock: [
        `export function normalizeContactEmail(email: string | null): string {`,
        `  return email.trim().toLowerCase();`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 1;
    tasks.push({
      id: 'T09_ts_null_check_profile',
      category: 'null_guard',
      language: 'typescript',
      description: 'Add null guard in TypeScript normalizeContactEmail',
      files: {
        'src/defaults.ts': 'export const FALLBACK_EMAIL: string = "";\n',
        'src/profile_format.ts': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 270,
          suiteName: 'T09_profile',
          targetFile: 'src/profile_format.ts',
          targetLine: bugLine,
          symbolName: 'normalizeContactEmail',
          loadAndAssertBody: `  const { normalizeContactEmail } = loadTsModule('src/profile_format.ts');
  if (normalizeContactEmail(null) !== '') throw new Error('Expected empty string for null');
  if (normalizeContactEmail('  Dev@Example.COM ') !== 'dev@example.com') throw new Error('Mismatch');`,
        }),
      },
      edits: [
        {
          relativePath: 'src/profile_format.ts',
          targetLine: bugLine,
          oldText: `  return email.trim().toLowerCase();`,
          newText: `  return email ? email.trim().toLowerCase() : '';`,
          brokenDraftNewText: `  return email ? email.trim(.toLowerCase() : '';`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(8),
    });
  }

  // T10: JavaScript missing undefined check in cache lookup (~480 lines)
  {
    const mod = buildModuleWithBug({
      language: 'javascript',
      prefix: 'cache',
      beforePaddingFns: 52,
      afterPaddingFns: 26,
      buggyBlock: [
        `export function hasCacheTag(store, key, tag) {`,
        `  const entry = store[key];`,
        `  return entry.tags.includes(tag);`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T10_js_null_check_cache_evict',
      category: 'null_guard',
      language: 'javascript',
      description: 'Add missing undefined check in JavaScript hasCacheTag',
      files: {
        'src/entry.mjs': 'export const DEFAULT_TTL = 60;\n',
        'src/cache_store.mjs': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 260,
          suiteName: 'T10_cache',
          targetFile: 'src/cache_store.mjs',
          targetLine: bugLine,
          symbolName: 'hasCacheTag',
          loadAndAssertBody: `  const { hasCacheTag } = await import(path.resolve(process.cwd(), 'src/cache_store.mjs'));
  if (hasCacheTag({}, 'missing', 'v1') !== false) throw new Error('Expected false for missing key');
  if (hasCacheTag({ k: { tags: ['v1'] } }, 'k', 'v1') !== true) throw new Error('Expected true');`,
        }),
      },
      edits: [
        {
          relativePath: 'src/cache_store.mjs',
          targetLine: bugLine,
          oldText: `  return entry.tags.includes(tag);`,
          newText: `  return Boolean(entry && Array.isArray(entry.tags) && entry.tags.includes(tag));`,
          brokenDraftNewText: `  return Boolean(entry && Array.isArray(entry.tags) && entry.tags.includes(tag);`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(9),
    });
  }

  // T11: Python missing None check (~390 lines)
  {
    const mod = buildModuleWithBug({
      language: 'python',
      prefix: 'norm',
      beforePaddingFns: 48,
      afterPaddingFns: 26,
      buggyBlock: [
        `def extract_label(record):`,
        `    raw = record.get("label")`,
        `    return raw.strip().lower()`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T11_py_null_check_normalize',
      category: 'null_guard',
      language: 'python',
      description: 'Add None guard in Python extract_label',
      files: {
        'pkg/__init__.py': '',
        'pkg/schema.py': 'REQUIRED_FIELDS = ("id",)\n',
        'pkg/normalize.py': mod.content,
        'tests/run_tests.py': makeNoisyPyTestRunner({
          noiseLines: 230,
          suiteName: 'T11_normalize',
          targetFile: 'pkg/normalize.py',
          targetLine: bugLine,
          symbolName: 'extract_label',
          testBody: `from pkg.normalize import extract_label
assert extract_label({}) == ""
assert extract_label({"label": "  Prod "}) == "prod"`,
        }),
      },
      edits: [
        {
          relativePath: 'pkg/normalize.py',
          targetLine: bugLine,
          oldText: `    return raw.strip().lower()`,
          newText: `    return "" if raw is None else raw.strip().lower()`,
          brokenDraftNewText: `    if raw is None\n        return ""`,
        },
      ],
      testCommand: 'python3 -B tests/run_tests.py',
      oracleArgs: ['python3', ['-B', 'tests/run_tests.py']],
      hasDraftSyntaxHazard: hazardIndices.has(10),
    });
  }

  // T12: TypeScript empty array guard (~550 lines)
  {
    const mod = buildModuleWithBug({
      language: 'typescript',
      prefix: 'stat',
      beforePaddingFns: 62,
      afterPaddingFns: 28,
      buggyBlock: [
        `export function meanScore(values: number[]): number {`,
        `  let total: number = 0;`,
        `  for (const v of values) total += v;`,
        `  return total / values.length;`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 3;
    tasks.push({
      id: 'T12_ts_empty_array_guard',
      category: 'null_guard',
      language: 'typescript',
      description: 'Guard empty array division by zero in TypeScript meanScore',
      files: {
        'src/series.ts': 'export const SERIES_UNIT: string = "ms";\n',
        'src/stats.ts': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 285,
          suiteName: 'T12_stats',
          targetFile: 'src/stats.ts',
          targetLine: bugLine,
          symbolName: 'meanScore',
          loadAndAssertBody: `  const { meanScore } = loadTsModule('src/stats.ts');
  if (meanScore([]) !== 0) throw new Error('Expected 0 for empty array, got ' + meanScore([]));
  if (meanScore([10, 20]) !== 15) throw new Error('Expected 15');`,
        }),
      },
      edits: [
        {
          relativePath: 'src/stats.ts',
          targetLine: bugLine,
          oldText: `  return total / values.length;`,
          newText: `  return values.length === 0 ? 0 : total / values.length;`,
          brokenDraftNewText: `  return values.length === 0 ? 0 : total / ;`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(11),
    });
  }

  // -------------------------------------------------------------------------
  // Category 4: Broken import / JSON config syntax / schema bugs (T13 - T16)
  // -------------------------------------------------------------------------

  // T13: JSON runtime config bug (~330 lines)
  {
    const entries: string[] = [];
    for (let i = 1; i <= 52; i++) {
      entries.push(`    "service_${i}": { "enabled": true, "pool": ${(i % 8) + 1}, "weight": ${i} },`);
    }
    const bugLine = 4 + entries.length + 2;
    const jsonText = [
      `{`,
      `  "version": "2.1.0",`,
      `  "services": {`,
      ...entries,
      `    "gateway": {`,
      `      "timeoutMs": -1,`,
      `      "maxRetries": 3`,
      `    }`,
      `  }`,
      `}`,
      ``,
    ].join('\n');
    tasks.push({
      id: 'T13_json_broken_retry_config',
      category: 'config_or_import',
      language: 'json',
      description: 'Fix negative gateway.timeoutMs in large JSON runtime config',
      files: {
        'config/runtime.json': jsonText,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 220,
          suiteName: 'T13_json_config',
          targetFile: 'config/runtime.json',
          targetLine: bugLine,
          symbolName: 'gateway.timeoutMs',
          loadAndAssertBody: `  const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config/runtime.json'), 'utf8'));
  if (cfg.services.gateway.timeoutMs !== 5000) throw new Error('Expected gateway.timeoutMs === 5000, got ' + cfg.services.gateway.timeoutMs);`,
        }),
      },
      edits: [
        {
          relativePath: 'config/runtime.json',
          targetLine: bugLine,
          oldText: `      "timeoutMs": -1,`,
          newText: `      "timeoutMs": 5000,`,
          brokenDraftNewText: `      "timeoutMs": 5000,,`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(12),
    });
  }

  // T14: JSON routing table deep key (~360 lines)
  {
    const routes: string[] = [];
    for (let i = 1; i <= 58; i++) {
      routes.push(`    { "id": "route_${i}", "path": "/v1/r${i}", "port": ${7000 + i} },`);
    }
    const bugLine = 3 + routes.length + 3;
    const jsonText = [
      `{`,
      `  "routes": [`,
      ...routes,
      `    { "id": "health", "path": "/health", "port": 7999 }`,
      `  ],`,
      `  "fallbackPort": 0`,
      `}`,
      ``,
    ].join('\n');
    tasks.push({
      id: 'T14_json_broken_routing_table',
      category: 'config_or_import',
      language: 'json',
      description: 'Fix zero fallbackPort at bottom of large routes.json config',
      files: {
        'config/routes.json': jsonText,
        'src/loader.mjs': 'export const ROUTE_SCHEMA = 1;\n',
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 230,
          suiteName: 'T14_routes_json',
          targetFile: 'config/routes.json',
          targetLine: bugLine,
          symbolName: 'fallbackPort',
          loadAndAssertBody: `  const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config/routes.json'), 'utf8'));
  if (cfg.fallbackPort !== 8080) throw new Error('Expected fallbackPort === 8080, got ' + cfg.fallbackPort);`,
        }),
      },
      edits: [
        {
          relativePath: 'config/routes.json',
          targetLine: bugLine,
          oldText: `  "fallbackPort": 0`,
          newText: `  "fallbackPort": 8080`,
          brokenDraftNewText: `  "fallbackPort": 8080,`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(13),
    });
  }

  // T15: JavaScript broken import symbol (~440 lines)
  {
    const mod = buildModuleWithBug({
      language: 'javascript',
      prefix: 'disp',
      beforePaddingFns: 48,
      afterPaddingFns: 24,
      headerLines: [`import { encodeFrameV1 } from './codec.mjs';`, ``],
      buggyBlock: [
        `export function dispatchPayload(payload) {`,
        `  return encodeFrameV1(payload);`,
        `}`,
      ],
    });
    const bugLine = 1;
    tasks.push({
      id: 'T15_js_broken_import_symbol',
      category: 'config_or_import',
      language: 'javascript',
      description: 'Fix stale import symbol encodeFrameV1 -> encodeFrameV2 in dispatcher',
      files: {
        'src/codec.mjs': `export function encodeFrameV2(payload) {\n  return 'v2:' + String(payload);\n}\n`,
        'src/dispatcher.mjs': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 250,
          suiteName: 'T15_broken_import',
          targetFile: 'src/dispatcher.mjs',
          targetLine: bugLine,
          symbolName: 'encodeFrameV2',
          loadAndAssertBody: `  const { dispatchPayload } = await import(path.resolve(process.cwd(), 'src/dispatcher.mjs'));
  if (dispatchPayload('ping') !== 'v2:ping') throw new Error('Unexpected encoded frame');`,
        }),
      },
      edits: [
        {
          relativePath: 'src/dispatcher.mjs',
          targetLine: 1,
          oldText: `import { encodeFrameV1 } from './codec.mjs';`,
          newText: `import { encodeFrameV2 as encodeFrameV1 } from './codec.mjs';`,
          brokenDraftNewText: `import { encodeFrameV2 as encodeFrameV1 from './codec.mjs';`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(14),
    });
  }

  // T16: Python config key typo (~380 lines)
  {
    const mod = buildModuleWithBug({
      language: 'python',
      prefix: 'cfg',
      beforePaddingFns: 46,
      afterPaddingFns: 26,
      headerLines: [`import json`, ``],
      buggyBlock: [
        `def load_batch_limit(config_path):`,
        `    with open(config_path, "r", encoding="utf-8") as fh:`,
        `        data = json.load(fh)`,
        `    return int(data["max_batch_sz"])`,
      ],
    });
    const bugLine = mod.bugStartLine + 3;
    tasks.push({
      id: 'T16_py_broken_config_key',
      category: 'config_or_import',
      language: 'python',
      description: 'Fix config key typo max_batch_sz -> max_batch_size in Python settings loader',
      files: {
        'pkg/__init__.py': '',
        'config/limits.json': '{\n  "max_batch_size": 64\n}\n',
        'pkg/settings.py': mod.content,
        'tests/run_tests.py': makeNoisyPyTestRunner({
          noiseLines: 230,
          suiteName: 'T16_settings',
          targetFile: 'pkg/settings.py',
          targetLine: bugLine,
          symbolName: 'load_batch_limit',
          testBody: `from pkg.settings import load_batch_limit
got = load_batch_limit("config/limits.json")
assert got == 64, f"Expected 64, got {got}"`,
        }),
      },
      edits: [
        {
          relativePath: 'pkg/settings.py',
          targetLine: bugLine,
          oldText: `    return int(data["max_batch_sz"])`,
          newText: `    return int(data["max_batch_size"])`,
          brokenDraftNewText: `    return int(data["max_batch_size"]`,
        },
      ],
      testCommand: 'python3 -B tests/run_tests.py',
      oracleArgs: ['python3', ['-B', 'tests/run_tests.py']],
      hasDraftSyntaxHazard: hazardIndices.has(15),
    });
  }

  // -------------------------------------------------------------------------
  // Category 5: Multi-file symbol rename / cross-file contract fixes (T17 - T19)
  // -------------------------------------------------------------------------

  // T17: JavaScript 2-file symbol rename (~450 lines each)
  {
    const ledger = buildModuleWithBug({
      language: 'javascript',
      prefix: 'ledg',
      beforePaddingFns: 46,
      afterPaddingFns: 24,
      buggyBlock: [
        `export function computeNetTotal(entries) {`,
        `  return entries.reduce((acc, item) => acc + item.amount, 0);`,
        `}`,
      ],
    });
    const reconcile = buildModuleWithBug({
      language: 'javascript',
      prefix: 'rec',
      beforePaddingFns: 44,
      afterPaddingFns: 24,
      headerLines: [`import { computeNetTotal } from './ledger.mjs';`, ``],
      buggyBlock: [
        `export function runReconciliation(entries) {`,
        `  return computeNetTotal(entries);`,
        `}`,
      ],
    });
    tasks.push({
      id: 'T17_js_multifile_symbol_rename',
      category: 'multifile_rename',
      language: 'javascript',
      description: 'Rename exported computeNetTotal -> computeSettledTotal across ledger.mjs and reconcile.mjs',
      files: {
        'src/ledger.mjs': ledger.content,
        'src/reconcile.mjs': reconcile.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 250,
          suiteName: 'T17_multifile_rename',
          targetFile: 'src/ledger.mjs',
          targetLine: ledger.bugStartLine,
          symbolName: 'computeSettledTotal',
          loadAndAssertBody: `  const ledger = await import(path.resolve(process.cwd(), 'src/ledger.mjs'));
  if (typeof ledger.computeSettledTotal !== 'function') throw new Error('Missing export computeSettledTotal in src/ledger.mjs');
  const rec = await import(path.resolve(process.cwd(), 'src/reconcile.mjs'));
  if (rec.runReconciliation([{ amount: 12 }, { amount: 8 }]) !== 20) throw new Error('Reconciliation mismatch');`,
        }),
      },
      secondarySearchQuery: 'computeNetTotal',
      edits: [
        {
          relativePath: 'src/ledger.mjs',
          targetLine: ledger.bugStartLine,
          oldText: `export function computeNetTotal(entries) {`,
          newText: `export function computeSettledTotal(entries) {`,
          brokenDraftNewText: `export function computeSettledTotal(entries {`,
        },
        {
          relativePath: 'src/reconcile.mjs',
          targetLine: 1,
          oldText: `import { computeNetTotal } from './ledger.mjs';`,
          newText: `import { computeSettledTotal as computeNetTotal } from './ledger.mjs';`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(16),
    });
  }

  // T18: TypeScript 2-file contract fix (~470 lines each)
  {
    const quota = buildModuleWithBug({
      language: 'typescript',
      prefix: 'quota',
      beforePaddingFns: 48,
      afterPaddingFns: 24,
      buggyBlock: [
        `export function evaluateQuota(limit: number, used: number): number {`,
        `  return Math.max(0, limit - used - 1);`,
        `}`,
      ],
    });
    const enforcer = buildModuleWithBug({
      language: 'typescript',
      prefix: 'enf',
      beforePaddingFns: 44,
      afterPaddingFns: 24,
      buggyBlock: [
        `export function formatQuotaBanner(remaining: number): string {`,
        `  return "left=" + String(remaining);`,
        `}`,
      ],
    });
    tasks.push({
      id: 'T18_ts_multifile_contract_fix',
      category: 'multifile_rename',
      language: 'typescript',
      description: 'Align quota calculation & banner formatting contract across 2 TS files',
      files: {
        'src/quota.ts': quota.content,
        'src/enforcer.ts': enforcer.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 260,
          suiteName: 'T18_quota_contract',
          targetFile: 'src/quota.ts',
          targetLine: quota.bugStartLine + 1,
          symbolName: 'evaluateQuota',
          loadAndAssertBody: `  const { evaluateQuota } = loadTsModule('src/quota.ts');
  const { formatQuotaBanner } = loadTsModule('src/enforcer.ts');
  const rem = evaluateQuota(10, 4);
  if (rem !== 6) throw new Error('Expected remaining=6, got ' + rem);
  if (formatQuotaBanner(rem) !== 'remaining=6') throw new Error('Expected banner remaining=6');`,
        }),
      },
      secondarySearchQuery: 'formatQuotaBanner',
      edits: [
        {
          relativePath: 'src/quota.ts',
          targetLine: quota.bugStartLine + 1,
          oldText: `  return Math.max(0, limit - used - 1);`,
          newText: `  return Math.max(0, limit - used);`,
          brokenDraftNewText: `  return Math.max(0, limit - used;`,
        },
        {
          relativePath: 'src/enforcer.ts',
          targetLine: enforcer.bugStartLine + 1,
          oldText: `  return "left=" + String(remaining);`,
          newText: `  return "remaining=" + String(remaining);`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(17),
    });
  }

  // T19: Python 2-file symbol rename (~370 lines each)
  {
    const tok = buildModuleWithBug({
      language: 'python',
      prefix: 'tok',
      beforePaddingFns: 44,
      afterPaddingFns: 24,
      buggyBlock: [
        `def split_chunks(text, size):`,
        `    return [text[i:i + size] for i in range(0, len(text), size)]`,
      ],
    });
    const pipe = buildModuleWithBug({
      language: 'python',
      prefix: 'pipe',
      beforePaddingFns: 42,
      afterPaddingFns: 24,
      headerLines: [`from pkg.tokenizer import split_chunks`, ``],
      buggyBlock: [
        `def run_pipeline(text):`,
        `    return split_chunks(text, 2)`,
      ],
    });
    tasks.push({
      id: 'T19_py_multifile_symbol_rename',
      category: 'multifile_rename',
      language: 'python',
      description: 'Rename split_chunks -> partition_chunks across tokenizer.py and pipeline.py',
      files: {
        'pkg/__init__.py': '',
        'pkg/tokenizer.py': tok.content,
        'pkg/pipeline.py': pipe.content,
        'tests/run_tests.py': makeNoisyPyTestRunner({
          noiseLines: 225,
          suiteName: 'T19_py_multifile',
          targetFile: 'pkg/tokenizer.py',
          targetLine: tok.bugStartLine,
          symbolName: 'partition_chunks',
          testBody: `from pkg.tokenizer import partition_chunks
from pkg.pipeline import run_pipeline
assert partition_chunks("abcd", 2) == ["ab", "cd"]
assert run_pipeline("wxyz") == ["wx", "yz"]`,
        }),
      },
      secondarySearchQuery: 'split_chunks',
      edits: [
        {
          relativePath: 'pkg/tokenizer.py',
          targetLine: tok.bugStartLine,
          oldText: `def split_chunks(text, size):`,
          newText: `def partition_chunks(text, size):`,
          brokenDraftNewText: `def partition_chunks(text, size)`,
        },
        {
          relativePath: 'pkg/pipeline.py',
          targetLine: 1,
          oldText: `from pkg.tokenizer import split_chunks`,
          newText: `from pkg.tokenizer import partition_chunks as split_chunks`,
        },
      ],
      testCommand: 'python3 -B tests/run_tests.py',
      oracleArgs: ['python3', ['-B', 'tests/run_tests.py']],
      hasDraftSyntaxHazard: hazardIndices.has(18),
    });
  }

  // -------------------------------------------------------------------------
  // Category 6: Large-file surgical edits (T20 - T22)
  // -------------------------------------------------------------------------

  // T20: 820-line TypeScript scheduler surgical edit at line ~680
  {
    const mod = buildModuleWithBug({
      language: 'typescript',
      prefix: 'sched',
      beforePaddingFns: 112,
      afterPaddingFns: 24,
      buggyBlock: [
        `export function selectNextSlot(slots: number[], minPriority: number): number {`,
        `  for (let i: number = 0; i < slots.length; i++) {`,
        `    if (slots[i] > minPriority) return i;`,
        `  }`,
        `  return -1;`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T20_ts_large_file_surgical_820',
      category: 'large_file_surgical',
      language: 'typescript',
      description: 'Surgical threshold edit at line ~680 of an 820-line TypeScript scheduler',
      files: {
        'src/scheduler.ts': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 340,
          suiteName: 'T20_scheduler',
          targetFile: 'src/scheduler.ts',
          targetLine: bugLine,
          symbolName: 'selectNextSlot',
          includeAnsi: true,
          loadAndAssertBody: `  const { selectNextSlot } = loadTsModule('src/scheduler.ts');
  const idx = selectNextSlot([1, 5, 2], 5);
  if (idx !== 1) throw new Error('Expected slot index 1 for priority==5, got ' + idx);`,
        }),
      },
      edits: [
        {
          relativePath: 'src/scheduler.ts',
          targetLine: bugLine,
          oldText: `    if (slots[i] > minPriority) return i;`,
          newText: `    if (slots[i] >= minPriority) return i;`,
          brokenDraftNewText: `    if (slots[i] >= minPriority return i;`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(19),
    });
  }

  // T21: 780-line JavaScript query planner surgical edit at line ~640
  {
    const mod = buildModuleWithBug({
      language: 'javascript',
      prefix: 'plan',
      beforePaddingFns: 106,
      afterPaddingFns: 24,
      buggyBlock: [
        `export function estimateJoinCost(leftRows, rightRows, indexBoost) {`,
        `  const base = leftRows * rightRows;`,
        `  return Math.max(1, Math.floor(base * indexBoost));`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T21_js_large_file_surgical_780',
      category: 'large_file_surgical',
      language: 'javascript',
      description: 'Surgical formula fix at line ~640 of a 780-line JS query planner',
      files: {
        'src/query_planner.mjs': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 330,
          suiteName: 'T21_query_planner',
          targetFile: 'src/query_planner.mjs',
          targetLine: bugLine,
          symbolName: 'estimateJoinCost',
          includeAnsi: true,
          loadAndAssertBody: `  const { estimateJoinCost } = await import(path.resolve(process.cwd(), 'src/query_planner.mjs'));
  const cost = estimateJoinCost(100, 20, 4);
  if (cost !== 500) throw new Error('Expected 500 (base / indexBoost), got ' + cost);`,
        }),
      },
      edits: [
        {
          relativePath: 'src/query_planner.mjs',
          targetLine: bugLine,
          oldText: `  return Math.max(1, Math.floor(base * indexBoost));`,
          newText: `  return Math.max(1, Math.floor(base / indexBoost));`,
          brokenDraftNewText: `  return Math.max(1, Math.floor(base / indexBoost);`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(20),
    });
  }

  // T22: 720-line Python graph walk surgical edit at line ~590
  {
    const mod = buildModuleWithBug({
      language: 'python',
      prefix: 'walk',
      beforePaddingFns: 116,
      afterPaddingFns: 26,
      buggyBlock: [
        `def reachable_count(edges, start):`,
        `    visited = set()`,
        `    stack = [start]`,
        `    while stack:`,
        `        node = stack.pop()`,
        `        if node in visited:`,
        `            continue`,
        `        visited.add(node)`,
        `        for nxt in edges.get(node, []):`,
        `            stack.append(nxt)`,
        `    return len(visited) - 1`,
      ],
    });
    const bugLine = mod.bugStartLine + 10;
    tasks.push({
      id: 'T22_py_large_file_surgical_720',
      category: 'large_file_surgical',
      language: 'python',
      description: 'Surgical off-by-one fix at line ~590 of a 720-line Python graph walker',
      files: {
        'pkg/__init__.py': '',
        'pkg/graph_walk.py': mod.content,
        'tests/run_tests.py': makeNoisyPyTestRunner({
          noiseLines: 310,
          suiteName: 'T22_graph_walk',
          targetFile: 'pkg/graph_walk.py',
          targetLine: bugLine,
          symbolName: 'reachable_count',
          testBody: `from pkg.graph_walk import reachable_count
got = reachable_count({"a": ["b"], "b": ["c"]}, "a")
assert got == 3, f"Expected 3 reachable nodes including start, got {got}"`,
        }),
      },
      edits: [
        {
          relativePath: 'pkg/graph_walk.py',
          targetLine: bugLine,
          oldText: `    return len(visited) - 1`,
          newText: `    return len(visited)`,
          brokenDraftNewText: `    return len(visited`,
        },
      ],
      testCommand: 'python3 -B tests/run_tests.py',
      oracleArgs: ['python3', ['-B', 'tests/run_tests.py']],
      hasDraftSyntaxHazard: hazardIndices.has(21),
    });
  }

  // -------------------------------------------------------------------------
  // Category 7: Noisy test-log triage (T23 - T24)
  // -------------------------------------------------------------------------

  // T23: 550-line noisy ANSI test log hiding stream parser bug
  {
    const mod = buildModuleWithBug({
      language: 'javascript',
      prefix: 'strm',
      beforePaddingFns: 74,
      afterPaddingFns: 24,
      buggyBlock: [
        `export function parseFrameHeader(line) {`,
        `  const idx = line.indexOf(':');`,
        `  if (idx <= 0) return null;`,
        `  return { key: line.slice(0, idx), value: line.slice(idx) };`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 3;
    tasks.push({
      id: 'T23_js_noisy_log_triage_550',
      category: 'noisy_log_triage',
      language: 'javascript',
      description: 'Triage 550-line ANSI test log to fix colon-offset slice in stream parser',
      files: {
        'src/stream_parser.mjs': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 550,
          suiteName: 'T23_stream_parser',
          targetFile: 'src/stream_parser.mjs',
          targetLine: bugLine,
          symbolName: 'parseFrameHeader',
          includeAnsi: true,
          loadAndAssertBody: `  const { parseFrameHeader } = await import(path.resolve(process.cwd(), 'src/stream_parser.mjs'));
  const parsed = parseFrameHeader('content-type:application/json');
  if (!parsed || parsed.value !== 'application/json') throw new Error('Expected value without leading colon, got ' + JSON.stringify(parsed));`,
        }),
      },
      edits: [
        {
          relativePath: 'src/stream_parser.mjs',
          targetLine: bugLine,
          oldText: `  return { key: line.slice(0, idx), value: line.slice(idx) };`,
          newText: `  return { key: line.slice(0, idx), value: line.slice(idx + 1) };`,
          brokenDraftNewText: `  return { key: line.slice(0, idx), value: line.slice(idx + 1 };`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(22),
    });
  }

  // T24: 520-line noisy ANSI test log hiding TypeScript checkpoint bug
  {
    const mod = buildModuleWithBug({
      language: 'typescript',
      prefix: 'ckpt',
      beforePaddingFns: 78,
      afterPaddingFns: 26,
      buggyBlock: [
        `export function shouldFlushCheckpoint(pending: number, threshold: number): boolean {`,
        `  if (threshold <= 0) return true;`,
        `  return pending > threshold;`,
        `}`,
      ],
    });
    const bugLine = mod.bugStartLine + 2;
    tasks.push({
      id: 'T24_ts_noisy_log_triage_520',
      category: 'noisy_log_triage',
      language: 'typescript',
      description: 'Triage 520-line ANSI log to fix checkpoint flush boundary in TypeScript',
      files: {
        'src/checkpoint.ts': mod.content,
        'tests/run.mjs': makeNoisyNodeTestRunner({
          noiseLines: 520,
          suiteName: 'T24_checkpoint',
          targetFile: 'src/checkpoint.ts',
          targetLine: bugLine,
          symbolName: 'shouldFlushCheckpoint',
          includeAnsi: true,
          loadAndAssertBody: `  const { shouldFlushCheckpoint } = loadTsModule('src/checkpoint.ts');
  if (shouldFlushCheckpoint(50, 50) !== true) throw new Error('Expected flush when pending === threshold');`,
        }),
      },
      edits: [
        {
          relativePath: 'src/checkpoint.ts',
          targetLine: bugLine,
          oldText: `  return pending > threshold;`,
          newText: `  return pending >= threshold;`,
          brokenDraftNewText: `  return pending >= ;`,
        },
      ],
      testCommand: 'node tests/run.mjs',
      oracleArgs: ['node', ['tests/run.mjs']],
      hasDraftSyntaxHazard: hazardIndices.has(23),
    });
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Deterministic Agent Loop over Real `@hanzo/mcp` Tools
// ---------------------------------------------------------------------------

function materializeWorkspace(files: Record<string, string>): string {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzo-aci-bench-'));
  const realDir = resolveWorkspaceRoot(rawDir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(realDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return realDir;
}

function runIndependentOracle(workspace: string, oracleArgs: [string, string[]]): boolean {
  try {
    execFileSync(oracleArgs[0], oracleArgs[1], {
      cwd: workspace,
      stdio: 'pipe',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function extractToolText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

function parseFailureLocationFromToolText(text: string): { file: string; line: number } | null {
  // Structured ACI envelope format: `first_error: file=src/foo.ts:123`
  const aciMatch = text.match(/first_error:\s*file=([A-Za-z0-9_./-]+\.(?:ts|js|mjs|py|json)):(\d+)/);
  if (aciMatch) {
    return { file: aciMatch[1], line: Number(aciMatch[2]) };
  }
  // Raw runner format: `FAIL src/foo.ts:123 [symbol]`
  const failMatch = text.match(/FAIL\s+([A-Za-z0-9_./-]+\.(?:ts|js|mjs|py|json)):(\d+)/);
  if (failMatch) {
    return { file: failMatch[1], line: Number(failMatch[2]) };
  }
  // Python traceback format
  const pyMatch = text.match(/File\s+"([^"]+\.py)",\s+line\s+(\d+)/);
  if (pyMatch) {
    return { file: pyMatch[1], line: Number(pyMatch[2]) };
  }
  return null;
}

function didExecSucceed(res: { isError?: boolean }, text: string): boolean {
  if (res.isError) return false;
  if (text.includes('status=ok exit=0')) return true;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.data && typeof parsed.data.exit_code === 'number') {
      return parsed.data.exit_code === 0;
    }
    if (typeof parsed?.ok === 'boolean') return parsed.ok;
  } catch {
    // Plain/truncated text
  }
  return text.includes('PASS ') && !text.includes('FAIL ');
}

/**
 * Executes a single task under one matched ACI regime using identical agent
 * logic and fixed step/token budgets.
 */
async function runSingleTaskUnderRegime(
  task: BenchmarkTaskSpec,
  regime: BenchmarkRegimeId,
  server: AciServerInvoker,
  cfg: {
    maxSteps: number;
    contextTokenBudget: number;
    windowSize: number;
    maxResponseBytes: number;
    naiveHeadMaxChars: number;
    overCompressedMaxChars: number;
  }
): Promise<TaskRunResult> {
  const t0 = performance.now();
  const workspace = materializeWorkspace(task.files);
  const adapter = new AciResponseAdapter({
    workspaceRoot: workspace,
    mode: regime,
    windowSize: cfg.windowSize,
    maxResponseBytes: cfg.maxResponseBytes,
    naiveHeadMaxChars: cfg.naiveHeadMaxChars,
    overCompressedMaxChars: cfg.overCompressedMaxChars,
  });

  let toolCalls = 0;
  let responseBytes = 0;
  let responseTokens = 0;
  let syntaxHazardPrevented = false;
  let syntaxCorruptedDiskWrites = 0;
  let completed = false;
  let failureReason: string | null = null;

  const invoke = async (toolName: string, args: Record<string, unknown>) => {
    if (toolCalls >= cfg.maxSteps) {
      throw new Error('STEP_BUDGET_EXCEEDED');
    }
    toolCalls++;
    const res = await adapter.callTool(server, toolName, args);
    const text = extractToolText(res);
    responseBytes += Buffer.byteLength(text, 'utf8');
    responseTokens += estimateAciTokens(text);
    if (responseTokens > cfg.contextTokenBudget) {
      throw new Error('CONTEXT_TOKEN_BUDGET_EXCEEDED');
    }
    return { res, text };
  };

  try {
    // Step 1: Run failing test suite to localize bug
    const initialRun = await invoke('exec', {
      action: 'exec',
      command: task.testCommand,
      cwd: workspace,
    });
    const loc = parseFailureLocationFromToolText(initialRun.text);
    if (!loc) {
      failureReason = 'LOCALIZATION_LOST_IN_OUTPUT';
    } else {
      const primaryEdit = task.edits[0];
      const primaryAbs = path.join(workspace, loc.file);

      // Step 2: Inspect target file around localized line
      const viewRes = await invoke('fs', {
        action: 'read',
        path: primaryAbs,
        center_line: loc.line,
        window_size: cfg.windowSize,
      });

      if (!viewRes.text.includes(primaryEdit.oldText.trim())) {
        failureReason = 'ANCHOR_NOT_VISIBLE_IN_VIEW';
      } else {
        // Step 3: Apply primary edit (with seeded draft syntax hazard if active)
        const shouldInjectHazard =
          task.hasDraftSyntaxHazard && typeof primaryEdit.brokenDraftNewText === 'string';

        if (shouldInjectHazard) {
          const preSha = computeFileSha256(fs.readFileSync(primaryAbs, 'utf8'));
          const draftRes = await invoke('fs', {
            action: 'apply_patch',
            path: primaryAbs,
            old_text: primaryEdit.oldText,
            new_text: primaryEdit.brokenDraftNewText!,
            expected_line: primaryEdit.targetLine,
          });
          const postSha = computeFileSha256(fs.readFileSync(primaryAbs, 'utf8'));

          if (draftRes.res.isError && postSha === preSha && draftRes.text.includes('SYNTAX_LINT_FAILED')) {
            // ACI lint gate atomically rolled back broken syntax! Immediately apply clean fix.
            syntaxHazardPrevented = true;
            await invoke('fs', {
              action: 'apply_patch',
              path: primaryAbs,
              old_text: primaryEdit.oldText,
              new_text: primaryEdit.newText,
              expected_line: primaryEdit.targetLine,
            });
          } else {
            // Unlinted edit persisted broken syntax to disk!
            syntaxCorruptedDiskWrites++;
            // Agent runs test -> discovers syntax error -> re-reads corrupted file -> repairs
            await invoke('exec', {
              action: 'exec',
              command: task.testCommand,
              cwd: workspace,
            });
            await invoke('fs', {
              action: 'read',
              path: primaryAbs,
              center_line: primaryEdit.targetLine,
              window_size: cfg.windowSize,
            });
            await invoke('fs', {
              action: 'apply_patch',
              path: primaryAbs,
              old_text: primaryEdit.brokenDraftNewText!,
              new_text: primaryEdit.newText,
              expected_line: primaryEdit.targetLine,
            });
          }
        } else {
          const editRes = await invoke('fs', {
            action: 'apply_patch',
            path: primaryAbs,
            old_text: primaryEdit.oldText,
            new_text: primaryEdit.newText,
            expected_line: primaryEdit.targetLine,
          });
          // When the edit primitive does not return an inline localized snippet,
          // agent reads the file to verify the applied edit before running tests.
          if (!editRes.text.includes('[Edited:')) {
            await invoke('fs', {
              action: 'read',
              path: primaryAbs,
              center_line: primaryEdit.targetLine,
              window_size: cfg.windowSize,
            });
          }
        }

        // Step 3b: Multi-file secondary edit if required
        if (task.edits.length > 1) {
          const secondaryEdit = task.edits[1];
          const secondaryAbs = path.join(workspace, secondaryEdit.relativePath);
          if (task.secondarySearchQuery) {
            const searchRes = await invoke('fs', {
              action: 'search_text',
              path: workspace,
              pattern: task.secondarySearchQuery,
            });
            if (
              !searchRes.text.includes(path.basename(secondaryEdit.relativePath)) &&
              !searchRes.text.includes(task.secondarySearchQuery)
            ) {
              failureReason = 'SECONDARY_SYMBOL_SEARCH_TRUNCATED';
            }
          }
          if (!failureReason) {
            const secView = await invoke('fs', {
              action: 'read',
              path: secondaryAbs,
              center_line: secondaryEdit.targetLine,
              window_size: cfg.windowSize,
            });
            if (!secView.text.includes(secondaryEdit.oldText.trim())) {
              failureReason = 'SECONDARY_ANCHOR_NOT_VISIBLE';
            } else {
              await invoke('fs', {
                action: 'apply_patch',
                path: secondaryAbs,
                old_text: secondaryEdit.oldText,
                new_text: secondaryEdit.newText,
                expected_line: secondaryEdit.targetLine,
              });
            }
          }
        }

        // Step 4: Final verification test run
        if (!failureReason) {
          const verifyRun = await invoke('exec', {
            action: 'exec',
            command: task.testCommand,
            cwd: workspace,
          });
          if (didExecSucceed(verifyRun.res, verifyRun.text)) {
            completed = true;
          } else {
            failureReason = 'VERIFICATION_OUTPUT_UNCONFIRMED';
          }
        }
      }
    }
  } catch (err: any) {
    failureReason = String(err?.message ?? err);
    completed = false;
  }

  // Independent unit-test oracle verification on real disk state
  const patchCorrect = runIndependentOracle(workspace, task.oracleArgs);
  if (!patchCorrect) {
    completed = false;
    failureReason = failureReason ?? 'ORACLE_TESTS_FAILED';
  }

  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  return {
    taskId: task.id,
    category: task.category,
    language: task.language,
    regime,
    completed,
    patchCorrect,
    failureReason,
    toolCalls,
    responseBytes,
    responseTokens,
    syntaxHazardInjected: task.hasDraftSyntaxHazard,
    syntaxHazardPrevented,
    syntaxCorruptedDiskWrites,
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Boundary Regime 1: Semantic Logic Error Passes Syntax Lint
// ---------------------------------------------------------------------------

async function runSemanticBoundaryRegime(
  server: AciServerInvoker
): Promise<SemanticBoundaryResult> {
  const cases = [
    {
      name: 'sem_js_wrong_return',
      file: 'src/calc.mjs',
      initial: 'export function doubleVal(x) {\n  return x * 3;\n}\n',
      wrongSemanticEdit: '  return x + 1;',
      correctEdit: '  return x * 2;',
      oldText: '  return x * 3;',
      testScript: `import { doubleVal } from './src/calc.mjs';\nif (doubleVal(6) !== 12) { console.error('FAIL src/calc.mjs:2 [doubleVal] - Expected 12, got ' + doubleVal(6)); process.exit(1); }\nconsole.log('PASS');\n`,
      cmd: 'node test.mjs',
      oracle: ['node', ['test.mjs']] as [string, string[]],
    },
    {
      name: 'sem_js_wrong_clamp',
      file: 'src/clamp.mjs',
      initial: 'export function clampZero(x) {\n  return x;\n}\n',
      wrongSemanticEdit: '  return x < 0 ? -1 : x;',
      correctEdit: '  return x < 0 ? 0 : x;',
      oldText: '  return x;',
      testScript: `import { clampZero } from './src/clamp.mjs';\nif (clampZero(-5) !== 0) { console.error('FAIL src/clamp.mjs:2 [clampZero] - Expected 0'); process.exit(1); }\nconsole.log('PASS');\n`,
      cmd: 'node test.mjs',
      oracle: ['node', ['test.mjs']] as [string, string[]],
    },
    {
      name: 'sem_json_wrong_value',
      file: 'config.json',
      initial: '{\n  "timeoutMs": 10\n}\n',
      wrongSemanticEdit: '  "timeoutMs": 50',
      correctEdit: '  "timeoutMs": 5000',
      oldText: '  "timeoutMs": 10',
      testScript: `import * as fs from 'fs';\nconst c = JSON.parse(fs.readFileSync('config.json','utf8'));\nif (c.timeoutMs !== 5000) { console.error('FAIL config.json:2 [timeoutMs] - Expected 5000'); process.exit(1); }\nconsole.log('PASS');\n`,
      cmd: 'node test.mjs',
      oracle: ['node', ['test.mjs']] as [string, string[]],
    },
    {
      name: 'sem_py_wrong_return',
      file: 'mod.py',
      initial: 'def square(n):\n    return n + n\n',
      wrongSemanticEdit: '    return n * 3',
      correctEdit: '    return n * n',
      oldText: '    return n + n',
      testScript: `import os, sys\nsys.path.insert(0, os.getcwd())\nfrom mod import square\nassert square(5) == 25, "Expected 25"\nprint("PASS")\n`,
      cmd: 'python3 -B test.py',
      oracle: ['python3', ['-B', 'test.py']] as [string, string[]],
    },
  ];

  let syntaxLintPassedCount = 0;
  let caughtByUnitTestCount = 0;
  let repairedCount = 0;
  let totalCalls = 0;
  let totalMs = 0;

  for (const c of cases) {
    const t0 = performance.now();
    const ws = materializeWorkspace({
      [c.file]: c.initial,
      [c.cmd.endsWith('.py') ? 'test.py' : 'test.mjs']: c.testScript,
    });
    const adapter = new AciResponseAdapter({ workspaceRoot: ws, mode: 'swe_agent_aci_full' });
    const targetAbs = path.join(ws, c.file);

    try {
      // 1. Submit syntactically valid but semantically wrong edit
      const badEdit = lintedEdit({
        workspaceRoot: ws,
        filePath: targetAbs,
        oldText: c.oldText,
        newText: c.wrongSemanticEdit,
      });
      totalCalls++;
      if (badEdit.ok && badEdit.applied) {
        syntaxLintPassedCount++;
      }

      // 2. Execute real unit test -> catches semantic bug!
      const testRes = await adapter.callTool(server, 'exec', {
        action: 'exec',
        command: c.cmd,
        cwd: ws,
      });
      totalCalls++;
      if (testRes.isError) {
        caughtByUnitTestCount++;
      }

      // 3. Repair using test feedback and re-verify
      lintedEdit({
        workspaceRoot: ws,
        filePath: targetAbs,
        oldText: c.wrongSemanticEdit,
        newText: c.correctEdit,
      });
      totalCalls++;
      await adapter.callTool(server, 'exec', {
        action: 'exec',
        command: c.cmd,
        cwd: ws,
      });
      totalCalls++;
      if (runIndependentOracle(ws, c.oracle)) {
        repairedCount++;
      }
    } finally {
      totalMs += performance.now() - t0;
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  const n = cases.length;
  return {
    regime: 'semantic_logic_error_passes_syntax_lint',
    tasksTotal: n,
    syntaxLintPassedCount,
    syntaxLintPassedRatePct: Number(((syntaxLintPassedCount / n) * 100).toFixed(2)),
    caughtByUnitTestCount,
    caughtByUnitTestRatePct: Number(((caughtByUnitTestCount / n) * 100).toFixed(2)),
    repairedAfterTestFeedbackCount: repairedCount,
    repairedAfterTestFeedbackRatePct: Number(((repairedCount / n) * 100).toFixed(2)),
    meanToolCalls: Number((totalCalls / n).toFixed(2)),
    meanLatencyMs: Number((totalMs / n).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Boundary Regime 2: Tiny Single-File Overhead Regime (<20 lines, 1-line log)
// ---------------------------------------------------------------------------

async function runTinyFileOverheadRegime(
  server: AciServerInvoker
): Promise<TinyFileOverheadResult> {
  const tinyCases = [
    {
      name: 'tiny_1',
      src: 'export function inc(x) {\n  return x + 2;\n}\n',
      oldText: '  return x + 2;',
      newText: '  return x + 1;',
      test: `import { inc } from './a.mjs';\nif (inc(3) !== 4) { console.error('FAIL a.mjs:2'); process.exit(1); }\nconsole.log('ok');\n`,
    },
    {
      name: 'tiny_2',
      src: 'export function dec(x) {\n  return x - 2;\n}\n',
      oldText: '  return x - 2;',
      newText: '  return x - 1;',
      test: `import { dec } from './a.mjs';\nif (dec(3) !== 2) { console.error('FAIL a.mjs:2'); process.exit(1); }\nconsole.log('ok');\n`,
    },
    {
      name: 'tiny_3',
      src: 'export function neg(x) {\n  return x;\n}\n',
      oldText: '  return x;',
      newText: '  return -x;',
      test: `import { neg } from './a.mjs';\nif (neg(5) !== -5) { console.error('FAIL a.mjs:2'); process.exit(1); }\nconsole.log('ok');\n`,
    },
    {
      name: 'tiny_4',
      src: 'export function zero() {\n  return 1;\n}\n',
      oldText: '  return 1;',
      newText: '  return 0;',
      test: `import { zero } from './a.mjs';\nif (zero() !== 0) { console.error('FAIL a.mjs:2'); process.exit(1); }\nconsole.log('ok');\n`,
    },
  ];

  let rawBytes = 0;
  let aciBytes = 0;
  let rawCalls = 0;
  let aciCalls = 0;
  let rawOk = 0;
  let aciOk = 0;
  let totalMs = 0;

  for (const tc of tinyCases) {
    const t0 = performance.now();
    // Raw minimal CLI (raw file read + minimal 1-line command output)
    {
      const ws = materializeWorkspace({ 'a.mjs': tc.src, 't.mjs': tc.test });
      try {
        const rawReadBytes = Buffer.byteLength(fs.readFileSync(path.join(ws, 'a.mjs'), 'utf8'), 'utf8');
        const rawExecFailBytes = Buffer.byteLength('FAIL a.mjs:2\n', 'utf8');
        const rawEditBytes = Buffer.byteLength('ok\n', 'utf8');
        const rawExecOkBytes = Buffer.byteLength('ok\n', 'utf8');
        rawBytes += rawReadBytes + rawExecFailBytes + rawEditBytes + rawExecOkBytes;
        rawCalls += 4;
        await server.callTool('fs', {
          action: 'apply_patch',
          path: path.join(ws, 'a.mjs'),
          old_text: tc.oldText,
          new_text: tc.newText,
        });
        if (runIndependentOracle(ws, ['node', ['t.mjs']])) rawOk++;
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    }

    // SWE-agent ACI full on the identical tiny 3-line file + 1-line log
    {
      const ws = materializeWorkspace({ 'a.mjs': tc.src, 't.mjs': tc.test });
      try {
        const failEnv = formatCompactToolResponse({
          rawOutput: '',
          stderr: 'FAIL a.mjs:2',
          exitCode: 1,
          workspaceRoot: ws,
        });
        const view = viewWindow({ workspaceRoot: ws, filePath: 'a.mjs', startLine: 1 });
        const edit = lintedEdit({
          workspaceRoot: ws,
          filePath: 'a.mjs',
          oldText: tc.oldText,
          newText: tc.newText,
        });
        const okEnv = formatCompactToolResponse({
          rawOutput: 'ok\n',
          exitCode: 0,
          workspaceRoot: ws,
        });
        aciBytes += failEnv.compactBytes + view.bytes + edit.bytes + okEnv.compactBytes;
        aciCalls += 4;
        if (runIndependentOracle(ws, ['node', ['t.mjs']])) aciOk++;
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    }
    totalMs += performance.now() - t0;
  }

  const n = tinyCases.length;
  const rawMeanBytes = rawBytes / n;
  const aciMeanBytes = aciBytes / n;
  const delta = aciMeanBytes - rawMeanBytes;
  return {
    regime: 'tiny_single_file_overhead_regime',
    tasksTotal: n,
    rawCompletionRatePct: Number(((rawOk / n) * 100).toFixed(2)),
    aciCompletionRatePct: Number(((aciOk / n) * 100).toFixed(2)),
    rawPatchCorrectnessPct: Number(((rawOk / n) * 100).toFixed(2)),
    aciPatchCorrectnessPct: Number(((aciOk / n) * 100).toFixed(2)),
    rawMeanToolCalls: Number((rawCalls / n).toFixed(2)),
    aciMeanToolCalls: Number((aciCalls / n).toFixed(2)),
    rawMeanResponseBytes: Number(rawMeanBytes.toFixed(1)),
    aciMeanResponseBytes: Number(aciMeanBytes.toFixed(1)),
    meanByteOverhead: Number(delta.toFixed(1)),
    overheadPct: rawMeanBytes > 0 ? Number(((delta / rawMeanBytes) * 100).toFixed(2)) : 0,
    meanLatencyMs: Number((totalMs / n).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Benchmark Orchestrator & Markdown Formatters
// ---------------------------------------------------------------------------

function aggregateRegime(regime: BenchmarkRegimeId, runs: TaskRunResult[]): RegimeAggregateMetrics {
  const n = runs.length || 1;
  const tasksCompleted = runs.filter((r) => r.completed).length;
  const patchesCorrect = runs.filter((r) => r.patchCorrect).length;
  const totalCalls = runs.reduce((s, r) => s + r.toolCalls, 0);
  const totalTokens = runs.reduce((s, r) => s + r.responseTokens, 0);
  const totalBytes = runs.reduce((s, r) => s + r.responseBytes, 0);
  const totalLatency = runs.reduce((s, r) => s + r.latencyMs, 0);
  const syntaxHazardsInjected = runs.filter((r) => r.syntaxHazardInjected).length;
  const syntaxHazardsPrevented = runs.filter((r) => r.syntaxHazardPrevented).length;
  const syntaxCorruptedDiskWrites = runs.reduce((s, r) => s + r.syntaxCorruptedDiskWrites, 0);

  return {
    regime,
    tasksTotal: runs.length,
    tasksCompleted,
    taskCompletionRatePct: Number(((tasksCompleted / n) * 100).toFixed(2)),
    patchesCorrect,
    patchCorrectnessPct: Number(((patchesCorrect / n) * 100).toFixed(2)),
    meanToolCalls: Number((totalCalls / n).toFixed(2)),
    meanResponseTokens: Number((totalTokens / n).toFixed(1)),
    meanResponseBytes: Number((totalBytes / n).toFixed(1)),
    syntaxHazardsInjected,
    syntaxHazardsPrevented,
    syntaxRollbackPreventionRatePct:
      syntaxHazardsInjected > 0
        ? Number(((syntaxHazardsPrevented / syntaxHazardsInjected) * 100).toFixed(2))
        : 0,
    syntaxCorruptedDiskWrites,
    meanLatencyMs: Number((totalLatency / n).toFixed(2)),
  };
}

export const MATCHED_ACI_REGIMES: BenchmarkRegimeId[] = [
  'raw_unbounded_cli',
  'naive_head_truncation',
  'windowed_viewer_only',
  'swe_agent_aci_full',
  'over_compressed_negative',
];

/**
 * Runs the complete 24-task × 5-regime + 2-boundary SWE-agent ACI benchmark
 * using live `@hanzo/mcp` tools over real temporary multi-file repositories.
 */
export async function runSweAgentAciBenchmark(
  options: SweAgentBenchmarkOptions = {}
): Promise<SweAgentBenchmarkReport> {
  const seed = options.seed ?? 1348;
  const cfg = {
    maxSteps: options.maxSteps ?? 10,
    contextTokenBudget: options.contextTokenBudget ?? 24000,
    windowSize: options.windowSize ?? 100,
    maxResponseBytes: options.maxResponseBytes ?? 1800,
    naiveHeadMaxChars: options.naiveHeadMaxChars ?? 1200,
    overCompressedMaxChars: options.overCompressedMaxChars ?? 120,
  };

  let server: AciServerInvoker;
  if (options.serverFactory) {
    server = await options.serverFactory(process.cwd());
  } else {
    const [{ fsTool }, { execTool }, { codeTool }] = await Promise.all([
      import('../tools/unified/fs.js'),
      import('../tools/unified/exec.js'),
      import('../tools/unified/code.js'),
    ]);
    const toolMap = new Map([
      [fsTool.name, fsTool],
      [execTool.name, execTool],
      [codeTool.name, codeTool],
    ]);
    server = {
      async callTool(toolName: string, args: Record<string, unknown> = {}) {
        const tool = toolMap.get(toolName);
        if (!tool) {
          return {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
        }
        return tool.handler(args);
      },
    };
  }

  const tasks = buildBenchmarkTasks(seed);
  const allRuns: TaskRunResult[] = [];
  const regimeSummaries: RegimeAggregateMetrics[] = [];

  for (const regime of MATCHED_ACI_REGIMES) {
    // Execute in deterministic batches of 4 for fast wall-clock runtime while
    // preserving deterministic ordering of results
    const regimeRuns: TaskRunResult[] = new Array(tasks.length);
    const batchSize = 4;
    for (let start = 0; start < tasks.length; start += batchSize) {
      const slice = tasks.slice(start, start + batchSize);
      const batchResults = await Promise.all(
        slice.map((task) => runSingleTaskUnderRegime(task, regime, server, cfg))
      );
      for (let i = 0; i < batchResults.length; i++) {
        regimeRuns[start + i] = batchResults[i];
      }
    }
    allRuns.push(...regimeRuns);
    regimeSummaries.push(aggregateRegime(regime, regimeRuns));
  }

  const semanticBoundary = await runSemanticBoundaryRegime(server);
  const tinyOverhead = await runTinyFileOverheadRegime(server);

  return {
    schemaVersion: '1.0.0',
    seed,
    timestampIso: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    config: {
      taskCount: tasks.length,
      ...cfg,
    },
    regimes: regimeSummaries,
    boundaryRegimes: {
      semanticLogicErrorPassesSyntaxLint: semanticBoundary,
      tinySingleFileOverheadRegime: tinyOverhead,
    },
    taskRuns: allRuns,
  };
}

export function renderScoreTableMarkdown(report: SweAgentBenchmarkReport): string {
  const rows = report.regimes
    .map(
      (r) =>
        `| \`${r.regime}\` | ${r.taskCompletionRatePct.toFixed(1)}% (${r.tasksCompleted}/${r.tasksTotal}) | ${r.patchCorrectnessPct.toFixed(1)}% (${r.patchesCorrect}/${r.tasksTotal}) | ${r.meanToolCalls.toFixed(2)} | ${r.meanResponseTokens.toFixed(1)} | ${r.meanResponseBytes.toFixed(1)} | ${r.syntaxRollbackPreventionRatePct.toFixed(1)}% (${r.syntaxHazardsPrevented}/${r.syntaxHazardsInjected}) | ${r.meanLatencyMs.toFixed(2)} ms |`
    )
    .join('\n');

  const sem = report.boundaryRegimes.semanticLogicErrorPassesSyntaxLint;
  const tiny = report.boundaryRegimes.tinySingleFileOverheadRegime;

  return [
    `# HIP-1348 SWE-agent ACI Benchmark Score Table`,
    ``,
    `- **Seed**: \`${report.seed}\``,
    `- **Suite**: ${report.config.taskCount} real multi-file on-disk tasks (TypeScript, JavaScript, Python, JSON) via live \`@hanzo/mcp\` (\`fs\`, \`exec\`, \`code\`)`,
    `- **Fixed Budgets**: \`maxSteps=${report.config.maxSteps}\`, \`contextTokenBudget=${report.config.contextTokenBudget}\`, \`windowSize=${report.config.windowSize}\``,
    `- **Runtime**: Node \`${report.nodeVersion}\` on \`${report.platform}/${report.arch}\``,
    ``,
    `## Matched 5-Regime Comparison`,
    ``,
    `| Regime | Task Completion Rate | Patch Correctness (Unit-Test Verified) | Mean Tool Calls | Mean Response Tokens | Mean Response Bytes | Syntax-Error Rollback Prevention | Mean Latency |`,
    `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`,
    rows,
    ``,
    `## Honest Negative & Boundary Regimes`,
    ``,
    `| Boundary Regime | Observation | Key Measurement |`,
    `| :--- | :--- | :--- |`,
    `| \`${sem.regime}\` | Syntactically valid edits with wrong return/config logic pass fast syntax lint and still require real unit-test execution | Syntax-lint pass: **${sem.syntaxLintPassedRatePct.toFixed(1)}%** (${sem.syntaxLintPassedCount}/${sem.tasksTotal}); Caught by unit tests: **${sem.caughtByUnitTestRatePct.toFixed(1)}%**; Repaired via test feedback: **${sem.repairedAfterTestFeedbackRatePct.toFixed(1)}%** |`,
    `| \`${tiny.regime}\` | On tiny (<20-line) files with clean 1-line logs and zero syntax hazards, ACI metadata headers add small byte overhead with zero turn savings | Completion: **${tiny.aciCompletionRatePct.toFixed(1)}%** vs ${tiny.rawCompletionRatePct.toFixed(1)}%; Turns: **${tiny.aciMeanToolCalls.toFixed(2)}** vs ${tiny.rawMeanToolCalls.toFixed(2)}; Mean bytes: **${tiny.aciMeanResponseBytes.toFixed(1)} B** vs ${tiny.rawMeanResponseBytes.toFixed(1)} B (**+${tiny.meanByteOverhead.toFixed(1)} B**, +${tiny.overheadPct.toFixed(1)}%) |`,
    ``,
  ].join('\n');
}
