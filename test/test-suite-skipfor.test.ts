import { describe, expect, it, afterEach } from '@jest/globals';
import { getEnvironmentTags, shouldSkipTest, MCPTestRunner } from '../test-suite/src/test-runner.js';
import { autoguiToolSpecs } from '../test-suite/specs/autogui-tools.js';

describe('test-suite skipFor environment tags', () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('detects ci environment tag when process.env.CI is set', () => {
    process.env.CI = '1';
    expect(getEnvironmentTags()).toContain('ci');
  });

  it('detects headless environment tag when DISPLAY and WAYLAND_DISPLAY are unset on Linux', () => {
    delete process.env.CI;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    expect(getEnvironmentTags()).toContain('headless');
  });

  it('does not detect ci or headless when CI is unset and DISPLAY is set on Linux', () => {
    delete process.env.CI;
    process.env.DISPLAY = ':0';
    delete process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    expect(getEnvironmentTags()).not.toContain('ci');
    expect(getEnvironmentTags()).not.toContain('headless');
  });

  it('skips all 21 autogui cases for every implementation when CI=1', () => {
    process.env.CI = '1';
    const envTags = getEnvironmentTags();
    const implementations = ['typescript', 'typescript-core', 'python', 'rust', 'go'];

    const allAutoguiCases = autoguiToolSpecs.flatMap(s => s.testCases);
    const autoguiCiCases = allAutoguiCases.filter(tc => tc.skipFor?.includes('ci'));
    expect(autoguiCiCases.length).toBe(21);

    for (const impl of implementations) {
      const skippedCount = allAutoguiCases.filter(tc => shouldSkipTest(tc, impl, envTags)).length;
      expect(skippedCount).toBe(21);
    }
  });

  it('runs all 21 autogui cases when CI is unset and display is present', () => {
    delete process.env.CI;
    process.env.DISPLAY = ':0';
    delete process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const envTags = getEnvironmentTags();

    const allAutoguiCases = autoguiToolSpecs.flatMap(s => s.testCases);
    const skippedCount = allAutoguiCases.filter(tc => shouldSkipTest(tc, 'typescript', envTags)).length;
    expect(skippedCount).toBe(0);
  });

  it('records skippedTests as sum of summary[impl].skipped and does not count skipped as passed or failed', () => {
    const runner = new MCPTestRunner({
      implementations: [
        { id: 'typescript', name: 'TypeScript', enabled: true, serverType: 'node', startCommand: 'node', args: [], healthCheckTimeout: 1000, expectedCategories: ['tools'] },
        { id: 'python', name: 'Python', enabled: true, serverType: 'python', startCommand: 'python', args: [], healthCheckTimeout: 1000, expectedCategories: ['tools'] }
      ]
    });

    (runner as any).skippedByImpl = {
      typescript: 21,
      python: 21,
    };
    (runner as any).results = [
      { implementation: 'typescript', category: 'tools', toolName: 'test', testCase: 'case1', success: true, duration: 10 },
      { implementation: 'python', category: 'tools', toolName: 'test', testCase: 'case2', success: false, duration: 10 }
    ];

    const suiteResult = (runner as any).generateSuiteResult(Date.now());
    expect(suiteResult.summary.typescript.skipped).toBe(21);
    expect(suiteResult.summary.python.skipped).toBe(21);
    expect(suiteResult.skippedTests).toBe(42);
    expect(suiteResult.passedTests).toBe(1);
    expect(suiteResult.failedTests).toBe(1);
  });
});
