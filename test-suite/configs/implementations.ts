/**
 * Configuration for different MCP implementation languages
 */

import { MCPImplementation } from '../src/types.js';

export const implementations: MCPImplementation[] = [
  // TypeScript implementation (current)
  {
    id: 'typescript',
    name: 'Hanzo MCP TypeScript',
    language: 'typescript',
    command: 'node',
    args: ['dist/cli.js', 'serve'],
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      MCP_LOG_LEVEL: 'error' // Reduce noise during testing
    },
    startupTimeout: 10000,
    enabled: true,
    expectedCategories: ['files', 'search', 'shell', 'edit', 'ui', 'autogui'],
    expectedToolCount: 45 // Approximate count, will be validated dynamically
  },

  // TypeScript core-only (for comparison)
  {
    id: 'typescript-core',
    name: 'Hanzo MCP TypeScript (Core Only)',
    language: 'typescript',
    command: 'node',
    args: ['dist/cli.js', 'serve', '--core-only'],
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      MCP_LOG_LEVEL: 'error'
    },
    startupTimeout: 10000,
    enabled: true,
    expectedCategories: ['files', 'search', 'shell', 'edit'],
    expectedToolCount: 15
  },

  // Rust implementation (future)
  {
    id: 'rust',
    name: 'Hanzo MCP Rust',
    language: 'rust',
    command: 'cargo',
    args: ['run', '--bin', 'mcp-server', '--', 'serve'],
    cwd: '../mcp-rust', // Relative to main MCP directory
    env: {
      RUST_LOG: 'error'
    },
    startupTimeout: 15000,
    enabled: false, // Enable when Rust implementation is ready
    expectedCategories: ['files', 'search', 'shell', 'edit'],
    expectedToolCount: 15
  },

  // Python implementation (future)
  {
    id: 'python',
    name: 'Hanzo MCP Python',
    language: 'python',
    command: 'python',
    args: ['-m', 'hanzo_mcp', 'serve'],
    cwd: '../mcp-python',
    env: {
      PYTHONPATH: '../mcp-python/src',
      LOGLEVEL: 'ERROR'
    },
    startupTimeout: 12000,
    enabled: false, // Enable when Python implementation is ready
    expectedCategories: ['files', 'search', 'shell', 'edit', 'autogui'],
    expectedToolCount: 25
  },

  // Go implementation (future)
  {
    id: 'go',
    name: 'Hanzo MCP Go',
    language: 'go',
    command: 'go',
    args: ['run', 'cmd/mcp-server/main.go', 'serve'],
    cwd: '../mcp-go',
    env: {
      GO_LOG_LEVEL: 'ERROR'
    },
    startupTimeout: 10000,
    enabled: false, // Enable when Go implementation is ready
    expectedCategories: ['files', 'search', 'shell'],
    expectedToolCount: 10
  }
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
      filter.categories!.some(cat => impl.expectedCategories.includes(cat))
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
  // Local development - all implementations
  local: {
    implementations: getEnabledImplementations(),
    parallel: {
      maxConcurrentImplementations: 2,
      maxConcurrentTestsPerImpl: 3
    }
  },

  // CI environment - only TypeScript
  ci: {
    implementations: getImplementations({ 
      enabled: true, 
      language: 'typescript' 
    }),
    parallel: {
      maxConcurrentImplementations: 1,
      maxConcurrentTestsPerImpl: 5
    }
  },

  // Quick test - core tools only
  quick: {
    implementations: getImplementations({ 
      enabled: true 
    }).filter(impl => impl.id.includes('core')),
    parallel: {
      maxConcurrentImplementations: 1,
      maxConcurrentTestsPerImpl: 2
    }
  },

  // Performance test - single implementation, max parallelism
  performance: {
    implementations: [getImplementation('typescript')!].filter(Boolean),
    parallel: {
      maxConcurrentImplementations: 1,
      maxConcurrentTestsPerImpl: 10
    }
  }
};

/**
 * Environment detection and configuration selection
 */
export function getConfigForEnvironment(): {
  implementations: MCPImplementation[];
  parallel: { maxConcurrentImplementations: number; maxConcurrentTestsPerImpl: number };
} {
  // Check environment variables
  const env = process.env.NODE_ENV || 'development';
  const testMode = process.env.MCP_TEST_MODE;
  const isCI = process.env.CI === 'true';

  if (isCI) {
    return developmentConfigs.ci;
  }

  if (testMode === 'quick') {
    return developmentConfigs.quick;
  }

  if (testMode === 'performance') {
    return developmentConfigs.performance;
  }

  return developmentConfigs.local;
}