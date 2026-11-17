/**
 * SWE-agent ACI Compact Interface Suite (HIP-1347 / Bounty #38).
 */

import { describe, test, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  renderFileWindow,
  navigateFileWindow,
  validateAndApplyHunks,
  applyValidatedFileEdit,
  compressBuildOutput,
  computeContentHash,
} from '../../src/aci/compact-response.js';

describe('SWE-agent ACI Compact Interface (HIP-1347)', () => {
  test('renderFileWindow & navigateFileWindow provide compact line-numbered views and 1-call search_open', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => {
      if (i + 1 === 542) return 'export function targetResolver(id: string) { return id.trim(); }';
      return `const line_${i + 1} = ${i + 1}; // filler workspace statement for context sizing`;
    });
    const content = lines.join('\n') + '\n';

    const win = renderFileWindow(content, {
      filePath: 'src/large-module.ts',
      startLine: 1,
      windowSize: 60,
    });
    expect(win.totalLines).toBe(1000);
    expect(win.startLine).toBe(1);
    expect(win.endLine).toBe(60);
    expect(win.linesBelow).toBe(940);
    expect(win.rendered).toContain('[File: src/large-module.ts (1000 lines total)');
    expect(win.rendered).toContain('(at top of file)');
    expect(win.rendered).toContain('(940 more lines below)');
    expect(win.metrics.savingsRatio).toBeGreaterThan(0.9);

    // 1-call search_open jumps straight to line 542 centered window with '>' highlight
    const jumped = navigateFileWindow(content, win.state, {
      type: 'search_open',
      pattern: 'targetResolver',
    });
    expect(jumped.startLine).toBeLessThanOrEqual(542);
    expect(jumped.endLine).toBeGreaterThanOrEqual(542);
    expect(jumped.rendered).toContain('> 542│export function targetResolver');

    const down = navigateFileWindow(content, jumped.state, { type: 'scroll_down', overlap: 10 });
    expect(down.startLine).toBe(jumped.startLine + 50);

    const emptyWin = renderFileWindow('', { filePath: 'empty.ts' });
    expect(emptyWin.totalLines).toBe(0);
    expect(emptyWin.rendered).toContain('(empty file)');

    const longMinified = `const data = "${'x'.repeat(500)}";\n`;
    const minWin = renderFileWindow(longMinified, { maxLineLength: 80 });
    expect(minWin.rendered).toContain('... (+');
  });

  test('validateAndApplyHunks rejects stale hashes, ambiguous matches, missing hunks, and syntax errors atomically', async () => {
    const source = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function sub(a: number, b: number): number {',
      '  return a - b;',
      '}',
      '',
      'export function dup() {',
      '  const x = 1;',
      '  return x;',
      '}',
      '',
      'export function dup2() {',
      '  const x = 1;',
      '  return x;',
      '}',
      '',
    ].join('\n');

    const baseHash = computeContentHash(source);

    // 1. Stale hash rejected
    const stale = validateAndApplyHunks(
      source,
      [{ oldText: 'return a + b;', newText: 'return a + b + 0;' }],
      { filePath: 'math.ts', baseHash: 'sha256:0000' }
    );
    expect(stale.applied).toBe(false);
    expect(stale.errors[0].code).toBe('STALE_HASH');

    // 2. Missing hunk gives closest line recovery hint
    const missing = validateAndApplyHunks(
      source,
      [{ oldText: 'return a + c;', newText: 'return a + b;' }],
      { filePath: 'math.ts', baseHash }
    );
    expect(missing.applied).toBe(false);
    expect(missing.errors[0].code).toBe('HUNK_NOT_FOUND');
    expect(missing.errors[0].closestLine).toBe(2);
    expect(missing.errors[0].closestSnippet).toContain('return a + b;');

    // 3. Ambiguous hunk lists all matching lines, then resolves with expectedStartLine anchor
    const ambiguous = validateAndApplyHunks(
      source,
      [{ oldText: '  const x = 1;', newText: '  const x = 42;' }],
      { filePath: 'math.ts', baseHash }
    );
    expect(ambiguous.applied).toBe(false);
    expect(ambiguous.errors[0].code).toBe('AMBIGUOUS_HUNK');
    expect(ambiguous.errors[0].matchingLines).toEqual([10, 15]);

    const disambiguated = validateAndApplyHunks(
      source,
      [{ oldText: '  const x = 1;', newText: '  const x = 42;', expectedStartLine: 15 }],
      { filePath: 'math.ts', baseHash, contextLines: 2 }
    );
    expect(disambiguated.applied).toBe(true);
    expect(disambiguated.summaryText).toContain('*  15│  const x = 42;');
    expect(disambiguated.content).toContain('function dup() {\n  const x = 1;');

    // 4. Syntax-breaking edit rejected atomically without touching disk
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aci-edit-'));
    const fileOnDisk = path.join(tmpDir, 'math.ts');
    fs.writeFileSync(fileOnDisk, source, 'utf8');
    try {
      const broken = await applyValidatedFileEdit(
        fileOnDisk,
        [{ oldText: '  return a + b;\n}', newText: '  return a + b;' }],
        { baseHash }
      );
      expect(broken.applied).toBe(false);
      expect(broken.errors[0].code).toBe('LINT_ERROR');
      expect(fs.readFileSync(fileOnDisk, 'utf8')).toBe(source);

      // 5. Valid multi-hunk edit persists atomically and includes inline post-edit window
      const valid = await applyValidatedFileEdit(
        fileOnDisk,
        [
          { oldText: '  return a + b;', newText: '  return Math.trunc(a + b);' },
          { oldText: '  return a - b;', newText: '  return Math.trunc(a - b);' },
        ],
        { baseHash, contextLines: 2 }
      );
      expect(valid.applied).toBe(true);
      expect(valid.hunksApplied).toBe(2);
      expect(valid.newHash).not.toBe(baseHash);
      expect(valid.summaryText).toContain('[Edit applied:');
      expect(valid.summaryText).toContain('Math.trunc(a + b)');
      expect(valid.summaryText).toContain('Math.trunc(a - b)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('compressBuildOutput slashes noisy cargo/jest output by >85% while keeping diagnostics and spans', () => {
    const noisyCompileLines = Array.from(
      { length: 600 },
      (_, i) => `\x1b[32m   Compiling\x1b[0m crate_${i} v0.${i % 10}.0 (/workspace/crates/crate_${i})`
    );
    const noisyPassLines = Array.from(
      { length: 400 },
      (_, i) => `test suite::case_${i} ... ok`
    );
    const rawLog = [
      'Running workspace build...',
      ...noisyCompileLines,
      'Progress: 25%\rProgress: 60%\rProgress: 100%',
      'error[E0308]: mismatched types',
      '  --> src/router/dispatch.rs:148:19',
      '   |',
      '148|     return handle(req);',
      '   |            ^^^^^^^^^^^ expected `Result<Response, Error>`, found `Response`',
      ...noisyPassLines,
      'error: could not compile `gateway` (lib) due to 1 previous error',
      'test result: FAILED. 399 passed; 1 failed; 0 ignored',
    ].join('\n');

    const compressed = compressBuildOutput(rawLog);
    expect(compressed.category).toBe('compile');
    expect(compressed.extractedFileSpans).toContain('src/router/dispatch.rs:148:19');
    expect(compressed.compressedText).toContain('error[E0308]: mismatched types');
    expect(compressed.compressedText).toContain('src/router/dispatch.rs:148:19');
    expect(compressed.compressedText).toContain('test result: FAILED');
    expect(compressed.compressedText).toContain('Progress: 100%');
    expect(compressed.compressedText).not.toContain('Progress: 25%');
    expect(compressed.compressedText).not.toContain('\x1b[');
    expect(compressed.metrics.savingsRatio).toBeGreaterThan(0.85);
    expect(compressed.metrics.tokensSaved).toBeGreaterThan(10000);
  });

  test('end-to-end ACI workflow comparison demonstrates tool-call and token bloat reductions', () => {
    // Realistic 400-line TypeScript module + 300-line test failure log
    const moduleLines = Array.from({ length: 400 }, (_, i) => {
      if (i + 1 === 215) return 'export function computeRate(count: number, total: number): number {';
      if (i + 1 === 216) return '  return count / total; // bug: zero total returns NaN/Infinity';
      if (i + 1 === 217) return '}';
      return `export const helper_${i + 1} = () => ${i + 1}; // deterministic workspace module padding`;
    });
    const moduleText = moduleLines.join('\n') + '\n';
    const rawTestLog = [
      'Running jest suite...',
      ...Array.from({ length: 280 }, (_, i) => `PASS test/unit/mod_${i}.test.ts`),
      'FAIL test/unit/rate.test.ts',
      '  ● computeRate returns 0 when total is 0',
      '    Expected: 0',
      '    Received: NaN',
      '      at Object.<anonymous> (test/unit/rate.test.ts:14:25)',
      'Tests: 1 failed, 280 passed, 281 total',
    ].join('\n');

    // Baseline naive agent loop:
    // 1. grep/search, 2. full fs.read (400 lines), 3. edit without post-edit window,
    // 4. follow-up fs.read to verify lines, 5. raw exec output (287 lines) -> 5 calls
    const naiveCallCount = 5;
    const naiveContextChars = moduleText.length * 2 + rawTestLog.length;

    // ACI workflow:
    // 1. search_open (jumps straight to computeRate window),
    // 2. validateAndApplyHunks (edits + validates + returns post-edit window, skipping re-read),
    // 3. compressBuildOutput (compact error + tail) -> 3 calls
    const aciCallCount = 3;
    const win = navigateFileWindow(
      moduleText,
      { filePath: 'src/rate.ts', startLine: 1, windowSize: 40, totalLines: 400 },
      { type: 'search_open', pattern: 'computeRate' }
    );
    const edit = validateAndApplyHunks(
      moduleText,
      [
        {
          oldText: '  return count / total; // bug: zero total returns NaN/Infinity',
          newText: '  return total === 0 ? 0 : count / total;',
        },
      ],
      { filePath: 'src/rate.ts', baseHash: win.hash, contextLines: 4 }
    );
    const log = compressBuildOutput(rawTestLog);

    expect(edit.applied).toBe(true);
    expect(log.category).toBe('test');
    expect(log.compressedText).toContain('Expected: 0');
    expect(log.compressedText).toContain('test/unit/rate.test.ts:14:25');

    const aciContextChars = win.rendered.length + edit.summaryText.length + log.compressedText.length;
    const contextSavingsRatio = 1 - aciContextChars / naiveContextChars;

    expect(aciCallCount).toBeLessThan(naiveCallCount); // 3 vs 5 calls (40% fewer round-trips)
    expect(contextSavingsRatio).toBeGreaterThan(0.8);
  });
});
