#!/usr/bin/env node

/**
 * MATRIX TEST SUITE FOR UNIFIED UI TOOL
 * Testing all methods with parallel execution
 */

import { createMCPServer } from './dist/index.js';

const testMethods = [
  { method: 'list_components', args: {} },
  { method: 'get_component', args: { name: 'button' } },
  { method: 'get_source', args: { name: 'button' } },
  { method: 'get_demo', args: { name: 'button' } },
  { method: 'add_component', args: { name: 'button', framework: 'react' } },
  { method: 'list_blocks', args: {} },
  { method: 'list_styles', args: {} },
  { method: 'search', args: { query: 'modal' } },
  { method: 'installation_guide', args: { framework: 'nextjs' } },
  { method: 'compare_frameworks', args: {} },
  { method: 'convert_framework', args: { component: 'button', from: 'react', to: 'vue' } }
];

async function testUITool() {
  console.log('🔴💊 ENTERING THE MATRIX - UI TOOL TEST SUITE\n');
  
  try {
    // Create server with default configuration (unifiedUITool is in allTools by default)
    const server = await createMCPServer({
      name: 'test-hanzo-mcp',
      version: '1.0.0'
    });
    
    console.log(`✅ Server created with ${server.tools.length} tools\n`);
    
    // List all tool names to find the UI tool
    console.log('Available tools:');
    server.tools.forEach(t => {
      if (t.name.includes('ui') || t.name.includes('UI')) {
        console.log(`  - ${t.name} (UI-related)`);
      }
    });
    
    // Find the UI tool - it might be named differently
    const uiTool = server.tools.find(t => t.name === 'ui' || t.name === 'unified_ui' || t.name === 'ui_unified');
    
    if (!uiTool) {
      console.error('\n❌ UI tool not found! Available UI-related tools:');
      server.tools.filter(t => t.name.toLowerCase().includes('ui')).forEach(t => {
        console.error(`  - ${t.name}: ${t.description?.substring(0, 50)}...`);
      });
      process.exit(1);
    }
    
    console.log(`\n✅ UI tool found: ${uiTool.name}\n`);
    console.log('⚡ Executing all methods in parallel...\n');
    
    // Execute all test methods in parallel
    const startTime = Date.now();
    const results = await Promise.allSettled(
      testMethods.map(async (test, index) => {
        const start = Date.now();
        try {
          const result = await uiTool.handler({ method: test.method, ...test.args });
          const duration = Date.now() - start;
          return {
            index,
            method: test.method,
            success: !result.isError,
            duration,
            outputLength: result.content?.[0]?.text?.length || 0
          };
        } catch (error) {
          return {
            index,
            method: test.method,
            success: false,
            duration: Date.now() - start,
            error: error.message
          };
        }
      })
    );
    
    const totalDuration = Date.now() - startTime;
    
    // Display results
    console.log('🌀 TEST RESULTS:\n');
    console.log('=' .repeat(60));
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const r = result.value;
        const status = r.success ? '✅' : '❌';
        console.log(`${status} [${r.index + 1}/${testMethods.length}] ${r.method}`);
        console.log(`   Duration: ${r.duration}ms`);
        if (r.outputLength) {
          console.log(`   Output: ${r.outputLength} chars`);
        }
        if (r.error) {
          console.log(`   Error: ${r.error}`);
        }
      } else {
        console.log(`❌ [${index + 1}/${testMethods.length}] Failed: ${result.reason}`);
      }
    });
    
    console.log('=' .repeat(60));
    
    // Statistics
    const successCount = results.filter(r => 
      r.status === 'fulfilled' && r.value.success
    ).length;
    
    console.log('\n📊 STATISTICS:');
    console.log(`Total methods tested: ${testMethods.length}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${testMethods.length - successCount}`);
    console.log(`Total execution time: ${totalDuration}ms`);
    console.log(`Average per method: ${Math.round(totalDuration / testMethods.length)}ms`);
    
    // Test framework switching
    console.log('\n🔄 TESTING FRAMEWORK SWITCHING:');
    const frameworks = ['hanzo', 'hanzo-native', 'hanzo-vue', 'hanzo-svelte'];
    
    for (const fw of frameworks) {
      try {
        const result = await uiTool.handler({
          method: 'add_component',
          name: 'button',
          framework: fw === 'hanzo' ? 'react' : fw.replace('hanzo-', '')
        });
        console.log(`✅ Framework ${fw}: ${result.isError ? 'FAILED' : 'SUCCESS'}`);
      } catch (error) {
        console.log(`❌ Framework ${fw}: ERROR - ${error.message}`);
      }
    }
    
    console.log('\n💊 THE MATRIX HAS BEEN TESTED - NEO OUT');
    
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Execute the test
testUITool();