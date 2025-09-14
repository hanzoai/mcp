#!/usr/bin/env ts-node

/**
 * Quick Start Example - Basic MCP Test Suite Usage
 */

import { runMCPTestSuite, quickTest } from '../src/index.js';

async function main() {
  console.log('🚀 MCP Test Suite Quick Start Examples\n');

  try {
    // Example 1: Quick test with TypeScript implementation
    console.log('1. Running quick test (core tools only)...');
    const quickResults = await quickTest({
      implementation: 'typescript',
      categories: ['files', 'shell'],
      verbose: false
    });
    
    console.log(`✅ Quick test completed: ${quickResults.passedTests}/${quickResults.totalTests} passed\n`);

    // Example 2: Full test suite with custom configuration
    console.log('2. Running custom test suite...');
    const customResults = await runMCPTestSuite({
      implementations: [
        {
          id: 'typescript-custom',
          name: 'TypeScript Custom Test',
          language: 'typescript',
          command: 'node',
          args: ['../dist/cli.js', 'serve'],
          enabled: true,
          expectedCategories: ['files', 'search', 'shell'],
          expectedToolCount: 15
        }
      ],
      testTimeout: 15000,
      parallel: {
        maxConcurrentImplementations: 1,
        maxConcurrentTestsPerImpl: 2
      },
      output: {
        resultsDir: './example-results',
        verbose: true,
        generateHtmlReport: true,
        generateJsonReport: true
      }
    });

    console.log('📊 Custom test results:');
    console.log(`Total tests: ${customResults.totalTests}`);
    console.log(`Passed: ${customResults.passedTests}`);
    console.log(`Failed: ${customResults.failedTests}`);
    console.log(`Success rate: ${((customResults.passedTests / customResults.totalTests) * 100).toFixed(1)}%`);

    // Example 3: Implementation comparison
    if (customResults.implementations.length > 1) {
      console.log('\n🔍 Implementation Comparison:');
      for (const impl of customResults.implementations) {
        const stats = customResults.summary[impl];
        const rate = ((stats.passed / stats.total) * 100).toFixed(1);
        console.log(`  ${impl}: ${stats.passed}/${stats.total} (${rate}%)`);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}