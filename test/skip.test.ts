/**
 * Tests for environment-aware skip handling (issue #14).
 *
 * Before this change, test cases tagged `skipFor: ['ci', 'headless']`
 * matched no implementation id, so on CI (GitHub Actions) the 21 autogui
 * screen-control cases ran anyway and typically failed — and skipped cases
 * were never counted (`skipped: 0 // TODO`). These tests lock in:
 *   1. environment tag resolution,
 *   2. per-implementation skip counting for every implementation,
 *   3. suite-level skippedTests / summary consistency.
 */
import { describe, expect, it, test } from '@jest/globals';
import {
  environmentTags,
  shouldSkipTestCase,
  partitionTestCases
} from '../test-suite/src/skip.js';
import { autoguiToolSpecs } from '../test-suite/specs/autogui-tools.js';
import { MCPTestRunner } from '../test-suite/src/test-runner.js';

const IMPLEMENTATION_IDS = ['typescript', 'typescript-core', 'python', 'rust', 'go'];

const AUTOGUI_CASES = autoguiToolSpecs.reduce(
  (n, spec) => n + spec.testCases.length,
  0
);
const CI_TAGGED = autoguiToolSpecs.reduce(
  (n, spec) => n + spec.testCases.filter(tc => tc.skipFor?.includes('ci')).length,
  0
);

describe('environmentTags', () => {
  test('CI=1 yields the ci tag', () => {
    expect(environmentTags({ CI: '1' }, 'linux')).toContain('ci');
  });

  test('linux without DISPLAY or WAYLAND_DISPLAY yields headless', () => {
    const tags = environmentTags({}, 'linux');
    expect(tags).toContain('headless');
    expect(tags).not.toContain('ci');
  });

  test('a display (X11 or Wayland) means not headless', () => {
    expect(environmentTags({ DISPLAY: ':0' }, 'linux')).not.toContain('headless');
    expect(environmentTags({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).not.toContain('headless');
  });

  test('non-linux platforms are never tagged headless', () => {
    expect(environmentTags({}, 'darwin')).toEqual([]);
    expect(environmentTags({}, 'win32')).toEqual([]);
  });

  test('GitHub-Actions-like env resolves to both tags', () => {
    expect(environmentTags({ CI: 'true' }, 'linux')).toEqual(['ci', 'headless']);
  });
});

describe('shouldSkipTestCase', () => {
  test('skipFor implementation id skips with reason skipFor', () => {
    expect(
      shouldSkipTestCase({ skipFor: ['python'] }, 'python', [])
    ).toEqual({ skip: true, reason: 'skipFor' });
    expect(
      shouldSkipTestCase({ skipFor: ['python'] }, 'rust', [])
    ).toEqual({ skip: false });
  });

  test('skipFor environment tag skips when the tag matches the environment', () => {
    expect(
      shouldSkipTestCase({ skipFor: ['ci', 'headless'] }, 'typescript', ['ci'])
    ).toEqual({ skip: true, reason: 'environment' });
    expect(
      shouldSkipTestCase({ skipFor: ['ci', 'headless'] }, 'typescript', [])
    ).toEqual({ skip: false });
  });

  test('onlyFor allow-list skips implementations that are not listed', () => {
    expect(
      shouldSkipTestCase({ onlyFor: ['typescript'] }, 'python', [])
    ).toEqual({ skip: true, reason: 'onlyFor' });
    expect(
      shouldSkipTestCase({ onlyFor: ['typescript'] }, 'typescript', [])
    ).toEqual({ skip: false });
  });
});

describe('autogui environment-tag skips (issue #14)', () => {
  test('the autogui spec carries exactly the 21 ci/headless-tagged cases', () => {
    expect(CI_TAGGED).toBe(21);
    expect(AUTOGUI_CASES).toBeGreaterThanOrEqual(21);
  });

  test('CI=1: the 21 tagged cases are skipped for EVERY implementation', () => {
    for (const implId of IMPLEMENTATION_IDS) {
      const { skipped, runnable } = partitionTestCases(autoguiToolSpecs, {
        implementationId: implId,
        envTags: ['ci']
      });
      const envSkips = skipped.filter(s => s.reason === 'environment');
      expect(envSkips.length).toBe(21);
      // none of these skips is an implementation-id skip
      expect(skipped.filter(s => s.reason === 'skipFor').length).toBe(0);
      expect(runnable.length).toBe(AUTOGUI_CASES - 21);
    }
  });

  test('without CI and with a display the same cases run (not skipped)', () => {
    const envTags = environmentTags({ DISPLAY: ':0' }, 'linux');
    expect(envTags).toEqual([]);
    for (const implId of IMPLEMENTATION_IDS) {
      const { skipped, runnable } = partitionTestCases(autoguiToolSpecs, {
        implementationId: implId,
        envTags
      });
      expect(skipped.length).toBe(0);
      expect(runnable.length).toBe(AUTOGUI_CASES);
    }
  });

  test('skips are counted even when the implementation does not expect the category', () => {
    // Runner behaviour: autogui is not in expectedCategories for these
    // implementations, yet the tagged cases must still be counted as skipped
    // instead of silently vanishing from totals.
    const { skipped, runnable } = partitionTestCases(autoguiToolSpecs, {
      implementationId: 'typescript',
      envTags: ['ci'],
      isRelevant: () => false
    });
    expect(runnable.length).toBe(0);
    expect(skipped.filter(s => s.reason === 'environment').length).toBe(21);
  });
});

describe('suite-level skipped accounting', () => {
  function makeSuite(skippedByImplementation: Array<[string, number]>) {
    const runner = new MCPTestRunner({
      implementations: [
        {
          id: 'typescript',
          name: 'TypeScript',
          language: 'typescript',
          command: 'true',
          args: [],
          enabled: true,
          expectedCategories: ['core']
        },
        {
          id: 'python',
          name: 'Python',
          language: 'python',
          command: 'true',
          args: [],
          enabled: true,
          expectedCategories: ['core']
        }
      ],
      toolSpecs: []
    });
    const anyRunner = runner as any;
    anyRunner.results = [
      { implementation: 'typescript', category: 'core', toolName: 't', testCase: 'a', success: true, duration: 1 },
      { implementation: 'typescript', category: 'core', toolName: 't', testCase: 'b', success: false, duration: 1, error: 'boom' },
      { implementation: 'python', category: 'core', toolName: 't', testCase: 'a', success: true, duration: 1 }
    ];
    anyRunner.skippedByImplementation = new Map(skippedByImplementation);
    return anyRunner.generateSuiteResult(Date.now()) as any;
  }

  test('suite skippedTests equals the sum of per-implementation skipped', () => {
    const suite = makeSuite([['typescript', 21], ['python', 21]]);
    expect(suite.summary.typescript.skipped).toBe(21);
    expect(suite.summary.python.skipped).toBe(21);
    expect(suite.skippedTests).toBe(42);
    expect(suite.skippedTests).toBe(
      Object.values(suite.summary).reduce((sum: number, impl: any) => sum + impl.skipped, 0)
    );
  });

  test('skipped cases are not counted as passed, failed, or executed', () => {
    const suite = makeSuite([['typescript', 5]]);
    expect(suite.passedTests).toBe(2);
    expect(suite.failedTests).toBe(1);
    expect(suite.totalTests).toBe(3);
    expect(suite.passedTests + suite.failedTests).toBe(suite.totalTests);
    expect(suite.skippedTests).toBe(5);
    expect(suite.summary.python.skipped).toBe(0);
  });
});
