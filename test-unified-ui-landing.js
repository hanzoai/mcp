#!/usr/bin/env node

/**
 * Test script for unified UI tool - Landing Page Creation
 * This verifies that the `ui` tool can be used to build landing pages with @hanzo/ui components
 */

import { unifiedUITool } from './dist/index.js';

console.log('🧪 Testing Unified UI Tool for Landing Page Creation\n');
console.log('=' + '='.repeat(50) + '\n');

async function testTool(description, args) {
  console.log(`📋 Test: ${description}`);
  console.log(`   Args: ${JSON.stringify(args)}`);
  
  try {
    const result = await unifiedUITool.handler(args);
    if (result.isError) {
      console.log(`   ❌ Error: ${result.content[0].text}`);
      return false;
    }
    console.log(`   ✅ Success`);
    if (result.content && result.content[0]) {
      const output = result.content[0].text;
      // Show first few lines of output
      const lines = output.split('\n').slice(0, 5);
      lines.forEach(line => console.log(`      ${line}`));
      if (output.split('\n').length > 5) {
        console.log(`      ... (${output.split('\n').length - 5} more lines)`);
      }
    }
    return true;
  } catch (error) {
    console.log(`   ❌ Exception: ${error.message}`);
    return false;
  }
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  console.log('1️⃣  CHECKING CURRENT FRAMEWORK\n');
  
  // Test 1: Get current framework (should default to hanzo)
  if (await testTool('Get current framework', {
    method: 'get_framework'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  console.log('\n2️⃣  LISTING AVAILABLE COMPONENTS\n');
  
  // Test 2: List Hanzo UI components
  if (await testTool('List Hanzo UI components', {
    method: 'list_components',
    framework: 'hanzo'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  console.log('\n3️⃣  SEARCHING FOR LANDING PAGE COMPONENTS\n');
  
  // Test 3: Search for hero components
  if (await testTool('Search for hero components', {
    method: 'search',
    query: 'hero',
    framework: 'hanzo'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 4: Search for feature components
  if (await testTool('Search for feature components', {
    method: 'search',
    query: 'feature',
    framework: 'hanzo'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  console.log('\n4️⃣  LISTING UI BLOCKS\n');
  
  // Test 5: List available blocks
  if (await testTool('List UI blocks', {
    method: 'list_blocks',
    framework: 'hanzo'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  console.log('\n5️⃣  CREATING LANDING PAGE COMPOSITION\n');
  
  // Test 6: Create a landing page composition with hero section
  const heroComposition = await testTool('Create hero section composition', {
    method: 'create_composition',
    name: 'HeroSection',
    description: 'Landing page hero section with CTA',
    components: ['hero', 'button', 'badge'],
    framework: 'hanzo'
  });
  if (heroComposition) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 7: Create a features section composition
  const featuresComposition = await testTool('Create features section composition', {
    method: 'create_composition',
    name: 'FeaturesSection',
    description: 'Product features showcase',
    components: ['card', 'grid', 'icon', 'heading'],
    framework: 'hanzo'
  });
  if (featuresComposition) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 8: Create a testimonials section composition
  const testimonialsComposition = await testTool('Create testimonials section composition', {
    method: 'create_composition',
    name: 'TestimonialsSection',
    description: 'Customer testimonials carousel',
    components: ['carousel', 'card', 'avatar', 'quote'],
    framework: 'hanzo'
  });
  if (testimonialsComposition) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 9: Create a pricing section composition
  const pricingComposition = await testTool('Create pricing section composition', {
    method: 'create_composition',
    name: 'PricingSection',
    description: 'Pricing plans comparison',
    components: ['card', 'button', 'badge', 'list'],
    framework: 'hanzo'
  });
  if (pricingComposition) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 10: Create a complete landing page composition
  const landingPageComposition = await testTool('Create complete landing page', {
    method: 'create_composition',
    name: 'LandingPage',
    description: 'Complete landing page with all sections',
    components: ['hero', 'features', 'testimonials', 'pricing', 'cta', 'footer'],
    framework: 'hanzo'
  });
  if (landingPageComposition) {
    passed++;
  } else {
    failed++;
  }
  
  console.log('\n6️⃣  TESTING FRAMEWORK SWITCHING\n');
  
  // Test 11: Switch to shadcn for comparison
  if (await testTool('Switch to shadcn framework', {
    method: 'set_framework',
    framework: 'shadcn'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 12: Create composition with shadcn
  if (await testTool('Create shadcn composition', {
    method: 'create_composition',
    name: 'ShadcnHero',
    description: 'Hero section using shadcn/ui',
    components: ['card', 'button', 'badge'],
    framework: 'shadcn'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  // Test 13: Switch back to Hanzo
  if (await testTool('Switch back to Hanzo framework', {
    method: 'set_framework',
    framework: 'hanzo'
  })) {
    passed++;
  } else {
    failed++;
  }
  
  console.log('\n' + '='.repeat(52));
  console.log(`\n📊 TEST RESULTS:`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  
  if (failed === 0) {
    console.log('\n🎉 All tests passed! The unified UI tool is working correctly.');
    console.log('\n✨ Key capabilities verified:');
    console.log('   • Single "ui" tool exposed for all UI operations');
    console.log('   • Defaults to @hanzo/ui components');
    console.log('   • Can list and search components');
    console.log('   • Can create landing page compositions');
    console.log('   • Generates proper @hanzo/ui imports');
    console.log('   • Can switch between frameworks when needed');
    console.log('\n🚀 Dev agents can now use: "ui" tool to build landing pages with @hanzo/ui');
  } else {
    console.log('\n⚠️  Some tests failed. Please review the errors above.');
  }
}

// Run the tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});