import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { MCPTestRunner } from '../test-suite/src/test-runner.js';
import { autoguiToolSpecs } from '../test-suite/specs/autogui-tools.js';
import { MCPImplementation } from '../test-suite/src/types.js';

describe('MCPTestRunner skipFor ci/headless and skippedTests counting', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  const makeImpl = (id: string): MCPImplementation => ({
    id,
    name: `Mock ${id}`,
    language: 'typescript',
    command: 'node',
    args: [],
    cwd: process.cwd(),
    env: {},
    startupTimeout: 1000,
    enabled: true,
    expectedCategories: ['autogui'],
  });

  function createMockRunner(impls: MCPImplementation[]) {
    const runner = new MCPTestRunner({
      implementations: impls,
      toolSpecs: autoguiToolSpecs,
      parallel: { maxConcurrentImplementations: 2, maxConcurrentTestsPerImpl: 5 },
      output: {
        resultsDir: './test-results',
        verbose: false,
        generateHtmlReport: false,
        generateJsonReport: false,
      },
    });
    const rAny = runner as any;
    rAny.ensureOutputDir = async () => {};
    rAny.saveResults = async () => {};
    rAny.printSummary = () => {};
    rAny.cleanup = async () => {};
    rAny.waitForServer = async () => {};
    rAny.serverManager = {
      startServer: async () => ({}),
      stopAllServers: async () => {},
      isServerRunning: () => true,
      callTool: async (_implId: string, toolName: string, input: any) => {
        if (input && (input.x === -1 || input.button === 'invalid' || input.key === 'invalid_key_name' || input.scale === 0)) {
          return { error: { message: 'invalid coordinates bounds button key scale' } };
        }
        return {
          result: {
            content: [{ type: 'text', text: `performed ${toolName} click double_click right_click move mouse drag scroll type press key hotkey screenshot pixel size windows activate focus sleep` }],
          },
        };
      },
    };
    return runner;
  }

  it('skips the 21 autogui ci/headless cases for every implementation when CI=1 and counts them in skippedTests', async () => {
    process.env.CI = '1';
    process.env.DISPLAY = ':0';
    const impls = [makeImpl('typescript'), makeImpl('python')];
    const runner = createMockRunner(impls);

    const result = await runner.runSuite();

    expect(result.summary.typescript.skipped).toBe(21);
    expect(result.summary.python.skipped).toBe(21);
    expect(result.skippedTests).toBe(42);
    expect(result.skippedTests).toBe(
      Object.values(result.summary).reduce((acc, s) => acc + s.skipped, 0)
    );
    expect(result.totalTests).toBe(result.passedTests + result.failedTests);
  });

  it('runs the 21 autogui cases when CI is unset and DISPLAY is set, and still counts implementation/onlyFor skips', async () => {
    delete process.env.CI;
    process.env.DISPLAY = ':0';
    const impls = [makeImpl('typescript')];
    const runner = createMockRunner(impls);

    const result = await runner.runSuite();

    expect(result.summary.typescript.skipped).toBe(0);
    expect(result.skippedTests).toBe(0);
    expect(result.totalTests).toBeGreaterThanOrEqual(21);
  });

  it('skips headless cases when neither DISPLAY nor WAYLAND_DISPLAY is set', async () => {
    delete process.env.CI;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const impls = [makeImpl('typescript')];
    const runner = createMockRunner(impls);

    const result = await runner.runSuite();

    expect(result.summary.typescript.skipped).toBe(21);
    expect(result.skippedTests).toBe(21);
  });
});
