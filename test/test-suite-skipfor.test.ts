import { describe, test, expect, afterEach } from '@jest/globals';
import { MCPTestRunner } from '../test-suite/src/test-runner.js';
import type { ToolTestCase } from '../test-suite/src/types.js';

/**
 * skipFor environment tags (hanzoai/mcp#14).
 *
 * The autogui specs list `skipFor: ['ci', 'headless']`, but the runner only
 * compared against implementation ids, so those cases were never skipped and
 * the report hard-coded zero skipped tests. These tests pin the new behavior:
 * `ci` matches when `process.env.CI` is set, `headless` when there is no
 * display, and every skipped case is counted per implementation.
 */
describe('skipFor ci/headless environment tags', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const ciCase: ToolTestCase = {
    name: 'autogui-case',
    input: {},
    expect: { success: true },
    skipFor: ['ci', 'headless'],
  };

  test('ci tag skips when CI is set, runs otherwise', () => {
    process.env.CI = '1';
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    // headless also matches here on this machine; isolate the ci tag:
    const onlyCi: ToolTestCase = { ...ciCase, skipFor: ['ci'] };
    expect(MCPTestRunner.isSkippedFor(onlyCi, 'typescript')).toBe(true);

    delete process.env.CI;
    expect(MCPTestRunner.isSkippedFor(onlyCi, 'typescript')).toBe(false);
  });

  test('headless tag skips without a display, runs with one (Linux)', () => {
    if (process.platform !== 'linux') {
      return; // off-Linux is always headless; nothing to toggle
    }
    const onlyHeadless: ToolTestCase = { ...ciCase, skipFor: ['headless'] };
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    expect(MCPTestRunner.isSkippedFor(onlyHeadless, 'typescript')).toBe(true);

    process.env.DISPLAY = ':0';
    expect(MCPTestRunner.isSkippedFor(onlyHeadless, 'typescript')).toBe(false);
  });

  test('implementation id matching still works', () => {
    delete process.env.CI;
    process.env.DISPLAY = ':0';
    const byId: ToolTestCase = { ...ciCase, skipFor: ['typescript'] };
    expect(MCPTestRunner.isSkippedFor(byId, 'typescript')).toBe(true);
    expect(MCPTestRunner.isSkippedFor(byId, 'python')).toBe(false);
  });

  test('onlyFor exclusions also count as skipped', () => {
    delete process.env.CI;
    process.env.DISPLAY = ':0';
    const onlyFor: ToolTestCase = {
      name: 'python-only',
      input: {},
      expect: { success: true },
      onlyFor: ['python'],
    };
    expect(MCPTestRunner.isSkippedFor(onlyFor, 'typescript')).toBe(true);
    expect(MCPTestRunner.isSkippedFor(onlyFor, 'python')).toBe(false);
  });

  test('skipped cases are counted per implementation and in skippedTests', async () => {
    process.env.CI = '1';
    const runner = new MCPTestRunner({
      implementations: [
        {
          id: 'typescript',
          name: 'TypeScript',
          language: 'typescript',
          command: 'node',
          args: [],
          enabled: true,
          expectedCategories: ['autogui'],
        },
      ],
      toolSpecs: [
        {
          name: 'autogui',
          category: 'autogui',
          description: 'GUI automation',
          testCases: [ciCase],
        },
      ],
      parallel: { maxConcurrentTestsPerImpl: 5, maxConcurrentImplementations: 1 },
      output: {
        resultsDir: './test-results',
        verbose: false,
        generateHtmlReport: false,
        generateJsonReport: false,
      },
    });
    // Bypass server startup: exercise the skip filter + report aggregation.
    const impl = (runner as any).config.implementations[0];
    const results: any[] = [];
    await (runner as any).runToolTestsInParallel(impl, (runner as any).config.toolSpecs, results);
    expect(results).toHaveLength(0); // skipped, not run
    const suite = (runner as any).generateSuiteResult(Date.now());
    expect(suite.skippedTests).toBe(1);
    expect(suite.summary['typescript'].skipped).toBe(1);
    expect(suite.skippedTests).toBe(
      Object.values(suite.summary).reduce((n: number, s: any) => n + s.skipped, 0)
    );
  });
});
