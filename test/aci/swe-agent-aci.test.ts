/**
 * Comprehensive Jest test suite for SWE-agent Agent-Computer Interface (ACI)
 * Optimization (HIP-1348 / hanzoai/mcp#44).
 */

import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AciResponseAdapter,
  StatefulWindowViewer,
  buildBenchmarkTasks,
  computeFileSha256,
  formatCompactToolResponse,
  lintedEdit,
  resolveSafeWorkspacePath,
  resolveWorkspaceRoot,
  runFastSyntaxLint,
  runSweAgentAciBenchmark,
  viewWindow,
} from '../../src/aci/index.js';
import { createMCPServer } from '../../src/index.js';

function makeTempDir(prefix = 'hanzo-aci-test-'): string {
  return resolveWorkspaceRoot(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe('SWE-agent ACI Primitives (HIP-1348)', () => {
  describe('Windowed Line-Numbered File Viewer (viewWindow)', () => {
    it('renders bounded 100-line viewport with header and supports center/scroll/anchor navigation', () => {
      const dir = makeTempDir();
      try {
        const lines = Array.from({ length: 320 }, (_, i) => `export const lineVal${i + 1} = ${i + 1};`);
        const filePath = path.join(dir, 'src', 'large.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

        const top = viewWindow({ workspaceRoot: dir, filePath: 'src/large.ts' });
        expect(top.startLine).toBe(1);
        expect(top.endLine).toBe(100);
        expect(top.totalLines).toBe(320);
        expect(top.linesAbove).toBe(0);
        expect(top.linesBelow).toBe(220);
        expect(top.header).toBe('[File: src/large.ts | lines 1–100 of 320, 0 lines above / 220 lines below]');
        expect(top.rendered).toContain('   1 | export const lineVal1 = 1;');
        expect(top.rendered).not.toContain('lineVal200');

        const centered = viewWindow({
          workspaceRoot: dir,
          filePath: 'src/large.ts',
          centerLine: 250,
          windowSize: 40,
        });
        expect(centered.startLine).toBe(230);
        expect(centered.endLine).toBe(269);
        expect(centered.linesAbove).toBe(229);
        expect(centered.linesBelow).toBe(51);
        expect(centered.rendered).toContain('250 | export const lineVal250 = 250;');

        const anchored = viewWindow({
          workspaceRoot: dir,
          filePath: 'src/large.ts',
          anchorPattern: 'lineVal175',
          windowSize: 20,
        });
        expect(anchored.rendered).toContain('175 | export const lineVal175 = 175;');

        const stateful = new StatefulWindowViewer(dir, 50);
        const s1 = stateful.open('src/large.ts', 1);
        expect(s1.startLine).toBe(1);
        expect(s1.endLine).toBe(50);
        const s2 = stateful.scrollDown(40);
        expect(s2.startLine).toBe(41);
        const s3 = stateful.scrollUp(20);
        expect(s3.startLine).toBe(21);
        const s4 = stateful.jumpToLine(300);
        expect(s4.endLine).toBe(320);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Atomic Syntax-Linter-Gated Edit (lintedEdit)', () => {
    it('atomically rolls back broken JS, TS, JSON, and Python edits while preserving exact file SHA-256', () => {
      const dir = makeTempDir();
      try {
        const fixtures = [
          {
            rel: 'app.mjs',
            content: 'export function add(a, b) {\n  return a + b;\n}\n',
            oldText: '  return a + b;',
            brokenNewText: '  return (a + b;',
            cleanNewText: '  return a + b + 0;',
            lang: 'javascript' as const,
          },
          {
            rel: 'mod.ts',
            content: 'export function mul(a: number, b: number): number {\n  return a * b;\n}\n',
            oldText: '  return a * b;',
            brokenNewText: '  return a * ;',
            cleanNewText: '  return a * b;',
            lang: 'typescript' as const,
          },
          {
            rel: 'config.json',
            content: '{\n  "timeoutMs": 1000,\n  "retries": 2\n}\n',
            oldText: '  "retries": 2',
            brokenNewText: '  "retries": 3,',
            cleanNewText: '  "retries": 3',
            lang: 'json' as const,
          },
          {
            rel: 'worker.py',
            content: 'def check(flag):\n    if flag:\n        return True\n    return False\n',
            oldText: '    if flag:',
            brokenNewText: '    if flag',
            cleanNewText: '    if bool(flag):',
            lang: 'python' as const,
          },
        ];

        for (const f of fixtures) {
          const full = path.join(dir, f.rel);
          fs.writeFileSync(full, f.content, 'utf8');
          const beforeSha = computeFileSha256(fs.readFileSync(full));

          // 1. Broken edit must be rejected & rolled back atomically
          const bad = lintedEdit({
            workspaceRoot: dir,
            filePath: f.rel,
            oldText: f.oldText,
            newText: f.brokenNewText,
          });
          const afterBadBytes = fs.readFileSync(full, 'utf8');
          const afterBadSha = computeFileSha256(afterBadBytes);

          expect(bad.ok).toBe(false);
          expect(bad.applied).toBe(false);
          expect(bad.rolledBack).toBe(true);
          expect(bad.errorCode).toBe('SYNTAX_LINT_FAILED');
          expect(bad.diagnostics.length).toBeGreaterThan(0);
          expect(bad.actionableHint).toBeTruthy();
          expect(afterBadSha).toBe(beforeSha);
          expect(afterBadBytes).toBe(f.content);
          expect(bad.afterSha256).toBe(beforeSha);

          // 2. Valid edit succeeds and returns localized snippet
          const good = lintedEdit({
            workspaceRoot: dir,
            filePath: f.rel,
            oldText: f.oldText,
            newText: f.cleanNewText,
            expectedSha256: beforeSha,
          });
          expect(good.ok).toBe(true);
          expect(good.applied).toBe(true);
          expect(good.rolledBack).toBe(false);
          expect(good.snippet).toContain('[Edited:');
          expect(runFastSyntaxLint(fs.readFileSync(full, 'utf8'), full, f.lang).ok).toBe(true);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('supports bounded line-range edits and rejects stale expectedSha256 preconditions', () => {
      const dir = makeTempDir();
      try {
        const full = path.join(dir, 'range.mjs');
        fs.writeFileSync(full, 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');
        const res = lintedEdit({
          workspaceRoot: dir,
          filePath: 'range.mjs',
          startLine: 2,
          endLine: 2,
          replacement: 'const b = 20;',
        });
        expect(res.ok).toBe(true);
        expect(fs.readFileSync(full, 'utf8')).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');

        const stale = lintedEdit({
          workspaceRoot: dir,
          filePath: 'range.mjs',
          oldText: 'const c = 3;',
          newText: 'const c = 30;',
          expectedSha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        });
        expect(stale.ok).toBe(false);
        expect(stale.errorCode).toBe('SHA_MISMATCH');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Symlinked TMPDIR Safety & Path Traversal Confinement', () => {
    it('normalizes symlinked workspace roots via fs.realpathSync and blocks escapes', () => {
      const outer = makeTempDir('hanzo-aci-sym-');
      const realWorkspace = path.join(outer, 'real-ws');
      const symlinkWorkspace = path.join(outer, 'symlink-ws');
      const outsideSecret = path.join(outer, 'outside.txt');
      try {
        fs.mkdirSync(realWorkspace, { recursive: true });
        fs.writeFileSync(path.join(realWorkspace, 'index.mjs'), 'export const x = 1;\n', 'utf8');
        fs.writeFileSync(outsideSecret, 'external-file-content\n', 'utf8');
        fs.symlinkSync(realWorkspace, symlinkWorkspace);
        fs.symlinkSync(outsideSecret, path.join(realWorkspace, 'escape-link.txt'));

        // Symlinked root resolves identically to canonical real root (macOS TMPDIR parity)
        expect(resolveWorkspaceRoot(symlinkWorkspace)).toBe(resolveWorkspaceRoot(realWorkspace));

        const viaSymlinkRoot = viewWindow({
          workspaceRoot: symlinkWorkspace,
          filePath: path.join(symlinkWorkspace, 'index.mjs'),
        });
        expect(viaSymlinkRoot.relativePath).toBe('index.mjs');
        expect(viaSymlinkRoot.rendered).toContain('export const x = 1;');

        const editViaSymlink = lintedEdit({
          workspaceRoot: symlinkWorkspace,
          filePath: path.join(symlinkWorkspace, 'index.mjs'),
          oldText: 'export const x = 1;',
          newText: 'export const x = 2;',
        });
        expect(editViaSymlink.ok).toBe(true);

        // Path traversal and outside symlink escapes must be blocked
        expect(() => resolveSafeWorkspacePath(symlinkWorkspace, '../outside.txt')).toThrow(
          /PATH_VIOLATION/
        );
        expect(() => resolveSafeWorkspacePath(symlinkWorkspace, 'escape-link.txt')).toThrow(
          /PATH_VIOLATION/
        );
        const blockedEdit = lintedEdit({
          workspaceRoot: symlinkWorkspace,
          filePath: '../outside.txt',
          oldText: 'external',
          newText: 'mutated',
        });
        expect(blockedEdit.ok).toBe(false);
        expect(blockedEdit.errorCode).toBe('PATH_VIOLATION');
      } finally {
        fs.rmSync(outer, { recursive: true, force: true });
      }
    });
  });

  describe('Structured Compact Command Response Formatter', () => {
    it('collapses 400-line noisy ANSI test output while preserving exact tail error file/line/symbol', () => {
      const noise = Array.from(
        { length: 380 },
        (_, i) => `\x1b[36m[runner] PASS case_${i + 1} elapsed=2ms\x1b[0m`
      ).join('\n');
      const tailError = [
        'FAIL src/scheduler.ts:682 [selectNextSlot] - Expected slot index 1, got -1',
        'Tests: 380 passed, 1 failed',
      ].join('\n');

      const envelope = formatCompactToolResponse({
        rawOutput: noise,
        stderr: tailError,
        exitCode: 1,
        maxBytes: 1200,
        maxTokens: 300,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.exitCode).toBe(1);
      expect(envelope.firstError).not.toBeNull();
      expect(envelope.firstError?.file).toBe('src/scheduler.ts');
      expect(envelope.firstError?.line).toBe(682);
      expect(envelope.firstError?.symbol).toBe('selectNextSlot');
      expect(envelope.truncatedLines).toBeGreaterThan(300);
      expect(envelope.compactBytes).toBeLessThanOrEqual(1200);
      expect(envelope.compressionRatio).toBeLessThan(0.1);
      expect(envelope.rendered).toContain('src/scheduler.ts:682');
      expect(envelope.nextActionHint).toContain('viewWindow');
    });
  });

  describe('Parallel Multi-Session Concurrency Isolation (10 Workspaces)', () => {
    it('isolates 10 concurrent workspaces executing parallel viewWindow and lintedEdit calls', async () => {
      const workspaces = Array.from({ length: 10 }, (_, i) => makeTempDir(`hanzo-aci-conc-${i}-`));
      try {
        const outcomes = await Promise.all(
          workspaces.map(async (ws, idx) => {
            const file = path.join(ws, `mod_${idx}.mjs`);
            const initial = `export function f${idx}(v) {\n  return v + ${idx};\n}\n`;
            fs.writeFileSync(file, initial, 'utf8');
            const initialSha = computeFileSha256(initial);

            const view = viewWindow({ workspaceRoot: ws, filePath: `mod_${idx}.mjs` });
            // First attempt broken syntax -> must roll back leaving initialSha untouched
            const bad = lintedEdit({
              workspaceRoot: ws,
              filePath: `mod_${idx}.mjs`,
              oldText: `  return v + ${idx};`,
              newText: `  return (v + ${idx};`,
            });
            const shaAfterBad = computeFileSha256(fs.readFileSync(file, 'utf8'));

            // Second attempt valid edit -> must succeed independently
            const good = lintedEdit({
              workspaceRoot: ws,
              filePath: `mod_${idx}.mjs`,
              oldText: `  return v + ${idx};`,
              newText: `  return v + ${idx + 100};`,
            });
            const finalText = fs.readFileSync(file, 'utf8');

            return {
              idx,
              viewRel: view.relativePath,
              badRolledBack: bad.rolledBack,
              shaPreserved: shaAfterBad === initialSha,
              goodApplied: good.applied,
              finalHasExpected: finalText.includes(`return v + ${idx + 100};`),
              noCrossBleed: !finalText.includes(`f${(idx + 1) % 10}`),
            };
          })
        );

        expect(outcomes).toHaveLength(10);
        for (const o of outcomes) {
          expect(o.viewRel).toBe(`mod_${o.idx}.mjs`);
          expect(o.badRolledBack).toBe(true);
          expect(o.shaPreserved).toBe(true);
          expect(o.goodApplied).toBe(true);
          expect(o.finalHasExpected).toBe(true);
          expect(o.noCrossBleed).toBe(true);
        }
      } finally {
        for (const ws of workspaces) {
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }
    });
  });

  describe('Live createMCPServer Opt-In Integration & Canonical Surface Preservation', () => {
    it('preserves canonical default tools and wraps fs/exec/code cleanly via AciResponseAdapter', async () => {
      const dir = makeTempDir();
      try {
        const target = path.join(dir, 'sample.mjs');
        const initial = Array.from({ length: 160 }, (_, i) => `export const k${i + 1} = ${i + 1};`).join('\n') + '\n';
        fs.writeFileSync(target, initial, 'utf8');
        const initialSha = computeFileSha256(initial);

        const mcp = await createMCPServer({
          name: 'hanzo-mcp-aci-integration',
          version: '1.0.0',
          projectPath: dir,
          toolConfig: { enableCore: true, enableUI: false },
        });

        // Default canonical surface remains untouched (no extra ACI tools injected)
        const toolNames = mcp.tools.map((t) => t.name);
        expect(toolNames).toContain('fs');
        expect(toolNames).toContain('exec');
        expect(toolNames).toContain('code');
        expect(toolNames).not.toContain('aci_viewer');

        const adapter = new AciResponseAdapter({
          workspaceRoot: dir,
          mode: 'swe_agent_aci_full',
          windowSize: 40,
        });

        // Wrapping preserves exact tool count & names
        const wrapped = adapter.wrapTools(mcp.tools);
        expect(wrapped.map((t) => t.name)).toEqual(toolNames);

        // Windowed fs.read via adapter
        const readRes = await adapter.callTool(mcp, 'fs', {
          action: 'read',
          path: target,
          center_line: 120,
          window_size: 40,
        });
        expect(readRes.isError).toBeFalsy();
        expect(readRes.content[0].text).toContain('lines 100–139 of 160');

        // Broken fs.apply_patch rolls back atomically
        const badPatch = await adapter.callTool(mcp, 'fs', {
          action: 'apply_patch',
          path: target,
          old_text: 'export const k120 = 120;',
          new_text: 'export const k120 = (120;',
        });
        expect(badPatch.isError).toBe(true);
        expect(badPatch.content[0].text).toContain('SYNTAX_LINT_FAILED');
        expect(computeFileSha256(fs.readFileSync(target, 'utf8'))).toBe(initialSha);

        // Compact exec response via adapter
        const execRes = await adapter.callTool(mcp, 'exec', {
          action: 'exec',
          command: 'node -e "for(let i=0;i<120;i++)console.log(\'log \'+i);console.error(\'FAIL sample.mjs:120 [k120] - mismatch\');process.exit(1)"',
          cwd: dir,
        });
        expect(execRes.isError).toBe(true);
        expect(execRes.content[0].text).toContain('first_error: file=sample.mjs:120');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Deterministic 24-Task Seeded Benchmark Suite', () => {
    jest.setTimeout(90_000);

    it('generates identical task schedules for identical seeds', () => {
      const a = buildBenchmarkTasks(1348);
      const b = buildBenchmarkTasks(1348);
      expect(a).toHaveLength(24);
      expect(a.map((t) => ({ id: t.id, hazard: t.hasDraftSyntaxHazard }))).toEqual(
        b.map((t) => ({ id: t.id, hazard: t.hasDraftSyntaxHazard }))
      );
    });

    it('proves swe_agent_aci_full lowers tool calls & tokens while beating baselines on completion & correctness', async () => {
      const report = await runSweAgentAciBenchmark({ seed: 1348 });
      expect(report.config.taskCount).toBe(24);
      expect(report.regimes).toHaveLength(5);

      const byId = new Map(report.regimes.map((r) => [r.regime, r]));
      const raw = byId.get('raw_unbounded_cli')!;
      const head = byId.get('naive_head_truncation')!;
      const win = byId.get('windowed_viewer_only')!;
      const full = byId.get('swe_agent_aci_full')!;
      const over = byId.get('over_compressed_negative')!;

      // Core acceptance invariants
      expect(full.taskCompletionRatePct).toBeGreaterThanOrEqual(raw.taskCompletionRatePct);
      expect(full.patchCorrectnessPct).toBeGreaterThanOrEqual(raw.patchCorrectnessPct);
      expect(full.taskCompletionRatePct).toBeGreaterThan(head.taskCompletionRatePct);
      expect(full.taskCompletionRatePct).toBeGreaterThan(over.taskCompletionRatePct);
      expect(full.patchCorrectnessPct).toBe(100);
      expect(full.taskCompletionRatePct).toBe(100);

      // Strictly lower tool-call count & response tokens vs raw_unbounded_cli and windowed_viewer_only
      expect(full.meanToolCalls).toBeLessThan(raw.meanToolCalls);
      expect(full.meanToolCalls).toBeLessThan(win.meanToolCalls);
      expect(full.meanResponseTokens).toBeLessThan(raw.meanResponseTokens * 0.25);
      expect(full.meanResponseTokens).toBeLessThan(win.meanResponseTokens * 0.35);

      // Syntax-error rollback prevention
      expect(full.syntaxRollbackPreventionRatePct).toBe(100);
      expect(full.syntaxCorruptedDiskWrites).toBe(0);
      expect(raw.syntaxRollbackPreventionRatePct).toBe(0);

      // Documented negative control collapses task completion
      expect(over.taskCompletionRatePct).toBeLessThan(20);

      // Honest boundary regimes
      const sem = report.boundaryRegimes.semanticLogicErrorPassesSyntaxLint;
      expect(sem.syntaxLintPassedRatePct).toBe(100);
      expect(sem.caughtByUnitTestRatePct).toBe(100);
      expect(sem.repairedAfterTestFeedbackRatePct).toBe(100);

      const tiny = report.boundaryRegimes.tinySingleFileOverheadRegime;
      expect(tiny.aciCompletionRatePct).toBe(100);
      expect(tiny.rawCompletionRatePct).toBe(100);
      expect(tiny.aciMeanToolCalls).toBe(tiny.rawMeanToolCalls);
      expect(tiny.meanByteOverhead).toBeGreaterThan(0);
    });
  });
});
