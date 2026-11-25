/**
 * Reproducible A/B SWE-agent ACI Evaluation Benchmark (HIP-1347 / #48 / #44).
 *
 * Compares three matched Agent-Computer Interfaces across 8 multi-step software
 * engineering localization & editing trajectories (TypeScript, JSON, Rust, Python, Go)
 * plus a 4-task small-file negative/boundary control:
 *
 *   1. `raw_shell_cat_sed`:
 *      Unbounded `cat <file>`, unguarded `sed`-style search/replace on disk,
 *      follow-up `cat` verification, and raw ANSI/stack-trace command output.
 *   2. `unwindowed_str_replace`:
 *      Full-file `fs.read` + unlinted exact string replacement (catches duplicates,
 *      but writes broken syntax to disk and consumes full-file & raw-log context).
 *   3. `swe_agent_guarded_aci`:
 *      `WindowedFileViewer` (100-line viewport + `search_file` match indices + `goto_line`),
 *      `GuardedFileEditor` (uniqueness gate + pre-flight syntax lint gate BEFORE disk write
 *      + inline `+/-` post-edit snippet), and `compactCommandOutput` (ANSI strip,
 *      duplicate stack-frame collapse, head/diagnostic/tail, structured footer).
 *
 * Usage:
 *   npx tsx bench/aci-swe-eval.ts
 *   npx tsx bench/aci-swe-eval.ts --json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import {
  GuardedFileEditor,
  WindowedFileViewer,
  compactCommandOutput,
  computeContentHash,
  estimateTokens,
  preflightSyntaxCheck,
} from '../src/aci/index.js';

export type StrategyName =
  | 'raw_shell_cat_sed'
  | 'unwindowed_str_replace'
  | 'swe_agent_guarded_aci';

export interface ProposedEditStep {
  description: string;
  searchBlock: string;
  replaceBlock: string;
  expectedStartLine?: number;
  /** True if this candidate step intentionally models an agent draft mistake (syntax or ambiguity). */
  isDraftHazard?: boolean;
}

export interface BenchmarkTrajectorySpec {
  id: string;
  language: 'ts' | 'json' | 'rust' | 'python' | 'go';
  filePath: string;
  initialContent: string;
  searchQuery: string;
  targetLine: number;
  initialFailingCommandLog: string;
  syntaxFailureCompilerLog: string;
  passingVerifyCommandLog: string;
  /** Ordered sequence of edit attempts; if a draft hazard fails or corrupts, recovery edit follows. */
  editSequence: ProposedEditStep[];
  /** Ground-truth predicate confirming final file on disk has the exact intended bug fix. */
  verifyFinalContent: (diskContent: string) => boolean;
}

export interface TrajectoryRunOutcome {
  trajectoryId: string;
  strategy: StrategyName;
  turns: number;
  contextChars: number;
  contextTokens: number;
  editAttempts: number;
  corruptedDiskWrites: number;
  preFlightRejections: number;
  patchCorrect: boolean;
  completedWithinBudget: boolean;
  wallClockMs: number;
}

export interface StrategyAggregateSummary {
  strategy: StrategyName;
  trajectories: number;
  totalContextTokens: number;
  meanContextTokens: number;
  totalEditAttempts: number;
  syntaxCorruptedDiskWrites: number;
  syntaxCorruptedEditRatePct: number;
  meanTurnsToConvergence: number;
  patchCorrectnessRatePct: number;
  taskCompletionRatePct: number;
  meanWallClockMs: number;
  p50WallClockMs: number;
  p95WallClockMs: number;
  totalWallClockMs: number;
}

export interface AciBenchmarkReport {
  contextBudgetTokensPerTask: number;
  primarySuite: {
    trajectoryCount: number;
    aggregates: Record<StrategyName, StrategyAggregateSummary>;
    runs: TrajectoryRunOutcome[];
    deltasVsRawShell: {
      tokenReductionPct: number;
      turnReductionPct: number;
      corruptedEditRateReductionPp: number;
      completionLiftPp: number;
    };
    deltasVsUnwindowed: {
      tokenReductionPct: number;
      turnReductionPct: number;
      corruptedEditRateReductionPp: number;
      completionLiftPp: number;
    };
  };
  negativeControl: {
    trajectoryCount: number;
    aggregates: Record<StrategyName, StrategyAggregateSummary>;
  };
}

const DEFAULT_CONTEXT_BUDGET_TOKENS = 16000;

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  );
  return Number(sortedValues[idx].toFixed(3));
}

function buildLargeTsModule(
  totalLines: number,
  injections: Record<number, string>
): string {
  const rows: string[] = [];
  for (let ln = 1; ln <= totalLines; ln++) {
    if (injections[ln] !== undefined) {
      rows.push(injections[ln]);
    } else {
      rows.push(
        `export const telemetrySlot_${ln} = { bucket: ${ln}, tag: "region_${ln % 16}", weight: ${(ln * 7) % 97} };`
      );
    }
  }
  return rows.join('\n') + '\n';
}

function buildNoisyTestLog(
  passCount: number,
  failHeader: string,
  errorBody: string[],
  summaryLine: string
): string {
  const passLines = Array.from(
    { length: passCount },
    (_, i) => `\x1b[32mPASS\x1b[0m test/suite/module_${i + 1}.test.ts (${12 + (i % 9)} ms)`
  );
  return [
    '\x1b[1m$ pnpm test --runInBand\x1b[0m',
    'Resolving workspace packages 20%\rResolving workspace packages 75%\rResolving workspace packages 100%',
    ...passLines,
    `\x1b[31mFAIL\x1b[0m ${failHeader}`,
    ...errorBody,
    summaryLine,
  ].join('\n');
}

