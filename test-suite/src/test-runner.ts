/**
 * Main MCP Test Runner - Orchestrates testing across multiple implementations
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { 
  TestRunnerConfig, 
  TestResult, 
  TestSuiteResult, 
  ToolTestSpec,
  ToolTestCase,
  MCPImplementation
} from './types.js';
import { MCPServerManager } from './server-manager.js';
import { allToolSpecs } from '../specs/index.js';
import { getConfigForEnvironment } from '../configs/implementations.js';

export interface TestRunnerEvents {
  'test-start': (implementation: string, toolName: string, testCase: string) => void;
  'test-complete': (result: TestResult) => void;
  'implementation-start': (implementation: string) => void;
  'implementation-complete': (implementation: string, results: TestResult[]) => void;
  'suite-complete': (results: TestSuiteResult) => void;
  'progress': (current: number, total: number) => void;
}

export class MCPTestRunner extends EventEmitter {
  private serverManager = new MCPServerManager();
  private config: TestRunnerConfig;
  private results: TestResult[] = [];

  constructor(config?: Partial<TestRunnerConfig>) {
    super();
    
    // Default configuration
    const envConfig = getConfigForEnvironment();
    
    this.config = {
      implementations: envConfig.implementations,
      toolSpecs: allToolSpecs,
      testTimeout: 30000,
      parallel: envConfig.parallel,
      output: {
        resultsDir: './test-results',
        verbose: process.env.VERBOSE === 'true',
        generateHtmlReport: true,
        generateJsonReport: true
      },
      fixturesDir: './fixtures',
      ...config
    };

    // Setup server manager event handlers
    this.serverManager.on('server-ready', (impl) => {
      if (this.config.output.verbose) {
        console.log(`✅ Server ready: ${impl.name}`);
      }
    });

    this.serverManager.on('server-error', (impl, error) => {
      console.error(`❌ Server error for ${impl.name}:`, error.message);
    });
  }

  /**
   * Run the complete test suite
   */
  async runSuite(): Promise<TestSuiteResult> {
    const startTime = Date.now();
    console.log('🚀 Starting MCP Test Suite...');
    console.log(`Testing ${this.config.implementations.length} implementations`);
    console.log(`Running ${this.getTotalTestCount()} test cases`);

    // Ensure output directory exists
    await this.ensureOutputDir();

    // Clear previous results
    this.results = [];

    try {
      // Run tests for each implementation
      await this.runImplementationsInParallel();

      // Generate final results
      const suiteResult = this.generateSuiteResult(startTime);
      
      // Save results
      await this.saveResults(suiteResult);

      // Emit completion event
      this.emit('suite-complete', suiteResult);

      // Print summary
      this.printSummary(suiteResult);

      return suiteResult;

    } finally {
      // Cleanup
      await this.cleanup();
    }
  }

  /**
   * Run tests for implementations in parallel
   */
  private async runImplementationsInParallel(): Promise<void> {
    const { maxConcurrentImplementations } = this.config.parallel;
    const enabledImpls = this.config.implementations.filter(impl => impl.enabled);
    
    // Process implementations in batches
    for (let i = 0; i < enabledImpls.length; i += maxConcurrentImplementations) {
      const batch = enabledImpls.slice(i, i + maxConcurrentImplementations);
      
      await Promise.all(
        batch.map(impl => this.runImplementationTests(impl))
      );
    }
  }

  /**
   * Run tests for a single implementation
   */
  private async runImplementationTests(implementation: MCPImplementation): Promise<TestResult[]> {
    console.log(`\n📋 Testing implementation: ${implementation.name}`);
    this.emit('implementation-start', implementation.id);

    const implResults: TestResult[] = [];

    try {
      // Start the server
      const server = await this.serverManager.startServer(implementation);
      
      // Wait for server to be ready
      await this.waitForServer(implementation.id);

      // Filter tool specs based on implementation capabilities
      const relevantSpecs = this.getRelevantSpecs(implementation);
      console.log(`  📦 Testing ${relevantSpecs.length} tools`);

      // Run tool tests in parallel batches
      await this.runToolTestsInParallel(implementation, relevantSpecs, implResults);

    } catch (error) {
      console.error(`❌ Failed to test implementation ${implementation.name}:`, error);
      
      // Add error result
      implResults.push({
        implementation: implementation.id,
        category: 'system',
        toolName: 'initialization',
        testCase: 'server_start',
        success: false,
        error: (error as Error).message,
        duration: 0
      });
    }

    this.results.push(...implResults);
    this.emit('implementation-complete', implementation.id, implResults);

    return implResults;
  }

  /**
   * Run tool tests in parallel batches
   */
  private async runToolTestsInParallel(
    implementation: MCPImplementation,
    toolSpecs: ToolTestSpec[],
    results: TestResult[]
  ): Promise<void> {
    const { maxConcurrentTestsPerImpl } = this.config.parallel;
    
    // Flatten all test cases
    const allTestCases: Array<{
      spec: ToolTestSpec;
      testCase: ToolTestCase;
    }> = [];

    for (const spec of toolSpecs) {
      for (const testCase of spec.testCases) {
        // Skip tests not meant for this implementation
        if (testCase.skipFor?.includes(implementation.id)) {
          continue;
        }
        
        // Only run if specified for this implementation
        if (testCase.onlyFor && !testCase.onlyFor.includes(implementation.id)) {
          continue;
        }

        allTestCases.push({ spec, testCase });
      }
    }

    // Process test cases in parallel batches
    for (let i = 0; i < allTestCases.length; i += maxConcurrentTestsPerImpl) {
      const batch = allTestCases.slice(i, i + maxConcurrentTestsPerImpl);
      
      const batchResults = await Promise.all(
        batch.map(({ spec, testCase }) => 
          this.runSingleTest(implementation, spec, testCase)
        )
      );

      results.push(...batchResults);
      
      // Emit progress
      this.emit('progress', i + batch.length, allTestCases.length);
    }
  }

  /**
   * Run a single test case
   */
  private async runSingleTest(
    implementation: MCPImplementation,
    spec: ToolTestSpec,
    testCase: ToolTestCase
  ): Promise<TestResult> {
    const startTime = Date.now();
    
    this.emit('test-start', implementation.id, spec.name, testCase.name);
    
    if (this.config.output.verbose) {
      console.log(`    🧪 ${spec.name}: ${testCase.name}`);
    }

    let result: TestResult;

    try {
      // Run setup if needed
      if (testCase.setup) {
        await testCase.setup();
      }
      if (spec.setupFn && spec.requiresSetup) {
        // Call global setup function if defined
        await this.callSetupFunction(spec.setupFn);
      }

      // Call the tool
      const response = await this.serverManager.callTool(
        implementation.id,
        spec.name,
        testCase.input
      );

      // Validate the response
      const validationResult = this.validateResponse(response, testCase);

      result = {
        implementation: implementation.id,
        category: spec.category,
        toolName: spec.name,
        testCase: testCase.name,
        success: validationResult.success,
        error: validationResult.error,
        duration: Date.now() - startTime,
        response: this.config.output.verbose ? response : undefined
      };

    } catch (error) {
      result = {
        implementation: implementation.id,
        category: spec.category,
        toolName: spec.name,
        testCase: testCase.name,
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime
      };
    } finally {
      // Run cleanup
      try {
        if (testCase.cleanup) {
          await testCase.cleanup();
        }
        if (spec.cleanupFn && spec.requiresSetup) {
          await this.callCleanupFunction(spec.cleanupFn);
        }
      } catch (cleanupError) {
        console.warn(`⚠️  Cleanup failed for ${spec.name}:${testCase.name}`, cleanupError);
      }
    }

    this.emit('test-complete', result);
    return result;
  }

  /**
   * Validate tool response against expectations
   */
  private validateResponse(response: any, testCase: ToolTestCase): { success: boolean; error?: string } {
    const { expect } = testCase;

    try {
      // Check if we expected success/failure
      const isError = response.error || response.isError;
      
      if (expect.success && isError) {
        return {
          success: false,
          error: `Expected success but got error: ${response.error?.message || 'Unknown error'}`
        };
      }

      if (!expect.success && !isError) {
        return {
          success: false,
          error: 'Expected failure but got success'
        };
      }

      // If we expected an error, check the pattern
      if (!expect.success && expect.errorPattern && isError) {
        const errorMsg = response.error?.message || response.content?.[0]?.text || '';
        const pattern = new RegExp(expect.errorPattern, 'i');
        
        if (!pattern.test(errorMsg)) {
          return {
            success: false,
            error: `Error message "${errorMsg}" doesn't match pattern "${expect.errorPattern}"`
          };
        }
      }

      // Validate content if success expected
      if (expect.success && expect.content && response.result?.content) {
        for (let i = 0; i < expect.content.length; i++) {
          const expectedContent = expect.content[i];
          const actualContent = response.result.content[i];

          if (!actualContent) {
            return {
              success: false,
              error: `Missing expected content at index ${i}`
            };
          }

          const contentValidation = this.validateContent(actualContent, expectedContent);
          if (!contentValidation.success) {
            return contentValidation;
          }
        }
      }

      // Custom validation
      if (expect.customValidation) {
        const customResult = expect.customValidation(response);
        if (customResult !== true) {
          return {
            success: false,
            error: typeof customResult === 'string' ? customResult : 'Custom validation failed'
          };
        }
      }

      return { success: true };

    } catch (error) {
      return {
        success: false,
        error: `Validation error: ${(error as Error).message}`
      };
    }
  }

  /**
   * Validate individual content item
   */
  private validateContent(actual: any, expected: any): { success: boolean; error?: string } {
    if (expected.type && actual.type !== expected.type) {
      return {
        success: false,
        error: `Expected content type "${expected.type}" but got "${actual.type}"`
      };
    }

    if (expected.textPattern && actual.type === 'text') {
      const pattern = new RegExp(expected.textPattern, 'i');
      if (!pattern.test(actual.text)) {
        return {
          success: false,
          error: `Text content "${actual.text}" doesn't match pattern "${expected.textPattern}"`
        };
      }
    }

    if (expected.minLength !== undefined && actual.text && actual.text.length < expected.minLength) {
      return {
        success: false,
        error: `Content length ${actual.text.length} is less than minimum ${expected.minLength}`
      };
    }

    if (expected.maxLength !== undefined && actual.text && actual.text.length > expected.maxLength) {
      return {
        success: false,
        error: `Content length ${actual.text.length} exceeds maximum ${expected.maxLength}`
      };
    }

    if (expected.mimeType && actual.mimeType !== expected.mimeType) {
      return {
        success: false,
        error: `Expected MIME type "${expected.mimeType}" but got "${actual.mimeType}"`
      };
    }

    return { success: true };
  }

  /**
   * Helper methods
   */
  private getTotalTestCount(): number {
    return this.config.implementations
      .filter(impl => impl.enabled)
      .reduce((total, impl) => {
        const relevantSpecs = this.getRelevantSpecs(impl);
        return total + relevantSpecs.reduce((specTotal, spec) => 
          specTotal + spec.testCases.length, 0);
      }, 0);
  }

  private getRelevantSpecs(implementation: MCPImplementation): ToolTestSpec[] {
    return this.config.toolSpecs.filter(spec => 
      implementation.expectedCategories.includes(spec.category)
    );
  }

  private async waitForServer(implementationId: string): Promise<void> {
    const maxWait = 30000; // 30 seconds
    const checkInterval = 100; // 100ms
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (this.serverManager.isServerRunning(implementationId)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error(`Server ${implementationId} failed to start within timeout`);
  }

  private generateSuiteResult(startTime: number): TestSuiteResult {
    const implementations = this.config.implementations.map(impl => impl.id);
    const totalTests = this.results.length;
    const passedTests = this.results.filter(r => r.success).length;
    const failedTests = this.results.filter(r => !r.success).length;

    // Generate per-implementation summary
    const summary: TestSuiteResult['summary'] = {};
    
    for (const implId of implementations) {
      const implResults = this.results.filter(r => r.implementation === implId);
      const implPassed = implResults.filter(r => r.success).length;
      const implFailed = implResults.filter(r => !r.success).length;

      // Group by categories
      const categories: any = {};
      const implCategories = [...new Set(implResults.map(r => r.category))];
      
      for (const category of implCategories) {
        const catResults = implResults.filter(r => r.category === category);
        categories[category] = {
          total: catResults.length,
          passed: catResults.filter(r => r.success).length,
          failed: catResults.filter(r => !r.success).length
        };
      }

      summary[implId] = {
        total: implResults.length,
        passed: implPassed,
        failed: implFailed,
        skipped: 0, // TODO: implement skipped tracking
        categories
      };
    }

    return {
      implementations,
      timestamp: new Date().toISOString(),
      totalTests,
      passedTests,
      failedTests,
      skippedTests: 0,
      results: this.results,
      summary
    };
  }

  private async ensureOutputDir(): Promise<void> {
    await fs.mkdir(this.config.output.resultsDir, { recursive: true });
  }

  private async saveResults(suiteResult: TestSuiteResult): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Save JSON report
    if (this.config.output.generateJsonReport) {
      const jsonPath = path.join(this.config.output.resultsDir, `results-${timestamp}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(suiteResult, null, 2));
      console.log(`📄 JSON report saved: ${jsonPath}`);
    }

    // Save HTML report
    if (this.config.output.generateHtmlReport) {
      const htmlPath = path.join(this.config.output.resultsDir, `report-${timestamp}.html`);
      const html = this.generateHtmlReport(suiteResult);
      await fs.writeFile(htmlPath, html);
      console.log(`📊 HTML report saved: ${htmlPath}`);
    }

    // Save latest results (for CI)
    const latestJsonPath = path.join(this.config.output.resultsDir, 'latest-results.json');
    await fs.writeFile(latestJsonPath, JSON.stringify(suiteResult, null, 2));
  }

  private generateHtmlReport(suiteResult: TestSuiteResult): string {
    // Simple HTML report template
    return `
<!DOCTYPE html>
<html>
<head>
    <title>MCP Test Suite Results</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .summary { background: #f5f5f5; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        .success { color: green; }
        .failure { color: red; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <h1>MCP Test Suite Results</h1>
    <div class="summary">
        <h2>Summary</h2>
        <p><strong>Total Tests:</strong> ${suiteResult.totalTests}</p>
        <p><strong>Passed:</strong> <span class="success">${suiteResult.passedTests}</span></p>
        <p><strong>Failed:</strong> <span class="failure">${suiteResult.failedTests}</span></p>
        <p><strong>Success Rate:</strong> ${((suiteResult.passedTests / suiteResult.totalTests) * 100).toFixed(1)}%</p>
        <p><strong>Timestamp:</strong> ${suiteResult.timestamp}</p>
    </div>
    
    <h2>Results by Implementation</h2>
    ${Object.entries(suiteResult.summary).map(([impl, stats]) => `
        <h3>${impl}</h3>
        <p>Passed: ${stats.passed}/${stats.total} (${((stats.passed / stats.total) * 100).toFixed(1)}%)</p>
    `).join('')}
    
    <h2>Detailed Results</h2>
    <table>
        <tr>
            <th>Implementation</th>
            <th>Category</th>
            <th>Tool</th>
            <th>Test Case</th>
            <th>Result</th>
            <th>Duration (ms)</th>
            <th>Error</th>
        </tr>
        ${suiteResult.results.map(result => `
            <tr>
                <td>${result.implementation}</td>
                <td>${result.category}</td>
                <td>${result.toolName}</td>
                <td>${result.testCase}</td>
                <td class="${result.success ? 'success' : 'failure'}">
                    ${result.success ? '✅ PASS' : '❌ FAIL'}
                </td>
                <td>${result.duration}</td>
                <td>${result.error || ''}</td>
            </tr>
        `).join('')}
    </table>
</body>
</html>`;
  }

  private printSummary(suiteResult: TestSuiteResult): void {
    console.log('\n📊 Test Suite Complete!');
    console.log('='.repeat(50));
    console.log(`Total Tests: ${suiteResult.totalTests}`);
    console.log(`✅ Passed: ${suiteResult.passedTests}`);
    console.log(`❌ Failed: ${suiteResult.failedTests}`);
    console.log(`Success Rate: ${((suiteResult.passedTests / suiteResult.totalTests) * 100).toFixed(1)}%`);
    
    console.log('\nBy Implementation:');
    for (const [impl, stats] of Object.entries(suiteResult.summary)) {
      const rate = ((stats.passed / stats.total) * 100).toFixed(1);
      console.log(`  ${impl}: ${stats.passed}/${stats.total} (${rate}%)`);
    }
  }

  private async callSetupFunction(functionName: string): Promise<void> {
    // Placeholder for calling global setup functions
    // Could be implemented to load and call setup functions from a registry
  }

  private async callCleanupFunction(functionName: string): Promise<void> {
    // Placeholder for calling global cleanup functions
  }

  private async cleanup(): Promise<void> {
    try {
      await this.serverManager.stopAllServers();
      console.log('🧹 Cleanup complete');
    } catch (error) {
      console.warn('⚠️  Cleanup warning:', error);
    }
  }
}

/**
 * Convenience function to run the test suite
 */
export async function runMCPTestSuite(config?: Partial<TestRunnerConfig>): Promise<TestSuiteResult> {
  const runner = new MCPTestRunner(config);
  return await runner.runSuite();
}