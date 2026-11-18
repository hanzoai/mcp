/**
 * Comprehensive SWE-agent ACI Optimization Test Suite (HIP-1347 / #48 / #44).
 *
 * Covers:
 *   1. Stateful WindowedFileViewer (100-line viewport, open, scroll_down, scroll_up, goto_line)
 *   2. Bounded search_file returning match line indices rather than flooding context
 *   3. GuardedFileEditor uniqueness check, baseHash optimistic concurrency, and localized +/- snippet
 *   4. Pre-flight TypeScript/JS/JSON/Rust/Python/Go syntax gate rejecting broken edits BEFORE disk write
 *   5. compactCommandOutput head/tail preservation, stack-frame deduplication, ANSI stripping, and footer
 *   6. Multi-tenant VFS isolation, RBAC, path-traversal / symlink sandbox security, and session isolation
 *   7. Concurrent async file-edit mutex serialization and MCP tool bindings (`createAciTools`)
 */

import { describe, test, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AciAccessError,
  AciSessionRegistry,
  GuardedFileEditor,
  InMemoryVfsWorkspaceBackend,
  NodeFsWorkspaceBackend,
  WindowedFileViewer,
  compactCommandOutput,
  computeContentHash,
  createAciTools,
  preflightSyntaxCheck,
  renderFileWindow,
  validateAndApplyHunks,
  compressBuildOutput,
} from '../src/aci/index.js';