export function createPrimaryTrajectories(): BenchmarkTrajectorySpec[] {
  // 1. TypeScript rate limiter (720 lines) - draft syntax error (missing closing ')') then clean fix
  const t1Content = buildLargeTsModule(720, {
    484: 'export function computeRefillTokens(elapsedMs: number, windowMs: number, burst: number): number {',
    485: '  const clampedElapsed = Math.max(0, elapsedMs);',
    486: '  const ratio = clampedElapsed / windowMs;',
    487: '  return Math.min(burst, Math.floor(ratio * burst));',
    488: '}',
  });

  // 2. TypeScript HTTP transport (840 lines) - 3 duplicate backoff lines; target is uploadMultipart at line 692
  const t2Content = buildLargeTsModule(840, {
    138: 'export function backoffFetchJson(baseDelayMs: number, attempt: number): number {',
    139: '  const delayMs = baseDelayMs * attempt;',
    140: '  return Math.min(5000, delayMs);',
    141: '}',
    410: 'export function backoffStreamEvents(baseDelayMs: number, attempt: number): number {',
    411: '  const delayMs = baseDelayMs * attempt;',
    412: '  return Math.min(10000, delayMs);',
    413: '}',
    690: 'export function backoffUploadMultipart(baseDelayMs: number, attempt: number): number {',
    691: '  const delayMs = baseDelayMs * attempt;',
    692: '  return Math.min(30000, delayMs);',
    693: '}',
  });

  // 3. JSON route manifest (520 lines) - draft trailing comma JSON syntax hazard before clean edit
  const jsonEntries: string[] = ['{', '  "version": 2,', '  "routes": ['];
  for (let i = 1; i <= 168; i++) {
    const timeoutVal = i === 112 ? 0 : 2500 + i;
    const comma = i < 168 ? ',' : '';
    jsonEntries.push(`    {`);
    jsonEntries.push(`      "id": "route_${i}",`);
    jsonEntries.push(`      "timeoutMs": ${timeoutVal}`);
    jsonEntries.push(`    }${comma}`);
  }
  jsonEntries.push('  ]', '}');
  const t3Content = jsonEntries.join('\n') + '\n';

  // 4. TypeScript AST walker (960 lines) + massive recursive stack overflow log (460 stack frames)
  const t4Content = buildLargeTsModule(960, {
    774: 'export function walkGraphNode(nodeId: string, edges: Map<string, string[]>, visited = new Set<string>()): number {',
    775: '  const children = edges.get(nodeId) ?? [];',
    776: '  let count = 1;',
    777: '  for (const child of children) {',
    778: '    count += walkGraphNode(child, edges, visited);',
    779: '  }',
    780: '  return count;',
    781: '}',
  });
  const recursiveStack = [
    'RangeError: Maximum call stack size exceeded',
    ...Array.from({ length: 380 }, () => '    at walkGraphNode (src/graph/walker.ts:778:14)'),
    ...Array.from(
      { length: 60 },
      (_, idx) => `    at Runtime._execModule (node_modules/jest-runtime/build/index.js:${900 + idx}:12)`
    ),
  ];

  // 5. Rust KV page slice (900 lines) - draft missing closing '}' before clean bounds check fix
  const rustRows: string[] = [];
  for (let ln = 1; ln <= 900; ln++) {
    if (ln === 712) {
      rustRows.push("pub fn read_slot_slice<'a>(page: &'a [u8], offset: usize, len: usize) -> &'a [u8] {");
    } else if (ln === 713) {
      rustRows.push('    let label = r#"slot(raw)[header]"#;');
    } else if (ln === 714) {
      rustRows.push('    let _ = label.len();');
    } else if (ln === 715) {
      rustRows.push('    &page[offset..offset + len]');
    } else if (ln === 716) {
      rustRows.push('}');
    } else {
      rustRows.push(`pub const PAGE_META_${ln}: usize = ${ln * 64}; // aligned page constant`);
    }
  }
  const t5Content = rustRows.join('\n') + '\n';
  const noisyCargoFail = [
    ...Array.from(
      { length: 580 },
      (_, i) => `\x1b[32m   Compiling\x1b[0m hanzo_crate_${i} v0.4.${i % 9} (/workspace/crates/c_${i})`
    ),
    'thread \'kv_page::oob_slice\' panicked at src/kv_page.rs:715:6:',
    'range end index 4128 out of range for slice of length 4096',
    'test result: FAILED. 312 passed; 1 failed; 0 ignored',
  ].join('\n');

  // 6. Python batch tokenizer (680 lines) - clean 2-step edit across pad & mask functions
  const pyRows: string[] = [];
  for (let ln = 1; ln <= 680; ln++) {
    if (ln === 210) {
      pyRows.push('def compute_pad_width(seq_len: int, multiple: int) -> int:');
    } else if (ln === 211) {
      pyRows.push('    """Compute padding width; note example {braces: [1, 2} in docstring."""');
    } else if (ln === 212) {
      pyRows.push('    return multiple - (seq_len % multiple)');
    } else if (ln === 588) {
      pyRows.push('def normalize_attention_scale(head_dim: int) -> float:');
    } else if (ln === 589) {
      pyRows.push('    return 1.0 / head_dim');
    } else {
      pyRows.push(`TOKEN_BUCKET_${ln} = ("tok_${ln}", ${ln * 3})`);
    }
  }
  const t6Content = pyRows.join('\n') + '\n';

  // 7. Go WAL segment writer (760 lines) - clean localization & edit with noisy `go test -v` log
  const goRows: string[] = ['package wal', ''];
  for (let ln = 3; ln <= 760; ln++) {
    if (ln === 518) {
      goRows.push('func RemainingSegmentBytes(capacity int64, used int64) int64 {');
    } else if (ln === 519) {
      goRows.push('\tconst headerSpec = `wal:v1(raw_header`');
    } else if (ln === 520) {
      goRows.push('\t_ = len(headerSpec)');
    } else if (ln === 521) {
      goRows.push('\treturn capacity - used');
    } else if (ln === 522) {
      goRows.push('}');
    } else {
      goRows.push(`var segmentMarker${ln} int64 = ${ln * 128}`);
    }
  }
  const t7Content = goRows.join('\n') + '\n';

  // 8. TypeScript SQL template builder (660 lines) - draft mismatched template delimiter `${... )`
  const t8Content = buildLargeTsModule(660, {
    402: 'export function buildTenantFilterSql(tenantId: string, limit: number): string {',
    403: '  const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, "");',
    404: '  return `SELECT id, payload FROM events WHERE tenant_id = \'${safeTenant}\' LIMIT ${limit}`;',
    405: '}',
  });

  return [
    {
      id: 'ts-rate-limiter-zero-window',
      language: 'ts',
      filePath: 'src/limiter/rate-limiter.ts',
      initialContent: t1Content,
      searchQuery: 'computeRefillTokens',
      targetLine: 486,
      initialFailingCommandLog: buildNoisyTestLog(
        420,
        'test/limiter/rate-limiter.test.ts',
        [
          '  computeRefillTokens > returns 0 when windowMs is 0',
          '    Expected: 0',
          '    Received: NaN',
          '      at Object.<anonymous> (src/limiter/rate-limiter.ts:486:27)',
        ],
        'Tests: 1 failed, 420 passed, 421 total'
      ),
      syntaxFailureCompilerLog: buildNoisyTestLog(
        180,
        'src/limiter/rate-limiter.ts',
        [
          'src/limiter/rate-limiter.ts:486:52 - error TS1005: \')\' expected.',
          '486   const ratio = clampedElapsed / Math.max(1, windowMs;',
        ],
        'Found 1 error in src/limiter/rate-limiter.ts:486'
      ),
      passingVerifyCommandLog: buildNoisyTestLog(
        421,
        '(none)',
        [],
        'Tests: 0 failed, 421 passed, 421 total'
      ).replace('\x1b[31mFAIL\x1b[0m (none)\n', ''),
      editSequence: [
        {
          description: 'Draft edit missing closing parenthesis on Math.max',
          searchBlock: '  const ratio = clampedElapsed / windowMs;',
          replaceBlock: '  const ratio = clampedElapsed / Math.max(1, windowMs;',
          isDraftHazard: true,
        },
        {
          description: 'Corrected balanced guard for zero windowMs',
          searchBlock: '  const ratio = clampedElapsed / windowMs;',
          replaceBlock: '  const ratio = windowMs <= 0 ? 0 : clampedElapsed / windowMs;',
        },
      ],
      verifyFinalContent: (c) =>
        c.includes('const ratio = windowMs <= 0 ? 0 : clampedElapsed / windowMs;') &&
        preflightSyntaxCheck(c, { filePath: 'rate-limiter.ts' }).length === 0,
    },
    {
      id: 'ts-ambiguous-retry-backoff',
      language: 'ts',
      filePath: 'src/net/transport.ts',
      initialContent: t2Content,
      searchQuery: 'baseDelayMs * attempt',
      targetLine: 691,
      initialFailingCommandLog: buildNoisyTestLog(
        460,
        'test/net/transport.test.ts',
        [
          '  backoffUploadMultipart > uses exponential 2^attempt scaling',
          '    Expected: 800',
          '    Received: 300',
          '      at backoffUploadMultipart (src/net/transport.ts:691:19)',
        ],
        'Tests: 1 failed, 460 passed, 461 total'
      ),
      syntaxFailureCompilerLog: buildNoisyTestLog(
        458,
        'test/net/transport.test.ts',
        [
          '  backoffFetchJson > preserves linear retry delay',
          '    Expected: 300',
          '    Received: 800',
          '      at backoffFetchJson (src/net/transport.ts:139:19)',
        ],
        'Tests: 2 failed, 459 passed, 461 total'
      ),
      passingVerifyCommandLog: buildNoisyTestLog(
        461,
        '(none)',
        [],
        'Tests: 0 failed, 461 passed, 461 total'
      ).replace('\x1b[31mFAIL\x1b[0m (none)\n', ''),
      editSequence: [
        {
          description: 'Ambiguous 1-line searchBlock matching 3 functions',
          searchBlock: '  const delayMs = baseDelayMs * attempt;',
          replaceBlock: '  const delayMs = baseDelayMs * Math.pow(2, Math.max(0, attempt));',
          isDraftHazard: true,
        },
        {
          description: 'Context-disambiguated edit targeting backoffUploadMultipart only',
          searchBlock:
            'export function backoffUploadMultipart(baseDelayMs: number, attempt: number): number {\n  const delayMs = baseDelayMs * attempt;',
          replaceBlock:
            'export function backoffUploadMultipart(baseDelayMs: number, attempt: number): number {\n  const delayMs = baseDelayMs * Math.pow(2, Math.max(0, attempt));',
          expectedStartLine: 690,
        },
      ],
      verifyFinalContent: (c) =>
        c.includes(
          'export function backoffFetchJson(baseDelayMs: number, attempt: number): number {\n  const delayMs = baseDelayMs * attempt;'
        ) &&
        c.includes(
          'export function backoffUploadMultipart(baseDelayMs: number, attempt: number): number {\n  const delayMs = baseDelayMs * Math.pow(2, Math.max(0, attempt));'
        ),
    },
    {
      id: 'json-route-manifest-trailing-comma',
      language: 'json',
      filePath: 'config/routes.json',
      initialContent: t3Content,
      searchQuery: '"route_112"',
      targetLine: 452,
      initialFailingCommandLog: buildNoisyTestLog(
        310,
        'test/config/routes.test.ts',
        [
          '  routes.json > route_112 enforces positive timeoutMs',
          '    Expected: >= 1000',
          '    Received: 0',
          '      at validateRoutes (config/routes.json:452:7)',
        ],
        'Tests: 1 failed, 310 passed, 311 total'
      ),
      syntaxFailureCompilerLog:
        'SyntaxError: Expected double-quoted property name in JSON at position 5840\n    at JSON.parse (<anonymous>)\n' +
        Array.from({ length: 240 }, (_, i) => `    at bootCheck_${i} (src/boot.ts:${i + 10}:5)`).join('\n'),
      passingVerifyCommandLog: 'Validated 168 routes cleanly.\nTests: 0 failed, 311 passed, 311 total',
      editSequence: [
        {
          description: 'Draft JSON replacement leaving trailing comma before closing brace',
          searchBlock: '      "id": "route_112",\n      "timeoutMs": 0',
          replaceBlock: '      "id": "route_112",\n      "timeoutMs": 5000,',
          isDraftHazard: true,
        },
        {
          description: 'Valid JSON replacement without trailing comma',
          searchBlock: '      "id": "route_112",\n      "timeoutMs": 0',
          replaceBlock: '      "id": "route_112",\n      "timeoutMs": 5000',
        },
      ],
      verifyFinalContent: (c) => {
        try {
          const parsed = JSON.parse(c);
          const r112 = parsed.routes.find((r: any) => r.id === 'route_112');
          return r112?.timeoutMs === 5000;
        } catch {
          return false;
        }
      },
    },
    {
      id: 'ts-recursive-ast-stack-overflow',
      language: 'ts',
      filePath: 'src/graph/walker.ts',
      initialContent: t4Content,
      searchQuery: 'walkGraphNode',
      targetLine: 775,
      initialFailingCommandLog: buildNoisyTestLog(
        510,
        'test/graph/walker.test.ts',
        recursiveStack,
        'Tests: 1 failed, 510 passed, 511 total'
      ),
      syntaxFailureCompilerLog: '',
      passingVerifyCommandLog: buildNoisyTestLog(
        511,
        '(none)',
        [],
        'Tests: 0 failed, 511 passed, 511 total'
      ).replace('\x1b[31mFAIL\x1b[0m (none)\n', ''),
      editSequence: [
        {
          description: 'Guard cycle visitation in walkGraphNode before recursing',
          searchBlock:
            'export function walkGraphNode(nodeId: string, edges: Map<string, string[]>, visited = new Set<string>()): number {\n  const children = edges.get(nodeId) ?? [];',
          replaceBlock:
            'export function walkGraphNode(nodeId: string, edges: Map<string, string[]>, visited = new Set<string>()): number {\n  if (visited.has(nodeId)) return 0;\n  visited.add(nodeId);\n  const children = edges.get(nodeId) ?? [];',
        },
      ],
      verifyFinalContent: (c) =>
        c.includes('if (visited.has(nodeId)) return 0;') &&
        preflightSyntaxCheck(c, { filePath: 'walker.ts' }).length === 0,
    },
    {
      id: 'rust-kv-page-bounds-check',
      language: 'rust',
      filePath: 'src/kv_page.rs',
      initialContent: t5Content,
      searchQuery: 'read_slot_slice',
      targetLine: 715,
      initialFailingCommandLog: noisyCargoFail,
      syntaxFailureCompilerLog:
        noisyCargoFail + '\nerror: this file contains an unclosed delimiter at src/kv_page.rs:901:1',
      passingVerifyCommandLog: [
        ...Array.from({ length: 120 }, (_, i) => `test kv_page::case_${i} ... ok`),
        'test result: ok. 313 passed; 0 failed; 0 ignored',
      ].join('\n'),
      editSequence: [
        {
          description: 'Draft Rust bounds check missing closing brace on if-block',
          searchBlock: '    &page[offset..offset + len]',
          replaceBlock:
            '    if offset >= page.len() {\n        return &[];\n    let end = (offset + len).min(page.len());\n    &page[offset..end]',
          isDraftHazard: true,
        },
        {
          description: 'Balanced Rust bounds check clamping offset and end',
          searchBlock: '    &page[offset..offset + len]',
          replaceBlock:
            '    if offset >= page.len() {\n        return &[];\n    }\n    let end = (offset + len).min(page.len());\n    &page[offset..end]',
        },
      ],
      verifyFinalContent: (c) =>
        c.includes('let end = (offset + len).min(page.len());') &&
        preflightSyntaxCheck(c, { filePath: 'kv_page.rs' }).length === 0,
    },
    {
      id: 'py-batch-tokenizer-padding',
      language: 'python',
      filePath: 'tokenizer/batch.py',
      initialContent: t6Content,
      searchQuery: 'compute_pad_width',
      targetLine: 212,
      initialFailingCommandLog: [
        '============================= test session starts ==============================',
        ...Array.from({ length: 380 }, (_, i) => `tokenizer/tests/test_ops.py::test_case_${i} PASSED`),
        'FAILED tokenizer/tests/test_batch.py::test_exact_multiple_zero_pad - AssertionError: assert 8 == 0',
        '  File "tokenizer/batch.py", line 212, in compute_pad_width',
        '=================== 1 failed, 380 passed in 2.41s ====================',
      ].join('\n'),
      syntaxFailureCompilerLog: '',
      passingVerifyCommandLog:
        '============================= test session starts ==============================\n' +
        '=================== 381 passed in 1.92s ====================',
      editSequence: [
        {
          description: 'Return 0 pad width when seq_len is already a multiple',
          searchBlock: '    return multiple - (seq_len % multiple)',
          replaceBlock: '    rem = seq_len % multiple\n    return 0 if rem == 0 else multiple - rem',
        },
      ],
      verifyFinalContent: (c) =>
        c.includes('return 0 if rem == 0 else multiple - rem') &&
        preflightSyntaxCheck(c, { filePath: 'batch.py' }).length === 0,
    },
    {
      id: 'go-wal-segment-underflow',
      language: 'go',
      filePath: 'wal/segment.go',
      initialContent: t7Content,
      searchQuery: 'RemainingSegmentBytes',
      targetLine: 521,
      initialFailingCommandLog: [
        ...Array.from({ length: 420 }, (_, i) => `=== RUN   TestSegment_${i}\n--- PASS: TestSegment_${i} (0.00s)`),
        '--- FAIL: TestRemainingSegmentBytesClamp (0.01s)',
        '    segment_test.go:88: expected 0 when used > capacity, got -64 (wal/segment.go:521)',
        'FAIL\tgithub.com/hanzoai/mcp/wal\t1.148s',
      ].join('\n'),
      syntaxFailureCompilerLog: '',
      passingVerifyCommandLog: 'PASS\nok  \tgithub.com/hanzoai/mcp/wal\t0.612s',
      editSequence: [
        {
          description: 'Clamp negative remaining WAL bytes to 0',
          searchBlock: '\treturn capacity - used',
          replaceBlock: '\tif used >= capacity {\n\t\treturn 0\n\t}\n\treturn capacity - used',
        },
      ],
      verifyFinalContent: (c) =>
        c.includes('if used >= capacity {') &&
        preflightSyntaxCheck(c, { filePath: 'segment.go' }).length === 0,
    },
    {
      id: 'ts-nested-template-sql-builder',
      language: 'ts',
      filePath: 'src/query/builder.ts',
      initialContent: t8Content,
      searchQuery: 'buildTenantFilterSql',
      targetLine: 404,
      initialFailingCommandLog: buildNoisyTestLog(
        390,
        'test/query/builder.test.ts',
        [
          '  buildTenantFilterSql > clamps negative limit to 1',
          '    Expected: "SELECT id, payload FROM events WHERE tenant_id = \'acme\' LIMIT 1"',
          '    Received: "SELECT id, payload FROM events WHERE tenant_id = \'acme\' LIMIT -5"',
          '      at Object.<anonymous> (src/query/builder.ts:404:10)',
        ],
        'Tests: 1 failed, 390 passed, 391 total'
      ),
      syntaxFailureCompilerLog: buildNoisyTestLog(
        120,
        'src/query/builder.ts',
        ['src/query/builder.ts:404:99 - error TS1005: \'}\' expected in template expression.'],
        'Found 1 error in src/query/builder.ts:404'
      ),
      passingVerifyCommandLog: buildNoisyTestLog(
        391,
        '(none)',
        [],
        'Tests: 0 failed, 391 passed, 391 total'
      ).replace('\x1b[31mFAIL\x1b[0m (none)\n', ''),
      editSequence: [
        {
          description: 'Draft template expression with mismatched closing paren/brace',
          searchBlock:
            "  return `SELECT id, payload FROM events WHERE tenant_id = '${safeTenant}' LIMIT ${limit}`;",
          replaceBlock:
            "  return `SELECT id, payload FROM events WHERE tenant_id = '${safeTenant}' LIMIT ${Math.max(1, Math.trunc(limit)}`;",
          isDraftHazard: true,
        },
        {
          description: 'Balanced nested expression inside template literal',
          searchBlock:
            "  return `SELECT id, payload FROM events WHERE tenant_id = '${safeTenant}' LIMIT ${limit}`;",
          replaceBlock:
            "  return `SELECT id, payload FROM events WHERE tenant_id = '${safeTenant}' LIMIT ${Math.max(1, Math.trunc(limit))}`;",
        },
      ],
      verifyFinalContent: (c) =>
        c.includes('Math.max(1, Math.trunc(limit))') &&
        preflightSyntaxCheck(c, { filePath: 'builder.ts' }).length === 0,
    },
  ];
}

