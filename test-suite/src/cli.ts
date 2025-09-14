#!/usr/bin/env node

/**
 * MCP Test Suite CLI
 * Command-line interface for running MCP implementation tests
 */

import { Command } from 'commander';
import { runMCPTestSuite } from './test-runner.js';
import { getSpecStats, getCategories } from '../specs/index.js';
import { getImplementations, getEnabledImplementations } from '../configs/implementations.js';
import { TestRunnerConfig } from './types.js';

const program = new Command();

program
  .name('mcp-test-suite')
  .description('Language-agnostic MCP implementation test suite')
  .version('1.0.0');

// Main test command
program
  .command('test')
  .description('Run the MCP test suite')
  .option('-i, --implementations <implementations...>', 'specific implementations to test')
  .option('-c, --categories <categories...>', 'tool categories to test')
  .option('-t, --tools <tools...>', 'specific tools to test')
  .option('--timeout <ms>', 'test timeout in milliseconds', '30000')
  .option('--parallel-impls <count>', 'max concurrent implementations', '2')
  .option('--parallel-tests <count>', 'max concurrent tests per implementation', '3')
  .option('--output-dir <dir>', 'output directory for results', './test-results')
  .option('--no-html', 'disable HTML report generation')
  .option('--no-json', 'disable JSON report generation')
  .option('-v, --verbose', 'verbose output')
  .option('--quick', 'run only core tools')
  .action(async (options) => {
    try {
      console.log('🧪 MCP Test Suite v1.0.0');
      
      // Build configuration from options
      const config: Partial<TestRunnerConfig> = {
        testTimeout: parseInt(options.timeout),
        parallel: {
          maxConcurrentImplementations: parseInt(options.parallelImpls || '2'),
          maxConcurrentTestsPerImpl: parseInt(options.parallelTests || '3')
        },
        output: {
          resultsDir: options.outputDir,
          verbose: options.verbose || false,
          generateHtmlReport: options.html !== false,
          generateJsonReport: options.json !== false
        }
      };

      // Filter implementations
      if (options.implementations) {
        const requestedImpls = options.implementations;
        const allImpls = getImplementations();
        config.implementations = allImpls.filter(impl => 
          requestedImpls.includes(impl.id) && impl.enabled
        );
        
        if (config.implementations.length === 0) {
          console.error('❌ No matching enabled implementations found');
          console.log('Available implementations:');
          allImpls.forEach(impl => {
            console.log(`  - ${impl.id} (${impl.enabled ? 'enabled' : 'disabled'})`);
          });
          process.exit(1);
        }
      }

      // Filter by categories
      if (options.categories || options.quick) {
        const categories = options.quick ? ['files', 'search', 'shell'] : options.categories;
        const { allToolSpecs } = await import('../specs/index.js');
        config.toolSpecs = allToolSpecs.filter(spec => 
          categories.includes(spec.category)
        );
        
        console.log(`📦 Testing ${config.toolSpecs.length} tools in categories: ${categories.join(', ')}`);
      }

      // Filter by specific tools
      if (options.tools) {
        const { allToolSpecs } = await import('../specs/index.js');
        config.toolSpecs = allToolSpecs.filter(spec => 
          options.tools.includes(spec.name)
        );
        
        console.log(`🔧 Testing specific tools: ${options.tools.join(', ')}`);
      }

      // Run the test suite
      const results = await runMCPTestSuite(config);

      // Exit with appropriate code
      const exitCode = results.failedTests > 0 ? 1 : 0;
      process.exit(exitCode);

    } catch (error) {
      console.error('❌ Test suite failed:', error);
      process.exit(1);
    }
  });

// List available implementations
program
  .command('list-implementations')
  .alias('list-impls')
  .description('List available implementations')
  .option('--enabled-only', 'show only enabled implementations')
  .action((options) => {
    const implementations = options.enabledOnly 
      ? getEnabledImplementations() 
      : getImplementations();
    
    console.log('📋 Available MCP Implementations:\n');
    
    implementations.forEach(impl => {
      console.log(`${impl.enabled ? '✅' : '❌'} ${impl.id}`);
      console.log(`   Name: ${impl.name}`);
      console.log(`   Language: ${impl.language}`);
      console.log(`   Command: ${impl.command} ${impl.args.join(' ')}`);
      console.log(`   Categories: ${impl.expectedCategories.join(', ')}`);
      console.log(`   Expected Tools: ${impl.expectedToolCount || 'unknown'}`);
      console.log();
    });
  });

