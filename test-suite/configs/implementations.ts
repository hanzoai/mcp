/**
 * Configuration for different MCP implementation languages.
 *
 * Each entry tells the test-suite how to spawn a particular MCP server
 * over stdio so it can run the same conformance specs against all of them.
 */

import * as path from 'node:path';
import { MCPImplementation } from '../src/types.js';

// Resolve paths relative to the monorepo root ~/work/hanzo/
const HANZO_ROOT = path.resolve(process.env.HANZO_ROOT || path.join(process.cwd(), '..'));

export const implementations: MCPImplementation[] = [
  // ── TypeScript (canonical, always enabled) ─────────────────────────────
  {
    id: 'typescript',
    name: 'Hanzo MCP TypeScript',
    language: 'typescript',
    command: 'node',
    args: ['dist/cli.js', 'serve'],
    cwd: path.join(HANZO_ROOT, 'mcp'),
    env: {
      NODE_ENV: 'test',
      MCP_LOG_LEVEL: 'error',
    },
    startupTimeout: 10000,
    enabled: true,
    expectedCategories: ['hip0300-core', 'hip0300-extended', 'files', 'search', 'shell', 'edit', 'ui'],
    expectedToolCount: 45,
  },

  // ── TypeScript core-only (for comparison) ──────────────────────────────
  {
    id: 'typescript-core',
    name: 'Hanzo MCP TypeScript (Core Only)',
    language: 'typescript',
    command: 'node',
    args: ['dist/cli.js', 'serve', '--core-only'],
    cwd: path.join(HANZO_ROOT, 'mcp'),
    env: {
      NODE_ENV: 'test',
      MCP_LOG_LEVEL: 'error',
    },
    startupTimeout: 10000,
    enabled: false,
    expectedCategories: ['hip0300-core', 'files', 'search', 'shell', 'edit'],
    expectedToolCount: 15,
  },

  // ── Python ─────────────────────────────────────────────────────────────
  {
    id: 'python',
    name: 'Hanzo MCP Python',
    language: 'python',
    command: 'uv',
    args: ['run', 'hanzo-mcp', 'serve'],
    cwd: path.join(HANZO_ROOT, 'python-sdk'),
    env: {
      LOGLEVEL: 'ERROR',
      HANZO_MCP_LOG_LEVEL: 'ERROR',
      // Prevent Python from writing __pycache__ in test runs
      PYTHONDONTWRITEBYTECODE: '1',
    },
    startupTimeout: 15000,
    enabled: true,
    expectedCategories: ['hip0300-core', 'hip0300-extended'],
    expectedToolCount: 30,
  },

  // ── Rust (enable when tool implementations land) ───────────────────────
  {
    id: 'rust',
    name: 'Hanzo MCP Rust',
    language: 'rust',
    command: 'cargo',
    args: ['run', '--release', '--bin', 'hanzo-mcp-server', '--', 'serve'],
    cwd: path.join(HANZO_ROOT, 'rust-sdk'),
    env: {
      RUST_LOG: 'error',
    },
    startupTimeout: 30000, // Cargo build can be slow on first run
    enabled: false,        // Enable when HIP-0300 tools are implemented
    expectedCategories: ['hip0300-core'],
    expectedToolCount: 13,
  },

  // ── Go (future) ────────────────────────────────────────────────────────
  {
    id: 'go',
    name: 'Hanzo MCP Go',
    language: 'go',
    command: 'go',
    args: ['run', 'cmd/mcp-server/main.go', 'serve'],
    cwd: path.join(HANZO_ROOT, 'go-sdk'),
    env: {
      GO_LOG_LEVEL: 'ERROR',
    },
    startupTimeout: 15000,
    enabled: false,
    expectedCategories: ['hip0300-core'],
    expectedToolCount: 10,
  },
];

/**
 * Get implementations by filter criteria
 */
export function getImplementations(filter?: {
  enabled?: boolean;
  language?: string;
  categories?: string[];
}): MCPImplementation[] {
  let filtered = implementations;

  if (filter?.enabled !== undefined) {
    filtered = filtered.filter(impl => impl.enabled === filter.enabled);
  }

  if (filter?.language) {
    filtered = filtered.filter(impl => impl.language === filter.language);
  }

  if (filter?.categories) {
    filtered = filtered.filter(impl =>
      filter.categories!.some(cat => impl.expectedCategories.includes(cat)),
    );
  }

  return filtered;
}

/**
 * Get implementation by ID
 */
export function getImplementation(id: string): MCPImplementation | undefined {
  return implementations.find(impl => impl.id === id);
}

/**
 * Get enabled implementations only
 */
export function getEnabledImplementations(): MCPImplementation[] {
  return getImplementations({ enabled: true });
}

/**
 * Development configurations for different environments
 */
export const developmentConfigs = {
  // Local development - all enabled implementations
  local: {
    implementations: getEnabledImplementations(),
    parallel: {
      maxConcurrentImplementations: 2,
      maxConcurrentTestsPerImpl: 3,
    },
  },

  // CI environment - TypeScript only
  ci: {
    implementations: getImplementations({
      enabled: true,
      language: 'typescript',
    }),
    parallel: {
      maxConcurrentImplementations: 1,
      maxConcurrentTestsPerImpl: 5,
    },
  },

  // HIP-0300 conformance - all enabled, hip0300 categories only
  conformance: {
    implementations: getEnabledImplementations(),
    parallel: {
      maxConcurrentImplementations: 3,
      maxConcurrentTestsPerImpl: 5,
    },
  },

  // Quick test - core tools only
  quick: {
    implementations: getEnabledImplementations(),
    parallel: {
      maxConcurrentImplementations: 1,
      maxConcurrentTestsPerImpl: 2,
    },
  },

  // Performance test - single implementation, max parallelism
  performance: {
    implementations: [getImplementation('typescript')!].filter(Boolean),
    parallel: {
      maxConcurrentImplementations: 1,
      maxConcurrentTestsPerImpl: 10,
    },
  },
};

/**
 * Environment detection and configuration selection
 */
export function getConfigForEnvironment(): {
  implementations: MCPImplementation[];
  parallel: { maxConcurrentImplementations: number; maxConcurrentTestsPerImpl: number };
} {
  const testMode = process.env.MCP_TEST_MODE;
  const isCI = process.env.CI === 'true';

  if (isCI) {
    return developmentConfigs.ci;
  }

  if (testMode === 'quick') {
    return developmentConfigs.quick;
  }

  if (testMode === 'conformance') {
    return developmentConfigs.conformance;
  }

  if (testMode === 'performance') {
    return developmentConfigs.performance;
  }

  return developmentConfigs.local;
}