export function createNegativeControlTrajectories(): BenchmarkTrajectorySpec[] {
  // 4 tiny 24-line files with short 4-line logs and clean single-step edits
  return Array.from({ length: 4 }, (_, idx) => {
    const idNum = idx + 1;
    const rows = Array.from({ length: 24 }, (__, k) => {
      const ln = k + 1;
      if (ln === 10) return `export function tinyCalc_${idNum}(x: number): number {`;
      if (ln === 11) return `  return x - ${idNum};`;
      if (ln === 12) return '}';
      return `export const tinyConst_${idNum}_${ln} = ${ln};`;
    });
    const initialContent = rows.join('\n') + '\n';
    return {
      id: `small-control-${idNum}`,
      language: 'ts' as const,
      filePath: `src/tiny_${idNum}.ts`,
      initialContent,
      searchQuery: `tinyCalc_${idNum}`,
      targetLine: 11,
      initialFailingCommandLog: `FAIL test/tiny_${idNum}.test.ts\n  Expected ${idNum + 10}, received ${10 - idNum} at src/tiny_${idNum}.ts:11:3`,
      syntaxFailureCompilerLog: '',
      passingVerifyCommandLog: `PASS test/tiny_${idNum}.test.ts (1 passed)`,
      editSequence: [
        {
          description: 'Single-line sign fix on small 24-line file',
          searchBlock: `  return x - ${idNum};`,
          replaceBlock: `  return x + ${idNum};`,
        },
      ],
      verifyFinalContent: (c) => c.includes(`return x + ${idNum};`),
    };
  });
}

