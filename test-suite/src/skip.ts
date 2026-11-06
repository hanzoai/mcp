/**
 * Environment-aware skip handling for the MCP test suite.
 *
 * Test cases can declare `skipFor` with implementation ids (e.g. ['python'])
 * but also with pure environment tags such as ['ci', 'headless']. Those tags
 * describe the machine the suite runs on — not an implementation — so they
 * are resolved here against the current environment and every skipped case
 * is counted instead of silently disappearing from the totals.
 */
import type { ToolTestCase, ToolTestSpec } from './types.js';

/**
 * Tags describing the environment the suite is running in.
 *
 * - `ci`: set when `process.env.CI` is truthy (GitHub Actions, GitLab CI, …).
 * - `headless`: Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY` set.
 *
 * For example, on GitHub Actions `environmentTags()` returns `['ci', 'headless']`.
 */
export function environmentTags(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): string[] {
  const tags: string[] = [];
  if (env.CI) {
    tags.push('ci');
  }
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    tags.push('headless');
  }
  return tags;
}

/** Skip/allow-list directives a single test case may carry. */
export interface SkipDirectives {
  skipFor?: string[];
  onlyFor?: string[];
}

export type SkipDecision =
  | { skip: false }
  | { skip: true; reason: 'skipFor' | 'environment' | 'onlyFor' };

/**
 * Decide whether a single test case must be skipped for an implementation.
 *
 * Order: `skipFor` implementation ids → `skipFor` environment tags → `onlyFor`
 * allow-list. Note that every skipped case is counted for EVERY configured
 * implementation: an autogui case tagged `skipFor: ['ci']` is reported as
 * skipped for typescript, python, rust, go, … even when the implementation
 * does not expect the autogui category at all.
 */
export function shouldSkipTestCase(
  testCase: SkipDirectives,
  implementationId: string,
  envTags: string[]
): SkipDecision {
  if (testCase.skipFor?.includes(implementationId)) {
    return { skip: true, reason: 'skipFor' };
  }
  if (testCase.skipFor?.some(tag => envTags.includes(tag))) {
    return { skip: true, reason: 'environment' };
  }
  if (testCase.onlyFor && !testCase.onlyFor.includes(implementationId)) {
    return { skip: true, reason: 'onlyFor' };
  }
  return { skip: false };
}

export interface PartitionedCases {
  runnable: Array<{ spec: ToolTestSpec; testCase: ToolTestCase }>;
  skipped: Array<{ spec: ToolTestSpec; testCase: ToolTestCase; reason: string }>;
}

/**
 * Split every test case of `toolSpecs` into runnable/skipped buckets for
 * one implementation.
 *
 * - Skips (implementation id, environment tag, `onlyFor`) are resolved
 *   first for every spec, so skipped cases are always counted.
 * - Cases that are neither skipped nor relevant to the implementation
 *   (via `isRelevant`) are dropped: they belong to no implementation's run.
 */
export function partitionTestCases(
  toolSpecs: ToolTestSpec[],
  options: {
    implementationId: string;
    envTags: string[];
    isRelevant?: (spec: ToolTestSpec) => boolean;
  }
): PartitionedCases {
  const { implementationId, envTags, isRelevant } = options;
  const partitioned: PartitionedCases = { runnable: [], skipped: [] };

  for (const spec of toolSpecs) {
    for (const testCase of spec.testCases) {
      const decision = shouldSkipTestCase(testCase, implementationId, envTags);
      if (decision.skip) {
        partitioned.skipped.push({ spec, testCase, reason: decision.reason });
        continue;
      }
      if (isRelevant && !isRelevant(spec)) {
        continue;
      }
      partitioned.runnable.push({ spec, testCase });
    }
  }

  return partitioned;
}
