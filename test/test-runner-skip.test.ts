import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MCPTestRunner } from '../test-suite/src/test-runner.js';
import { MCPImplementation, ToolTestSpec } from '../test-suite/src/types.js';

describe('MCPTestRunner skipFor environment tags and skipped counts', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createRunnerWithSpecs(
    implementations: MCPImplementation[],
    toolSpecs: ToolTestSpec[]
  ): { runner: MCPTestRunner; executedCases: Array<{ implId: string; testName: string }> } {
    const executedCases: Array<{ implId: string; testName: string }> = [];

    const runner = new MCPTestRunner({
      implementations,
      toolSpecs,
      parallel: {
        maxConcurrentImplementations: 1,
        maxConcurrentTestsPerImpl: 2
      },
      output: {
        resultsDir: './test-results-skip-unit',
        verbose: false,
        generateHtmlReport: false,
        generateJsonReport: false
      }
    });

    // Stub server lifecycle and single-test execution so unit tests run in-memory without spawning processes
    const anyRunner = runner as any;
    anyRunner.ensureOutputDir = async () => {};
    anyRunner.saveResults = async () => {};
    anyRunner.cleanup = async () => {};
    anyRunner.waitForServer = async () => {};
    anyRunner.serverManager = {
      startServer: async () => ({}),
      stopAllServers: async () => {},
      isServerRunning: () => true
    };
    anyRunner.runSingleTest = async (impl: MCPImplementation, spec: ToolTestSpec, tc: any) => {
      executedCases.push({ implId: impl.id, testName: tc.name });
      return {
        implementation: impl.id,
        category: spec.category,
        toolName: spec.name,
        testCase: tc.name,
        success: true,
        duration: 1
      };
    };

    return { runner, executedCases };
  }

  const baseImpl: MCPImplementation = {
    id: 'impl-alpha',
    name: 'Alpha MCP',
    language: 'typescript',
    command: 'node',
    args: [],
    enabled: true,
    expectedCategories: ['files']
  };

  it('skips tests tagged skipFor: ["ci"] when process.env.CI is set and tracks skipped counts', async () => {
    process.env.CI = 'true';
    process.env.DISPLAY = ':0';
    delete process.env.WAYLAND_DISPLAY;

    const specs: ToolTestSpec[] = [
      {
        name: 'read',
        category: 'files',
        description: 'Read file test spec',
        testCases: [
          {
            name: 'runs_everywhere',
            description: 'Always runs',
            input: {},
            expect: { success: true }
          },
          {
            name: 'skip_in_ci',
            description: 'Skipped in CI',
            input: {},
            expect: { success: true },
            skipFor: ['ci']
          },
          {
            name: 'skip_in_headless',
            description: 'Not skipped when DISPLAY is present',
            input: {},
            expect: { success: true },
            skipFor: ['headless']
          }
        ]
      }
    ];

    const { runner, executedCases } = createRunnerWithSpecs([baseImpl], specs);
    const result = await runner.runSuite();

    expect(executedCases.map(c => c.testName)).toEqual(['runs_everywhere', 'skip_in_headless']);
    expect(result.summary['impl-alpha'].skipped).toBe(1);
    expect(result.skippedTests).toBe(1);
    expect(result.passedTests).toBe(2);
  });

  it('skips tests tagged skipFor: ["headless"] on Linux when neither DISPLAY nor WAYLAND_DISPLAY is set', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env.CI;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    const specs: ToolTestSpec[] = [
      {
        name: 'screen',
        category: 'files',
        description: 'Screen capture spec',
        testCases: [
          {
            name: 'headless_sensitive',
            description: 'Requires display server',
            input: {},
            expect: { success: true },
            skipFor: ['headless']
          },
          {
            name: 'impl_skipped',
            description: 'Skipped for impl-alpha explicitly',
            input: {},
            expect: { success: true },
            skipFor: ['impl-alpha']
          },
          {
            name: 'only_for_other_impl',
            description: 'Only for impl-beta',
            input: {},
            expect: { success: true },
            onlyFor: ['impl-beta']
          },
          {
            name: 'normal_case',
            description: 'Runs in headless',
            input: {},
            expect: { success: true }
          }
        ]
      }
    ];

    const { runner, executedCases } = createRunnerWithSpecs([baseImpl], specs);
    const result = await runner.runSuite();

    expect(executedCases.map(c => c.testName)).toEqual(['normal_case']);
    expect(result.summary['impl-alpha'].skipped).toBe(3);
    expect(result.skippedTests).toBe(3);
    expect(result.totalTests).toBe(1);
  });
});