function executeRawShellCatSed(
  spec: BenchmarkTrajectorySpec,
  absFilePath: string,
  budgetTokens: number
): TrajectoryRunOutcome {
  const t0 = performance.now();
  let turns = 0;
  let contextChars = 0;
  let editAttempts = 0;
  let corruptedDiskWrites = 0;

  // Turn 1: Run test command (unbounded stdout/stderr)
  turns++;
  contextChars += spec.initialFailingCommandLog.length;

  // Turn 2: `cat <file>` (reads entire unwindowed file)
  turns++;
  const initialRead = fs.readFileSync(absFilePath, 'utf8');
  contextChars += initialRead.length;

  for (const step of spec.editSequence) {
    // `sed -i` global replacement on disk without uniqueness or pre-flight syntax check
    turns++;
    editAttempts++;
    const beforeDisk = fs.readFileSync(absFilePath, 'utf8');
    const mutated = beforeDisk.split(step.searchBlock).join(step.replaceBlock);
    fs.writeFileSync(absFilePath, mutated, 'utf8');

    // Follow-up `cat <file>` to inspect raw sed edit (sed emits 0 context lines)
    turns++;
    contextChars += fs.readFileSync(absFilePath, 'utf8').length;

    const syntaxDiags = preflightSyntaxCheck(mutated, {
      filePath: spec.filePath,
      language: spec.language,
    });
    const wrongMultiMutation =
      step.isDraftHazard && beforeDisk.split(step.searchBlock).length - 1 > 1;

    if (syntaxDiags.length > 0 || wrongMultiMutation) {
      corruptedDiskWrites++;
      // Agent only discovers corruption by running compiler/test command on broken disk state
      turns++;
      contextChars += spec.syntaxFailureCompilerLog.length;
      // Restore clean base via `git checkout -- <file>` + `cat` before retry
      turns++;
      fs.writeFileSync(absFilePath, spec.initialContent, 'utf8');
      contextChars += spec.initialContent.length;
    } else {
      // Final verification test run (unbounded log)
      turns++;
      contextChars += spec.passingVerifyCommandLog.length;
      break;
    }
  }

  const wallClockMs = performance.now() - t0;
  const contextTokens = estimateTokens(contextChars);
  const finalDisk = fs.readFileSync(absFilePath, 'utf8');
  const patchCorrect = spec.verifyFinalContent(finalDisk);
  const completedWithinBudget = patchCorrect && contextTokens <= budgetTokens;

  return {
    trajectoryId: spec.id,
    strategy: 'raw_shell_cat_sed',
    turns,
    contextChars,
    contextTokens,
    editAttempts,
    corruptedDiskWrites,
    preFlightRejections: 0,
    patchCorrect,
    completedWithinBudget,
    wallClockMs,
  };
}

