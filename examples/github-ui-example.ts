#!/usr/bin/env node

/**
 * Example of using the GitHub UI API integration
 * This demonstrates fetching components from various UI frameworks
 */

import { GitHubAPIClient } from '../src/tools/ui-github-api.js';

async function main() {
  const client = new GitHubAPIClient();

  console.log('GitHub UI Component Fetcher Example\n');
  console.log('====================================\n');

  try {
    // Example 1: List components from Hanzo UI
    console.log('1. Listing Hanzo UI components...');
    const hanzoComponents = await client.listComponents('hanzo');
    console.log('   Available components:', hanzoComponents.slice(0, 5).join(', '), '...\n');

    // Example 2: Fetch a button component from React (shadcn/ui)
    console.log('2. Fetching button component from shadcn/ui...');
    try {
      const buttonCode = await client.fetchComponent('button', 'react');
      console.log('   Button component size:', buttonCode.length, 'characters');
      console.log('   First 200 chars:', buttonCode.substring(0, 200), '...\n');
    } catch (error: any) {
      console.log('   Error:', error.message, '\n');
    }

    // Example 3: List blocks from Hanzo UI
    console.log('3. Listing Hanzo UI blocks...');
    const hanzoBlocks = await client.listBlocks('hanzo');
    if (hanzoBlocks.length > 0) {
      console.log('   Available blocks:', hanzoBlocks.slice(0, 5).join(', '), '...\n');
    } else {
      console.log('   No blocks found or blocks path not configured\n');
    }

    // Example 4: Get component metadata
    console.log('4. Getting component metadata for card...');
    const metadata = await client.fetchComponentMetadata('card', 'hanzo');
    console.log('   Metadata:', JSON.stringify(metadata, null, 2), '\n');

    // Example 5: Check rate limit status
    console.log('5. GitHub API Rate Limit Status:');
    const rateLimit = client.getRateLimitInfo();
    console.log('   Remaining requests:', rateLimit.remaining);
    console.log('   Reset time:', rateLimit.reset.toISOString(), '\n');

    // Example 6: Multi-framework support
    console.log('6. Multi-framework component fetching:');
    const frameworks = ['hanzo', 'react', 'svelte', 'vue', 'react-native'] as const;

    for (const framework of frameworks) {
      try {
        const components = await client.listComponents(framework);
        console.log(`   ${framework}: ${components.length} components available`);
      } catch (error: any) {
        console.log(`   ${framework}: ${error.message}`);
      }
    }

    console.log('\n====================================');
    console.log('Example completed successfully!');
    console.log('\nNote: To use authenticated requests, set GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN environment variable.');

  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };