/**
 * MCP Test Suite - Language-agnostic MCP implementation testing
 * 
 * This is the main entry point for the MCP Test Suite, providing
 * comprehensive testing capabilities for any MCP implementation
 * across different programming languages.
 */

// Core exports
export * from './types.js';
export * from './mcp-protocol.js';
export * from './server-manager.js';
export * from './test-runner.js';

// Configuration and specifications
export * from '../configs/implementations.js';
export * from '../specs/index.js';

// Re-export main runner function for convenience
export { runMCPTestSuite } from './test-runner.js';

// Version info
export const VERSION = '1.0.0';

/**
 * Quick start function for programmatic usage
 */
export async function quickTest(options?: {
  implementation?: string;
  categories?: string[];
  verbose?: boolean;
}) {
  const { runMCPTestSuite } = await import('./test-runner.js');
  const { getImplementation } = await import('../configs/implementations.js');
  const { allToolSpecs } = await import('../specs/index.js');

  const config: any = {
    output: {
      verbose: options?.verbose || false,
      generateHtmlReport: false,
      generateJsonReport: true
    }
  };

  if (options?.implementation) {
    const impl = getImplementation(options.implementation);
    if (!impl) {
      throw new Error(`Implementation '${options.implementation}' not found`);
    }
    config.implementations = [impl];
  }

  if (options?.categories) {
    config.toolSpecs = allToolSpecs.filter(spec => 
      options.categories!.includes(spec.category)
    );
  }

  return await runMCPTestSuite(config);
}