function executeUnwindowedStrReplace(
  spec: BenchmarkTrajectorySpec,
  absFilePath: string,
  budgetTokens: number
): TrajectoryRunOutcome {
  const t0 = performance.now();
  let turns = 0;
  let contextChars = 0;
  let editAttempts = 0;
  let corruptedDiskWrites = 0;

  // Turn 1: Uncompressed test run
  turns++;
  contextChars += spec.initialFailingCommandLog.length;

  // Turn 2: Full-file `fs.read` (default 2,000-line limit dumps entire file)
  turns++;
  const fullRead = fs.readFileSync(absFilePath, 'utf8');
  contextChars += fullRead.length;

  for (const step of spec.editSequence) {
    turns++;
    editAttempts++;
    const current = fs.readFileSync(absFilePath, 'utf8');
    const occurrences = current.split(step.searchBlock).length - 1;

    if (occurrences !== 1) {
      // Rejects duplicate match, but provides no line indices -> requires full grep/read scan
      contextChars += `Error: searchBlock matched ${occurrences} times\n`.length;
      turns++;
      contextChars += current.length;
      continue;
    }

    // Applies without pre-flight syntax check -> writes broken syntax directly to disk
    const updated = current.replace(step.searchBlock, step.replaceBlock);
    fs.writeFileSync(absFilePath, updated, 'utf8');
    contextChars += 80; // "Edit applied" status without post-edit numbered window

    const syntaxDiags = preflightSyntaxCheck(updated, {
      filePath: spec.filePath,
      language: spec.language,
    });
    if (syntaxDiags.length > 0) {
      corruptedDiskWrites++;
      // Discovers syntax break via full compiler/test invocation + full re-read
      turns++;
      contextChars += spec.syntaxFailureCompilerLog.length;
      turns++;
      fs.writeFileSync(absFilePath, spec.initialContent, 'utf8');
      contextChars += spec.initialContent.length;
    } else {
      // Verification test run (uncompressed)
      turns++;
      contextChars += spec.passingVerifyCommandLog.length;
      break;
    }
  }

  const wallClockMs = performance.now() - t0;
  const contextTokens = estimateTokens(contextChars);
  const finalDisk = fs.readFileSync(absFilePath, 'utf8');
  const patchCorrect = spec.verifyFinalContent(finalDisk);
  const completedWithinBudget = patchCorrect && contextTokens <= budgetTokens;

  return {
    trajectoryId: spec.id,
    strategy: 'unwindowed_str_replace',
    turns,
    contextChars,
    contextTokens,
    editAttempts,
    corruptedDiskWrites,
    preFlightRejections: 0,
    patchCorrect,
    completedWithinBudget,
    wallClockMs,
  };
}

