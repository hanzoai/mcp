#!/usr/bin/env node

/**
 * MATRIX TEST SUITE FOR INDIVIDUAL UI TOOLS
 * Testing all UI tools with maximum parallel execution
 */

import { createMCPServer } from './dist/index.js';

const uiToolTests = [
  { name: 'ui_list_components', args: {} },
  { name: 'ui_search_components', args: { query: 'button' } },
  { name: 'ui_get_component', args: { name: 'button' } },
  { name: 'ui_list_blocks', args: {} },
  { name: 'ui_get_block', args: { name: 'sidebar-01' } },
  { name: 'ui_get_registry', args: {} },
  { name: 'ui_fetch_component', args: { name: 'button', framework: 'react' } },
  { name: 'ui_fetch_demo', args: { name: 'button' } },
  { name: 'ui_component_metadata', args: { name: 'button' } },
  { name: 'ui_github_rate_limit', args: {} }
];

async function testIndividualUITools() {
  console.log('🔴💊 ENTERING THE MATRIX - INDIVIDUAL UI TOOLS TEST\n');
  console.log('⚡ Testing parallel execution of all UI tools...\n');
  
  try {
    // Create server with default configuration
    const server = await createMCPServer({
      name: 'test-hanzo-mcp',
      version: '1.0.0'
    });
    
    console.log(`✅ Server created with ${server.tools.length} tools\n`);
    
    // Get all UI tools
    const uiTools = server.tools.filter(t => t.name.startsWith('ui_'));
    console.log(`🎯 Found ${uiTools.length} UI tools\n`);
    
    // Execute all UI tool tests in parallel
    const startTime = Date.now();
    const results = await Promise.allSettled(
      uiToolTests.map(async (test, index) => {
        const tool = server.tools.find(t => t.name === test.name);
        if (!tool) {
          return {
            index,
            name: test.name,
            success: false,
            error: 'Tool not found',
            duration: 0
          };
        }
        
        const start = Date.now();
        try {
          const result = await tool.handler(test.args);
          const duration = Date.now() - start;
          return {
            index,
            name: test.name,
            success: !result.isError,
            duration,
            outputLength: result.content?.[0]?.text?.length || 0
          };
        } catch (error) {
          return {
            index,
            name: test.name,
            success: false,
            duration: Date.now() - start,
            error: error.message
          };
        }
      })
    );
    
    const totalDuration = Date.now() - startTime;
    
    // Display results matrix style
    console.log('🌀 TEST RESULTS MATRIX:\n');
    console.log('=' .repeat(70));
    console.log('Tool Name                        | Status | Time(ms) | Output');
    console.log('-' .repeat(70));
    
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        const r = result.value;
        const status = r.success ? '✅' : '❌';
        const name = r.name.padEnd(32);
        const time = String(r.duration).padEnd(8);
        const output = r.outputLength ? `${r.outputLength} chars` : r.error || 'No output';
        console.log(`${name} | ${status}     | ${time} | ${output}`);
      }
    });
    
    console.log('=' .repeat(70));
    
    // Statistics
    const successCount = results.filter(r => 
      r.status === 'fulfilled' && r.value.success
    ).length;
    
    console.log('\n📊 PERFORMANCE METRICS:');
    console.log(`├─ Total tools tested: ${uiToolTests.length}`);
    console.log(`├─ Successful: ${successCount} (${Math.round(successCount * 100 / uiToolTests.length)}%)`);
    console.log(`├─ Failed: ${uiToolTests.length - successCount}`);
    console.log(`├─ Total execution time: ${totalDuration}ms`);
    console.log(`└─ Average per tool: ${Math.round(totalDuration / uiToolTests.length)}ms`);
    
    // Test framework-specific tools
    console.log('\n🔄 FRAMEWORK SWITCHING TESTS:');
    const frameworks = ['react', 'vue', 'svelte', 'native'];
    
    const frameworkResults = await Promise.allSettled(
      frameworks.map(async fw => {
        const tool = server.tools.find(t => t.name === 'ui_fetch_component');
        if (!tool) return { framework: fw, success: false, error: 'Tool not found' };
        
        try {
          const result = await tool.handler({ name: 'button', framework: fw });
          return { framework: fw, success: !result.isError };
        } catch (error) {
          return { framework: fw, success: false, error: error.message };
        }
      })
    );
    
    frameworkResults.forEach(r => {
      if (r.status === 'fulfilled') {
        const result = r.value;
        const status = result.success ? '✅' : '❌';
        console.log(`${status} Framework: ${result.framework}`);
      }
    });
    
    console.log('\n💊 MATRIX TEST COMPLETE - REALITY VALIDATED');
    
  } catch (error) {
    console.error('❌ Fatal matrix error:', error);
    process.exit(1);
  }
}

// Execute the test
testIndividualUITools();