// List available tool categories and specs
program
  .command('list-tools')
  .description('List available tools and test specifications')
  .option('-c, --category <category>', 'filter by category')
  .option('--stats', 'show statistics only')
  .action(async (options) => {
    const { allToolSpecs, getToolSpecsByCategory } = await import('../specs/index.js');
    
    if (options.stats) {
      const stats = getSpecStats();
      console.log('📊 Test Specification Statistics:\n');
      console.log(`Total Tools: ${stats.totalSpecs}`);
      console.log(`Total Test Cases: ${stats.totalTestCases}`);
      console.log(`Tools with Setup: ${stats.toolsWithSetup}`);
      console.log('\nBy Category:');
      stats.categories.forEach(cat => {
        console.log(`  ${cat.category}: ${cat.specs} tools, ${cat.testCases} test cases`);
      });
      return;
    }

    const specs = options.category 
      ? getToolSpecsByCategory(options.category)
      : allToolSpecs;

    if (options.category) {
      console.log(`🔧 Tools in category "${options.category}":\n`);
    } else {
      console.log('🔧 All Available Tools:\n');
    }

    const categories = getCategories();
    
    for (const category of categories) {
      if (options.category && category !== options.category) continue;
      
      const categorySpecs = getToolSpecsByCategory(category);
      console.log(`📁 ${category.toUpperCase()}`);
      
      categorySpecs.forEach(spec => {
        console.log(`  ${spec.name} - ${spec.description}`);
        console.log(`    Test cases: ${spec.testCases.length}`);
        if (spec.requiresSetup) {
          console.log(`    Requires setup: ${spec.setupFn || 'yes'}`);
        }
      });
      console.log();
    }
  });

// Validate implementation
program
  .command('validate')
  .description('Validate a specific implementation without running full tests')
  .argument('<implementation>', 'implementation ID to validate')
  .action(async (implementationId) => {
    const { MCPServerManager } = await import('./server-manager.js');
    const { getImplementation } = await import('../configs/implementations.js');
    
    const implementation = getImplementation(implementationId);
    
    if (!implementation) {
      console.error(`❌ Implementation "${implementationId}" not found`);
      process.exit(1);
    }

    if (!implementation.enabled) {
      console.error(`❌ Implementation "${implementationId}" is disabled`);
      process.exit(1);
    }

    console.log(`🔍 Validating implementation: ${implementation.name}`);

    const manager = new MCPServerManager();
    
    try {
      // Start server
      console.log('  📡 Starting server...');
      const server = await manager.startServer(implementation);
      
      // Wait for ready
      console.log('  ⏳ Waiting for server to be ready...');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
        const check = () => {
          if (manager.isServerRunning(implementationId)) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });

      // List tools
      console.log('  📋 Retrieving tool list...');
      const tools = await manager.listTools(implementationId);
      
      console.log(`  ✅ Server is responding with ${tools.length} tools`);
      console.log('\n  Available tools:');
      tools.forEach(tool => {
        console.log(`    - ${tool.name}: ${tool.description}`);
      });

      // Test a simple tool
      console.log('\n  🧪 Testing basic functionality...');
      try {
        const testResult = await manager.callTool(implementationId, 'bash', { command: 'echo "test"' });
        console.log('  ✅ Basic tool call successful');
      } catch (error) {
        console.log('  ⚠️  Basic tool call failed, but server is responsive');
      }

      console.log('\n✅ Implementation validation successful');
      
    } catch (error) {
      console.error('❌ Validation failed:', error);
      process.exit(1);
    } finally {
      await manager.stopAllServers();
    }
  });

// Development utilities
program
  .command('dev')
  .description('Development utilities')
  .command('generate-config')
  .description('Generate configuration template for new implementation')
  .argument('<id>', 'implementation ID')
  .argument('<language>', 'programming language')
  .action((id, language) => {
    const template = {
      id,
      name: `${id.charAt(0).toUpperCase() + id.slice(1)} MCP Implementation`,
      language,
      command: language === 'rust' ? 'cargo' : language === 'python' ? 'python' : language,
      args: ['run', '--', 'serve'],
      cwd: `../mcp-${id}`,
      env: {},
      startupTimeout: 15000,
      enabled: false,
      expectedCategories: ['files', 'search', 'shell'],
      expectedToolCount: 10
    };
    
    console.log('📝 Configuration template:');
    console.log(JSON.stringify(template, null, 2));
    console.log('\nAdd this to implementations.ts and adjust as needed.');
  });

// Error handling
program.configureOutput({
  writeErr: (str) => process.stderr.write(str)
});

program.parse();

// Handle unhandled errors
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Test suite interrupted');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Test suite terminated');
  process.exit(1);
});