function executeSweAgentGuardedAci(
  spec: BenchmarkTrajectorySpec,
  workspaceRoot: string,
  absFilePath: string,
  budgetTokens: number
): TrajectoryRunOutcome {
  const t0 = performance.now();
  let turns = 0;
  let contextChars = 0;
  let editAttempts = 0;
  let corruptedDiskWrites = 0;
  let preFlightRejections = 0;

  const viewer = new WindowedFileViewer({ workspaceRoot, windowSize: 100 });
  const editor = new GuardedFileEditor({ workspaceRoot, viewer, contextLines: 4 });

  // Turn 1: Bounded command output compressor extracts failure span & strips noise
  turns++;
  const initialCompact = compactCommandOutput(spec.initialFailingCommandLog, {
    exitCode: 1,
    elapsedMs: 420,
  });
  contextChars += initialCompact.output.length;

  // Turn 2: Search file for symbol/span and jump 100-line viewport directly to match
  turns++;
  const searchRes = viewer.search_file(spec.searchQuery, {
    filePath: spec.filePath,
    autoJump: true,
  });
  contextChars += searchRes.rendered.length + (searchRes.window?.rendered.length ?? 0);

  for (const step of spec.editSequence) {
    turns++;
    editAttempts++;
    const hashBeforeAttempt = computeContentHash(fs.readFileSync(absFilePath, 'utf8'));
    const editRes = editor.edit({
      filePath: spec.filePath,
      searchBlock: step.searchBlock,
      replaceBlock: step.replaceBlock,
      expectedStartLine: step.expectedStartLine,
      language: spec.language,
    });
    contextChars += editRes.snippet.length;

    if (!editRes.applied) {
      // Pre-flight guard caught ambiguity or syntax error BEFORE touching disk!
      preFlightRejections++;
      const hashAfterRejection = computeContentHash(fs.readFileSync(absFilePath, 'utf8'));
      if (hashAfterRejection !== hashBeforeAttempt) {
        corruptedDiskWrites++;
      }
      // Agent immediately sees exact line-numbered diagnostic in `editRes.snippet`
      // without needing an extra compiler run or full-file cat!
      continue;
    }

    // Verify disk state is syntactically clean, then run bounded verification command
    const diskNow = fs.readFileSync(absFilePath, 'utf8');
    if (preflightSyntaxCheck(diskNow, { filePath: spec.filePath, language: spec.language }).length > 0) {
      corruptedDiskWrites++;
    }

    turns++;
    const verifyCompact = compactCommandOutput(spec.passingVerifyCommandLog, {
      exitCode: 0,
      elapsedMs: 310,
    });
    contextChars += verifyCompact.output.length;
    break;
  }

  const wallClockMs = performance.now() - t0;
  const contextTokens = estimateTokens(contextChars);
  const finalDisk = fs.readFileSync(absFilePath, 'utf8');
  const patchCorrect = spec.verifyFinalContent(finalDisk);
  const completedWithinBudget = patchCorrect && contextTokens <= budgetTokens;

  return {
    trajectoryId: spec.id,
    strategy: 'swe_agent_guarded_aci',
    turns,
    contextChars,
    contextTokens,
    editAttempts,
    corruptedDiskWrites,
    preFlightRejections,
    patchCorrect,
    completedWithinBudget,
    wallClockMs,
  };
}