describe('SWE-agent ACI Optimization Suite (HIP-1347 / #48 / #44)', () => {
  test('WindowedFileViewer maintains stateful 100-line viewport across open, scroll_down, scroll_up, and goto_line', () => {
    const lines = Array.from({ length: 550 }, (_, idx) => {
      const n = idx + 1;
      if (n === 348) {
        return 'export function settleEscrowInvoice(invoiceId: string, amountCents: number): boolean {';
      }
      return `export const metricEntry_${n} = { id: ${n}, label: "bucket_${n}" };`;
    });
    const content = lines.join('\n') + '\n';

    const viewer = new WindowedFileViewer({
      files: { 'src/billing/escrow.ts': content },
    });
    expect(viewer.getState()).toBeNull();

    // Default open starts at line 1 with 100-line viewport
    const opened = viewer.open('src/billing/escrow.ts');
    expect(opened.startLine).toBe(1);
    expect(opened.endLine).toBe(100);
    expect(opened.totalLines).toBe(550);
    expect(opened.linesAbove).toBe(0);
    expect(opened.linesBelow).toBe(450);
    expect(opened.rendered).toContain('Window: lines 1-100');
    expect(opened.metrics.savingsRatio).toBeGreaterThan(0.75);

    // scroll_down advances by 100 lines (101-200)
    const page2 = viewer.scroll_down();
    expect(page2.startLine).toBe(101);
    expect(page2.endLine).toBe(200);
    expect(page2.linesAbove).toBe(100);
    expect(page2.linesBelow).toBe(350);

    // scroll_up moves back cleanly and clamps at top of file
    const backToTop = viewer.scroll_up(250);
    expect(backToTop.startLine).toBe(1);
    expect(backToTop.endLine).toBe(100);

    // goto_line centers 100-line viewport around line 348 and highlights target line
    const centered = viewer.goto_line(348);
    expect(centered.startLine).toBe(298);
    expect(centered.endLine).toBe(397);
    expect(centered.rendered).toContain('> 348|export function settleEscrowInvoice');

    // Scrolling past bottom clamps cleanly to final 100-line window (451-550)
    const bottom = viewer.scroll_down(1000);
    expect(bottom.startLine).toBe(451);
    expect(bottom.endLine).toBe(550);
    expect(bottom.linesBelow).toBe(0);
    expect(viewer.getState()?.navigationCount).toBe(5);
  });

  test('WindowedFileViewer.search_file returns match line indices without flooding context', () => {
    const lines = Array.from({ length: 1200 }, (_, idx) => {
      const ln = idx + 1;
      if (ln % 15 === 0) {
        return `  const quotaOk_${ln} = verifyTenantQuota(ctx, ${ln}); // repeated call site`;
      }
      return `  const paddingStatement_${ln} = "${'a'.repeat(70)}_${ln}";`;
    });
    const content = lines.join('\n') + '\n';
    const viewer = new WindowedFileViewer({
      files: { 'src/policy/quota.ts': content },
    });
    viewer.open('src/policy/quota.ts');

    const res = viewer.search_file('verifyTenantQuota', {
      maxMatchesShown: 10,
      autoJump: true,
      occurrence: 3,
    });

    // 1200 / 15 = 80 matches
    expect(res.totalMatches).toBe(80);
    expect(res.matchLines.length).toBe(80);
    expect(res.matchLines[0]).toBe(15);
    expect(res.matchLines[2]).toBe(45);
    expect(res.matches.length).toBe(10);
    expect(res.truncated).toBe(true);
    expect(res.rendered).toContain('80 match(es) on 80 line(s)');
    expect(res.rendered).toContain('L15:');
    expect(res.rendered).not.toContain('paddingStatement_1');
    expect(res.metrics.savingsRatio).toBeGreaterThan(0.95);

    // autoJump moved cursor to center around 3rd match (line 45)
    expect(res.window).toBeDefined();
    expect(res.window!.rendered).toContain('>  45|');

    const miss = viewer.search_file('nonExistentIdentifierXYZ');
    expect(miss.totalMatches).toBe(0);
    expect(miss.matchLines).toEqual([]);
    expect(miss.rendered).toContain('0 matches');
  });

  test('GuardedFileEditor enforces uniqueness, rejects syntax corruption BEFORE disk write, and syncs viewer', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aci-guarded-editor-'));
    const targetPath = path.join(tmpDir, 'service.ts');
    const initialSource = [
      'export interface OrderItem {',
      '  sku: string;',
      '  unitPriceCents: number;',
      '  quantity: number;',
      '}',
      '',
      'export function formatOrderTag(prefix: string): string {',
      '  const cleaned = prefix.trim();',
      '  return cleaned.toUpperCase();',
      '}',
      '',
      'export function formatCustomerTag(prefix: string): string {',
      '  const cleaned = prefix.trim();',
      '  return cleaned.toLowerCase();',
      '}',
      '',
      'export function computeSubtotalCents(items: OrderItem[]): number {',
      '  let total = 0;',
      '  for (const item of items) {',
      '    total += item.unitPriceCents;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(targetPath, initialSource, 'utf8');
    const initialHash = computeContentHash(initialSource);

    try {
      const viewer = new WindowedFileViewer({ workspaceRoot: tmpDir, windowSize: 12 });
      const editor = new GuardedFileEditor({ workspaceRoot: tmpDir, viewer, contextLines: 3 });

      viewer.open('service.ts', 1);

      // 1. Ambiguous searchBlock (occurs at lines 8 and 13) -> REJECTED without touching disk
      const dupEdit = editor.edit({
        filePath: 'service.ts',
        searchBlock: '  const cleaned = prefix.trim();',
        replaceBlock: '  const cleaned = prefix.trim().slice(0, 32);',
      });
      expect(dupEdit.applied).toBe(false);
      expect(dupEdit.errorCode).toBe('NON_UNIQUE_SEARCH_BLOCK');
      expect(dupEdit.matchingLines).toEqual([8, 13]);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(initialSource);

      // 2. Missing searchBlock -> REJECTED with closest line diagnostic hint
      const notFound = editor.edit({
        filePath: 'service.ts',
        searchBlock: '    total += item.unitCostCents;',
        replaceBlock: '    total += item.unitPriceCents * item.quantity;',
      });
      expect(notFound.applied).toBe(false);
      expect(notFound.errorCode).toBe('SEARCH_BLOCK_NOT_FOUND');
      expect(notFound.closestLine).toBe(20);
      expect(notFound.snippet).toContain('20|    total += item.unitPriceCents;');
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(initialSource);

      // 3. Broken delimiter edit (drops closing brace of for-loop) -> REJECTED BEFORE disk write
      const brokenBrace = editor.edit({
        filePath: 'service.ts',
        searchBlock: '  for (const item of items) {\n    total += item.unitPriceCents;\n  }',
        replaceBlock: '  for (const item of items) {\n    total += item.unitPriceCents * item.quantity;',
      });
      expect(brokenBrace.applied).toBe(false);
      expect(brokenBrace.errorCode).toBe('SYNTAX_LINT_REJECTED');
      expect(brokenBrace.syntaxDiagnostics.length).toBeGreaterThan(0);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(initialSource);
      expect(computeContentHash(fs.readFileSync(targetPath, 'utf8'))).toBe(initialHash);

      // 4. Broken TypeScript token sequence (`total += ;`) -> REJECTED BEFORE disk write
      const brokenExpr = editor.edit({
        filePath: 'service.ts',
        searchBlock: '    total += item.unitPriceCents;',
        replaceBlock: '    total += ;',
      });
      expect(brokenExpr.applied).toBe(false);
      expect(brokenExpr.errorCode).toBe('SYNTAX_LINT_REJECTED');
      expect(brokenExpr.syntaxDiagnostics[0].code).toBe('INVALID_TOKEN_SEQUENCE');
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(initialSource);

      // 5. Lazy stub comment (`// ... existing code ...`) -> REJECTED BEFORE disk write
      const lazyStub = editor.edit({
        filePath: 'service.ts',
        searchBlock: '    total += item.unitPriceCents;',
        replaceBlock: '    // ... existing code ...',
      });
      expect(lazyStub.applied).toBe(false);
      expect(lazyStub.errorCode).toBe('SYNTAX_LINT_REJECTED');
      expect(lazyStub.syntaxDiagnostics[0].code).toBe('TRUNCATED_PLACEHOLDER');
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(initialSource);

      // 6. Valid fix applies atomically, returns localized +/- context snippet, and syncs viewer
      const validFix = editor.edit({
        filePath: 'service.ts',
        baseHash: initialHash,
        searchBlock: '    total += item.unitPriceCents;',
        replaceBlock: '    total += item.unitPriceCents * Math.max(0, item.quantity);',
      });
      expect(validFix.applied).toBe(true);
      expect(validFix.errorCode).toBeNull();
      expect(validFix.newHash).not.toBe(initialHash);
      expect(validFix.editedRange).toEqual({ startLine: 20, endLine: 20 });
      expect(validFix.snippet).toContain('[Edit APPLIED: service.ts');
      expect(validFix.snippet).toContain('+  20|    total += item.unitPriceCents * Math.max(0, item.quantity);');
      expect(fs.readFileSync(targetPath, 'utf8')).toContain('Math.max(0, item.quantity)');

      // Paired viewer cursor automatically synced around line 20
      const syncedState = viewer.getState();
      expect(syncedState).not.toBeNull();
      expect(syncedState!.hash).toBe(validFix.newHash);
      expect(syncedState!.startLine).toBeLessThanOrEqual(20);
      expect(syncedState!.endLine).toBeGreaterThanOrEqual(20);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('preflightSyntaxCheck handles complex valid TS/JSON/Rust/Python/Go constructs and catches syntax errors accurately', () => {
    // Valid complex TypeScript: regex with parens, nested template literals, generics, optional catch
    const validTs = [
      'export function transform<T extends Record<string, unknown>>(items: T[]): string {',
      '  const rx = /^item\\([a-z0-9_[\\]]+\\)$/gi;',
      '  try {',
      '    return items.map((it, idx) => `${idx}:${rx.test(String(it.id)) ? `${it.id}` : "skip"}`).join(",");',
      '  } catch {',
      '    return "";',
      '  }',
      '}',
    ].join('\n');
    expect(preflightSyntaxCheck(validTs, { filePath: 'complex.ts' })).toEqual([]);

    // Broken nested template expression (`${ ... )`)
    const brokenTemplate = 'export const s = `value=${compute({ a: 1 )}`;\n';
    const tplDiags = preflightSyntaxCheck(brokenTemplate, { filePath: 'broken.ts' });
    expect(tplDiags.length).toBeGreaterThan(0);
    expect(tplDiags[0].code).toBe('MISMATCHED_DELIMITER');

    // Invalid JSON reports exact line/column
    const badJson = '{\n  "name": "@hanzo/mcp",\n  "count": 12,\n}\n';
    const jsonDiags = preflightSyntaxCheck(badJson, { filePath: 'config.json' });
    expect(jsonDiags.length).toBe(1);
    expect(jsonDiags[0].code).toBe('JSON_SYNTAX_ERROR');
    expect(jsonDiags[0].line).toBeGreaterThanOrEqual(3);

    // Valid Rust with tick labels ('a) and raw strings (r#"..."#)
    const validRust = [
      "pub fn slice_header<'a>(input: &'a str) -> &'a str {",
      '    let pattern = r#"unbalanced ( [ { inside raw string"#;',
      '    if input.is_empty() { pattern } else { input }',
      '}',
    ].join('\n');
    expect(preflightSyntaxCheck(validRust, { filePath: 'lib.rs' })).toEqual([]);

    // Valid Python with triple-quoted docstring containing braces
    const validPy = [
      'def parse_payload(raw: str) -> dict:',
      '    """Parse payload with example {unclosed_in_docstring: [1, 2}."""',
      '    return {"raw": raw.strip()}',
    ].join('\n');
    expect(preflightSyntaxCheck(validPy, { filePath: 'parser.py' })).toEqual([]);
  });

  test('compactCommandOutput strips ANSI, collapses recursive/cyclic/internal stack frames, preserves head/tail, and emits structured footer', () => {
    const recursiveFrames = Array.from(
      { length: 75 },
      () => '    at evaluateNode (src/compiler/checker.ts:219:15)'
    );
    const mutualFrames = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? '    at visitExpression (src/compiler/visitor.ts:88:11)'
        : '    at visitStatement (src/compiler/visitor.ts:142:9)'
    );
    const internalFrames = Array.from(
      { length: 12 },
      (_, i) => `    at Module._compile (node:internal/modules/cjs/loader:${1100 + i}:14)`
    );
    const noisyMiddle = Array.from(
      { length: 300 },
      (_, i) => `\x1b[90m[trace]checked module_${i}.ts in 1ms\x1b[0m`
    );

    const rawStdout = [
      '\x1b[1m\x1b[36m$ pnpm test\x1b[0m',
      'Downloading fixtures 10%\rDownloading fixtures 55%\rDownloading fixtures 100%',
      ...noisyMiddle,
      '\x1b[31mFAIL\x1b[0m test/checker.test.ts',
      'RangeError: Maximum call stack size exceeded',
      ...recursiveFrames,
      ...mutualFrames,
      ...internalFrames,
      'Tests: 1 failed, 48 passed, 49 total',
      'Time:  1.842 s',
    ].join('\n');

    const compacted = compactCommandOutput(rawStdout, {
      exitCode: 1,
      elapsedMs: 1842,
      headLines: 6,
      tailLines: 12,
      maxLines: 35,
      maxBytes: 3200,
    });

    expect(compacted.exitCode).toBe(1);
    expect(compacted.elapsedMs).toBe(1842);
    expect(compacted.ansiSequencesStripped).toBeGreaterThan(300);
    expect(compacted.collapsedStackFrames).toBe(74 + 18);
    expect(compacted.collapsedInternalFrames).toBe(11);
    expect(compacted.truncatedBytes).toBeGreaterThan(10000);
    expect(compacted.output).not.toContain('\x1b[');
    expect(compacted.output).toContain('Downloading fixtures 100%');
    expect(compacted.output).not.toContain('Downloading fixtures 10%');
    expect(compacted.output).toContain('RangeError: Maximum call stack size exceeded');
    expect(compacted.output).toContain('src/compiler/checker.ts:219:15');
    expect(compacted.output).toContain('[74 duplicate stack frame(s) collapsed]');
    expect(compacted.output).toContain('[18 cyclic stack frame(s) collapsed]');
    expect(compacted.output).toContain('[11 internal runtime frame(s) collapsed]');
    expect(compacted.output).toContain('Tests: 1 failed, 48 passed, 49 total');
    expect(compacted.footer).toMatch(
      /^\[exit_code=1 \| elapsed_ms=1842 \| truncated_bytes=\d+\]$/
    );
    expect(compacted.output.endsWith(compacted.footer)).toBe(true);
    expect(Buffer.byteLength(compacted.body, 'utf8')).toBeLessThanOrEqual(3200);
  });

  test('enforces multi-tenant isolation, RBAC roles, path-traversal blocking, and symlink containment', () => {
    // 1. VFS multi-tenant & role isolation
    const vfs = new InMemoryVfsWorkspaceBackend({
      'tenant-a/billing.ts': {
        content: 'export const secretMultiplier = 17;\n',
        tenantId: 'org-alpha',
        allowedRoles: ['developer', 'admin'],
      },
      'tenant-b/payroll.ts': {
        content: 'export const payrollCap = 90000;\n',
        tenantId: 'org-beta',
        allowedRoles: ['admin'],
      },
    });

    const alphaViewer = new WindowedFileViewer({
      backend: vfs,
      security: { tenantId: 'org-alpha', roles: ['developer'], requireTenantMatch: true },
    });
    expect(alphaViewer.open('tenant-a/billing.ts').rendered).toContain('secretMultiplier');
    expect(vfs.listFiles({ tenantId: 'org-alpha', roles: ['developer'] })).toEqual([
      'tenant-a/billing.ts',
    ]);

    // Cross-tenant read & edit fail closed
    expect(() => alphaViewer.open('tenant-b/payroll.ts')).toThrow(AciAccessError);
    const alphaEditor = new GuardedFileEditor({
      backend: vfs,
      security: { tenantId: 'org-alpha', roles: ['developer'] },
    });
    const crossEdit = alphaEditor.edit({
      filePath: 'tenant-b/payroll.ts',
      searchBlock: '90000',
      replaceBlock: '1',
    });
    expect(crossEdit.applied).toBe(false);
    expect(crossEdit.errorCode).toBe('ACCESS_DENIED');

    // Role denial within same tenant
    const lowPrivViewer = new WindowedFileViewer({
      backend: vfs,
      security: { tenantId: 'org-beta', roles: ['viewer-only'] },
    });
    expect(() => lowPrivViewer.open('tenant-b/payroll.ts')).toThrow(AciAccessError);

    // 2. Filesystem path traversal & denied prefix blocking
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aci-sandbox-'));
    const outsideFile = path.join(os.tmpdir(), `aci-outside-${Date.now()}.txt`);
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'SECRET_KEY=topsecret\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'safe.ts'), 'export const ok = true;\n', 'utf8');
    fs.writeFileSync(outsideFile, 'outside secret\n', 'utf8');

    try {
      const fsBackend = new NodeFsWorkspaceBackend({
        workspaceRoot: tmpRoot,
        deniedPathPrefixes: ['.env', '.git/'],
      });
      const sandboxViewer = new WindowedFileViewer({ backend: fsBackend });

      expect(sandboxViewer.open('safe.ts').rendered).toContain('export const ok = true;');
      expect(() => sandboxViewer.open('../' + path.basename(outsideFile))).toThrow(AciAccessError);
      expect(() => sandboxViewer.open(outsideFile)).toThrow(AciAccessError);
      expect(() => sandboxViewer.open('.env')).toThrow(AciAccessError);
      expect(() => sandboxViewer.open('safe.ts\0.txt')).toThrow(AciAccessError);

      // Symlink pointing outside workspaceRoot must be blocked
      const symlinkPath = path.join(tmpRoot, 'escape-link.txt');
      fs.symlinkSync(outsideFile, symlinkPath);
      expect(() => sandboxViewer.open('escape-link.txt')).toThrow(AciAccessError);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  });

  test('concurrent editAsync calls serialize safely and MCP tool bindings work end-to-end', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aci-concurrent-'));
    const filePath = path.join(tmpDir, 'counters.ts');
    const lines = Array.from({ length: 20 }, (_, i) => `export const slot_${i + 1} = 0;`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    try {
      const editor = new GuardedFileEditor({ workspaceRoot: tmpDir });

      // Fire 10 concurrent async edits on distinct lines of the same file
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
          editor.editAsync({
            filePath: 'counters.ts',
            searchBlock: `export const slot_${idx + 1} = 0;`,
            replaceBlock: `export const slot_${idx + 1} = ${(idx + 1) * 10};`,
          })
        )
      );

      expect(results.every((r) => r.applied)).toBe(true);
      const updated = fs.readFileSync(filePath, 'utf8');
      for (let idx = 0; idx < 10; idx++) {
        expect(updated).toContain(`export const slot_${idx + 1} = ${(idx + 1) * 10};`);
      }

      // Verify MCP tool bindings and AciSessionRegistry LRU isolation
      const registry = new AciSessionRegistry({ workspaceRoot: tmpDir, maxSessions: 4 });
      const s1 = registry.getSession('agent-1', { tenantId: 't1' });
      const s2 = registry.getSession('agent-2', { tenantId: 't2' });
      expect(s1.key).not.toBe(s2.key);
      s1.viewer.open('counters.ts', 1, 5);
      expect(s2.viewer.getState()).toBeNull();

      const tools = createAciTools({ workspaceRoot: tmpDir, windowSize: 10 });
      const byName = new Map(tools.map((t) => [t.name, t]));

      const viewRes = await byName.get('aci_viewer')!.handler({
        action: 'open',
        path: 'counters.ts',
        session_id: 'mcp-s1',
      });
      expect(viewRes.isError).toBeUndefined();
      expect(viewRes.content[0].text).toContain('export const slot_1 = 10;');

      const editRes = await byName.get('aci_edit')!.handler({
        path: 'counters.ts',
        search_block: 'export const slot_11 = 0;',
        replace_block: 'export const slot_11 = 110;',
        session_id: 'mcp-s1',
      });
      expect(editRes.isError).toBeUndefined();
      expect(editRes.content[0].text).toContain('+  11|export const slot_11 = 110;');

      const compactRes = await byName.get('aci_compact_output')!.handler({
        raw_output: '\x1b[32mPASS\x1b[0m test/counters.test.ts\nAll assertions green',
        exit_code: 0,
        elapsed_ms: 95,
      });
      expect(compactRes.content[0].text).toContain('[exit_code=0 | elapsed_ms=95 | truncated_bytes=');

      // Verify existing compact-response primitives remain 100% backward compatible
      expect(typeof renderFileWindow).toBe('function');
      expect(typeof validateAndApplyHunks).toBe('function');
      expect(typeof compressBuildOutput).toBe('function');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('reproducible A/B SWE-agent benchmark confirms token savings, zero disk corruption, and negative control parity', async () => {
    const { runAciSweBenchmark } = await import('../bench/aci-swe-eval.js');
    const report = runAciSweBenchmark();

    const raw = report.primarySuite.aggregates.raw_shell_cat_sed;
    const unwin = report.primarySuite.aggregates.unwindowed_str_replace;
    const aci = report.primarySuite.aggregates.swe_agent_guarded_aci;

    expect(aci.syntaxCorruptedDiskWrites).toBe(0);
    expect(aci.syntaxCorruptedEditRatePct).toBe(0);
    expect(raw.syntaxCorruptedDiskWrites).toBeGreaterThan(0);
    expect(unwin.syntaxCorruptedDiskWrites).toBeGreaterThan(0);

    expect(report.primarySuite.deltasVsRawShell.tokenReductionPct).toBeGreaterThan(90);
    expect(report.primarySuite.deltasVsUnwindowed.tokenReductionPct).toBeGreaterThan(85);
    expect(aci.meanTurnsToConvergence).toBeLessThan(unwin.meanTurnsToConvergence);
    expect(unwin.meanTurnsToConvergence).toBeLessThan(raw.meanTurnsToConvergence);
    expect(aci.taskCompletionRatePct).toBe(100);

    // Negative control: small 24-line files achieve 100% completion across all interfaces
    expect(report.negativeControl.aggregates.raw_shell_cat_sed.taskCompletionRatePct).toBe(100);
    expect(report.negativeControl.aggregates.unwindowed_str_replace.taskCompletionRatePct).toBe(100);
    expect(report.negativeControl.aggregates.swe_agent_guarded_aci.taskCompletionRatePct).toBe(100);
  });
});
