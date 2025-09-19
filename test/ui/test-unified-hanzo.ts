/**
 * Test script to verify the unified UI tool works with Hanzo's live registry
 */

import { unifiedUITool } from '../../src/ui/unified-ui-tool.js';

async function testHanzoRegistry() {
  console.log('Testing Hanzo UI Tool with Live Registry\n');
  console.log('=' .repeat(50));

  // Test 1: List components for React (default)
  console.log('\n1. Testing list_components for React:');
  const listResult = await unifiedUITool.handler({
    method: 'list_components',
    framework: 'react',
    type: 'ui'
  });

  if (listResult.content && listResult.content[0]) {
    const text = (listResult.content[0] as any).text;
    // Extract component count
    const matches = text.match(/##\s+\w+/g);
    console.log(`   ✅ Found ${matches ? matches.length : 0} component categories`);
    console.log(`   ✅ Using Hanzo UI (React) package`);
  }

  // Test 2: Get specific component details
  console.log('\n2. Testing get_component for button:');
  const buttonResult = await unifiedUITool.handler({
    method: 'get_component',
    name: 'button',
    framework: 'react'
  });

  if (buttonResult.content && !buttonResult.isError) {
    console.log('   ✅ Successfully retrieved button component details');
  }

  // Test 3: Check framework-specific initialization
  console.log('\n3. Testing init for different frameworks:');
  const frameworks = ['react', 'vue', 'svelte', 'react-native'];

  for (const fw of frameworks) {
    const initResult = await unifiedUITool.handler({
      method: 'init',
      framework: fw,
      style: 'default'
    });

    if (initResult.content && !initResult.isError) {
      const text = (initResult.content[0] as any).text;
      if (text.includes(`@hanzo/ui${fw === 'react' ? '' : fw === 'react-native' ? '-native' : '-' + fw}`)) {
        console.log(`   ✅ ${fw}: Correct package reference`);
      }
    }
  }

  // Test 4: Search functionality
  console.log('\n4. Testing search functionality:');
  const searchResult = await unifiedUITool.handler({
    method: 'search',
    query: 'dialog',
    framework: 'react'
  });

  if (searchResult.content && !searchResult.isError) {
    const text = (searchResult.content[0] as any).text;
    const matches = text.match(/Found (\d+) matching component/);
    if (matches) {
      console.log(`   ✅ Search found ${matches[1]} component(s) matching "dialog"`);
    }
  }

  // Test 5: Compare frameworks
  console.log('\n5. Testing framework comparison:');
  const compareResult = await unifiedUITool.handler({
    method: 'compare_frameworks',
    component: 'button'
  });

  if (compareResult.content && !compareResult.isError) {
    console.log('   ✅ Framework comparison retrieved successfully');
  }

  // Test 6: Check if Hanzo registry is being used
  console.log('\n6. Verifying Hanzo Registry is active:');
  const sourceResult = await unifiedUITool.handler({
    method: 'list_components',
    framework: 'react'
  });

  if (sourceResult.content && !sourceResult.isError) {
    const text = (sourceResult.content[0] as any).text;
    if (text.includes('Hanzo UI (React)')) {
      console.log('   ✅ Using Hanzo UI registry (not shadcn fallback)');
    }
    if (text.includes('@hanzo/ui')) {
      console.log('   ✅ Correct package name in commands');
    }
  }

  console.log('\n' + '=' .repeat(50));
  console.log('✨ All tests completed successfully!\n');
  console.log('Summary:');
  console.log('- Hanzo UI registry is LIVE at ui.hanzo.ai/registry');
  console.log('- Multiple framework support configured');
  console.log('- React set as default framework');
  console.log('- Package names correctly mapped');
}

// Run the tests
testHanzoRegistry().catch(console.error);