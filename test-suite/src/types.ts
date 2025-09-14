/**
 * Types for MCP Test Suite - Language-agnostic MCP parity testing
 */

export interface MCPImplementation {
  /** Unique identifier for this implementation */
  id: string;
  /** Human readable name */
  name: string;
  /** Programming language */
  language: 'typescript' | 'rust' | 'python' | 'go' | 'other';
  /** Command to start the MCP server */
  command: string;
  /** Command arguments */
  args: string[];
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout for server startup (ms) */
  startupTimeout?: number;
  /** Whether this implementation should be tested */
  enabled: boolean;
  /** Expected tool categories this implementation supports */
  expectedCategories: string[];
  /** Expected number of tools */
  expectedToolCount?: number;
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

export interface ToolTestSpec {
  /** Tool name */
  name: string;
  /** Tool category */
  category: string;
  /** Description for test documentation */
  description: string;
  /** Test cases for this tool */
  testCases: ToolTestCase[];
  /** Whether this tool requires special setup */
  requiresSetup?: boolean;
  /** Setup function name if required */
  setupFn?: string;
  /** Cleanup function name if required */
  cleanupFn?: string;
}

export interface ToolTestCase {
  /** Test case name */
  name: string;
  /** Input arguments to send to the tool */
  input: Record<string, any>;
  /** Expected result validation */
  expect: ExpectSpec;
  /** Skip this test case for specific implementations */
  skipFor?: string[];
  /** Only run for specific implementations */
  onlyFor?: string[];
  /** Setup for this specific test case */
  setup?: () => Promise<void>;
  /** Cleanup for this specific test case */
  cleanup?: () => Promise<void>;
}

export interface ExpectSpec {
  /** Should the call succeed or fail */
  success: boolean;
  /** Expected error message pattern (if success=false) */
  errorPattern?: string;
  /** Content validation rules */
  content?: ContentExpectSpec[];
  /** Custom validation function */
  customValidation?: (result: any) => boolean | string;
}

export interface ContentExpectSpec {
  /** Expected content type */
  type: 'text' | 'image' | 'resource';
  /** Pattern to match in text content */
  textPattern?: string;
  /** Minimum content length */
  minLength?: number;
  /** Maximum content length */
  maxLength?: number;
  /** Expected MIME type for resources */
  mimeType?: string;
}

export interface TestResult {
  implementation: string;
  category: string;
  toolName: string;
  testCase: string;
  success: boolean;
  error?: string;
  duration: number;
  response?: any;
  metadata?: Record<string, any>;
}

export interface TestSuiteResult {
  implementations: string[];
  timestamp: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  results: TestResult[];
  summary: {
    [implementation: string]: {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      categories: {
        [category: string]: {
          total: number;
          passed: number;
          failed: number;
        }
      }
    }
  };
}

export interface MCPServerProcess {
  implementation: MCPImplementation;
  process: any; // Node.js ChildProcess
  ready: boolean;
  error?: string;
}

export interface TestRunnerConfig {
  /** Implementations to test */
  implementations: MCPImplementation[];
  /** Tool specs to test */
  toolSpecs: ToolTestSpec[];
  /** Global timeout for each test (ms) */
  testTimeout: number;
  /** Parallel execution settings */
  parallel: {
    /** Max concurrent implementations */
    maxConcurrentImplementations: number;
    /** Max concurrent tests per implementation */
    maxConcurrentTestsPerImpl: number;
  };
  /** Output settings */
  output: {
    /** Directory for test results */
    resultsDir: string;
    /** Enable verbose logging */
    verbose: boolean;
    /** Generate HTML report */
    generateHtmlReport: boolean;
    /** Generate JSON report */
    generateJsonReport: boolean;
  };
  /** Fixtures directory */
  fixturesDir: string;
}