function summarizeStrategy(
  strategy: StrategyName,
  runs: TrajectoryRunOutcome[]
): StrategyAggregateSummary {
  const subset = runs.filter((r) => r.strategy === strategy);
  const n = subset.length || 1;
  const totalContextTokens = subset.reduce((s, r) => s + r.contextTokens, 0);
  const totalEditAttempts = subset.reduce((s, r) => s + r.editAttempts, 0);
  const syntaxCorruptedDiskWrites = subset.reduce((s, r) => s + r.corruptedDiskWrites, 0);
  const totalTurns = subset.reduce((s, r) => s + r.turns, 0);
  const patchOk = subset.filter((r) => r.patchCorrect).length;
  const completed = subset.filter((r) => r.completedWithinBudget).length;
  const latencies = subset.map((r) => r.wallClockMs).sort((a, b) => a - b);
  const totalWallClockMs = latencies.reduce((s, x) => s + x, 0);

  return {
    strategy,
    trajectories: subset.length,
    totalContextTokens,
    meanContextTokens: Number((totalContextTokens / n).toFixed(2)),
    totalEditAttempts,
    syntaxCorruptedDiskWrites,
    syntaxCorruptedEditRatePct:
      totalEditAttempts > 0
        ? Number(((syntaxCorruptedDiskWrites / totalEditAttempts) * 100).toFixed(2))
        : 0,
    meanTurnsToConvergence: Number((totalTurns / n).toFixed(2)),
    patchCorrectnessRatePct: Number(((patchOk / n) * 100).toFixed(2)),
    taskCompletionRatePct: Number(((completed / n) * 100).toFixed(2)),
    meanWallClockMs: Number((totalWallClockMs / n).toFixed(3)),
    p50WallClockMs: percentile(latencies, 50),
    p95WallClockMs: percentile(latencies, 95),
    totalWallClockMs: Number(totalWallClockMs.toFixed(3)),
  };
}

function runSuiteOnDisk(
  trajectories: BenchmarkTrajectorySpec[],
  budgetTokens: number
): TrajectoryRunOutcome[] {
  const outcomes: TrajectoryRunOutcome[] = [];
  const strategies: StrategyName[] = [
    'raw_shell_cat_sed',
    'unwindowed_str_replace',
    'swe_agent_guarded_aci',
  ];

  for (const spec of trajectories) {
    for (const strategy of strategies) {
      const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aci-swe-eval-'));
      const absTarget = path.join(tmpWorkspace, spec.filePath);
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(absTarget, spec.initialContent, 'utf8');
      try {
        if (strategy === 'raw_shell_cat_sed') {
          outcomes.push(executeRawShellCatSed(spec, absTarget, budgetTokens));
        } else if (strategy === 'unwindowed_str_replace') {
          outcomes.push(executeUnwindowedStrReplace(spec, absTarget, budgetTokens));
        } else {
          outcomes.push(executeSweAgentGuardedAci(spec, tmpWorkspace, absTarget, budgetTokens));
        }
      } finally {
        fs.rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    }
  }
  return outcomes;
}

export function runAciSweBenchmark(
  budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS
): AciBenchmarkReport {
  const primarySpecs = createPrimaryTrajectories();
  const primaryRuns = runSuiteOnDisk(primarySpecs, budgetTokens);

  const rawAgg = summarizeStrategy('raw_shell_cat_sed', primaryRuns);
  const unwinAgg = summarizeStrategy('unwindowed_str_replace', primaryRuns);
  const aciAgg = summarizeStrategy('swe_agent_guarded_aci', primaryRuns);

  const controlSpecs = createNegativeControlTrajectories();
  const controlRuns = runSuiteOnDisk(controlSpecs, budgetTokens);
  const controlAggs: Record<StrategyName, StrategyAggregateSummary> = {
    raw_shell_cat_sed: summarizeStrategy('raw_shell_cat_sed', controlRuns),
    unwindowed_str_replace: summarizeStrategy('unwindowed_str_replace', controlRuns),
    swe_agent_guarded_aci: summarizeStrategy('swe_agent_guarded_aci', controlRuns),
  };

  return {
    contextBudgetTokensPerTask: budgetTokens,
    primarySuite: {
      trajectoryCount: primarySpecs.length,
      aggregates: {
        raw_shell_cat_sed: rawAgg,
        unwindowed_str_replace: unwinAgg,
        swe_agent_guarded_aci: aciAgg,
      },
      runs: primaryRuns,
      deltasVsRawShell: {
        tokenReductionPct: Number(
          (((rawAgg.totalContextTokens - aciAgg.totalContextTokens) / rawAgg.totalContextTokens) * 100).toFixed(2)
        ),
        turnReductionPct: Number(
          (((rawAgg.meanTurnsToConvergence - aciAgg.meanTurnsToConvergence) / rawAgg.meanTurnsToConvergence) * 100).toFixed(2)
        ),
        corruptedEditRateReductionPp: Number(
          (rawAgg.syntaxCorruptedEditRatePct - aciAgg.syntaxCorruptedEditRatePct).toFixed(2)
        ),
        completionLiftPp: Number(
          (aciAgg.taskCompletionRatePct - rawAgg.taskCompletionRatePct).toFixed(2)
        ),
      },
      deltasVsUnwindowed: {
        tokenReductionPct: Number(
          (((unwinAgg.totalContextTokens - aciAgg.totalContextTokens) / unwinAgg.totalContextTokens) * 100).toFixed(2)
        ),
        turnReductionPct: Number(
          (((unwinAgg.meanTurnsToConvergence - aciAgg.meanTurnsToConvergence) / unwinAgg.meanTurnsToConvergence) * 100).toFixed(2)
        ),
        corruptedEditRateReductionPp: Number(
          (unwinAgg.syntaxCorruptedEditRatePct - aciAgg.syntaxCorruptedEditRatePct).toFixed(2)
        ),
        completionLiftPp: Number(
          (aciAgg.taskCompletionRatePct - unwinAgg.taskCompletionRatePct).toFixed(2)
        ),
      },
    },
    negativeControl: {
      trajectoryCount: controlSpecs.length,
      aggregates: controlAggs,
    },
  };
}

function formatMarkdownReport(report: AciBenchmarkReport): string {
  const lines: string[] = [];
  lines.push('=== SWE-agent ACI Evaluation Benchmark (HIP-1347 / #48 / #44) ===');
  lines.push(`Per-Trajectory Context Budget: ${report.contextBudgetTokensPerTask} tokens`);
  lines.push('');
  lines.push(
    '| Interface Strategy | Total Tokens (8 Tasks) | Mean Tokens / Task | Corrupted Disk Edits | Syntax-Corrupted Edit Rate | Mean Turns | Completion Rate (<=16k tok) | Mean / p50 / p95 Latency (ms) |'
  );
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const key of [
    'raw_shell_cat_sed',
    'unwindowed_str_replace',
    'swe_agent_guarded_aci',
  ] as StrategyName[]) {
    const s = report.primarySuite.aggregates[key];
    lines.push(
      `| \`${s.strategy}\` | ${s.totalContextTokens} | ${s.meanContextTokens.toFixed(2)} | ${s.syntaxCorruptedDiskWrites}/${s.totalEditAttempts} | ${s.syntaxCorruptedEditRatePct.toFixed(2)}% | ${s.meanTurnsToConvergence.toFixed(2)} | ${s.taskCompletionRatePct.toFixed(2)}% | ${s.meanWallClockMs.toFixed(2)} / ${s.p50WallClockMs.toFixed(2)} / ${s.p95WallClockMs.toFixed(2)} |`
    );
  }

  lines.push('');
  lines.push('=== Per-Trajectory Breakdown ===');
  lines.push(
    '| Trajectory ID | Strategy | Turns | Context Tokens | Corrupted Disk Writes | Completed (<=16k) | Latency (ms) |'
  );
  lines.push('| :--- | :--- | ---: | ---: | ---: | :---: | ---: |');
  for (const r of report.primarySuite.runs) {
    lines.push(
      `| \`${r.trajectoryId}\` | \`${r.strategy}\` | ${r.turns} | ${r.contextTokens} | ${r.corruptedDiskWrites}/${r.editAttempts} | ${r.completedWithinBudget ? 'yes' : 'no'} | ${r.wallClockMs.toFixed(2)} |`
    );
  }

  lines.push('');
  lines.push('=== Negative / Boundary Control (4 Small 24-Line Files) ===');
  for (const key of [
    'raw_shell_cat_sed',
    'unwindowed_str_replace',
    'swe_agent_guarded_aci',
  ] as StrategyName[]) {
    const c = report.negativeControl.aggregates[key];
    lines.push(
      `- ${c.strategy}: meanTokens=${c.meanContextTokens.toFixed(2)}, corruptedRate=${c.syntaxCorruptedEditRatePct.toFixed(2)}%, meanTurns=${c.meanTurnsToConvergence.toFixed(2)}, completion=${c.taskCompletionRatePct.toFixed(2)}%`
    );
  }

  lines.push('');
  lines.push('=== Key Deltas (swe_agent_guarded_aci vs Baselines) ===');
  lines.push(
    `- vs raw_shell_cat_sed: -${report.primarySuite.deltasVsRawShell.tokenReductionPct}% context tokens, -${report.primarySuite.deltasVsRawShell.turnReductionPct}% turns, -${report.primarySuite.deltasVsRawShell.corruptedEditRateReductionPp} pp disk-corruption rate, +${report.primarySuite.deltasVsRawShell.completionLiftPp} pp task completion`
  );
  lines.push(
    `- vs unwindowed_str_replace: -${report.primarySuite.deltasVsUnwindowed.tokenReductionPct}% context tokens, -${report.primarySuite.deltasVsUnwindowed.turnReductionPct}% turns, -${report.primarySuite.deltasVsUnwindowed.corruptedEditRateReductionPp} pp disk-corruption rate, +${report.primarySuite.deltasVsUnwindowed.completionLiftPp} pp task completion`
  );
  return lines.join('\n');
}

const isMainEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv.some((arg) => arg.includes('aci-swe-eval'));

if (isMainEntry) {
  const report = runAciSweBenchmark();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMarkdownReport(report));
    console.log('\n--- RAW_JSON_METRICS_START ---');
    console.log(JSON.stringify(report));
    console.log('--- RAW_JSON_METRICS_END ---');
  }
}
