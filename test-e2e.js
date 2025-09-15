#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function testMCPSearch() {
  console.log('🧪 Starting E2E Test for Hanzo MCP Search...\n');
  
  const transport = new StdioClientTransport({
    command: 'hanzo-mcp',
    args: ['serve']
  });
  
  const client = new Client({
    name: 'test-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  });
  
  await client.connect(transport);
  console.log('✓ Connected to MCP server\n');
  
  // Test 1: Search functionality
  console.log('📝 Test 1: Search for "LanceDB" in the codebase');
  try {
    const searchResult = await client.callTool('search', {
      query: 'LanceDB',
      maxResults: 5
    });
    
    console.log('Search results:', JSON.stringify(searchResult, null, 2));
    
    if (searchResult.results && Array.isArray(searchResult.results)) {
      console.log(`✓ Found ${searchResult.results.length} results`);
      
      // Test 2: Fetch functionality
      if (searchResult.results.length > 0) {
        const firstResult = searchResult.results[0];
        console.log(`\n📝 Test 2: Fetch document with ID: ${firstResult.id}`);
        
        const fetchResult = await client.callTool('fetch', {
          id: firstResult.id
        });
        
        console.log('Fetch result:', JSON.stringify({
          id: fetchResult.id,
          title: fetchResult.title,
          url: fetchResult.url,
          textLength: fetchResult.text?.length || 0,
          hasMetadata: !!fetchResult.metadata
        }, null, 2));
        
        console.log('✓ Document fetched successfully');
      }
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
  
  // Test 3: Search with file pattern
  console.log('\n📝 Test 3: Search with file pattern *.ts');
  try {
    const patternResult = await client.callTool('search', {
      query: 'function',
      maxResults: 3,
      filePattern: '*.ts'
    });
    
    console.log('Pattern search results:', JSON.stringify(patternResult, null, 2));
    console.log('✓ Pattern search completed');
  } catch (error) {
    console.error('❌ Error:', error);
  }
  
  // Test 4: Check ngrok tunnel
  console.log('\n📝 Test 4: Check for ngrok tunnel');
  try {
    const searchResult = await client.callTool('search', {
      query: 'test',
      maxResults: 1
    });
    
    if (searchResult.results && searchResult.results.length > 0) {
      const url = searchResult.results[0].url;
      if (url.includes('ngrok')) {
        console.log('✓ Ngrok tunnel detected:', url);
      } else if (url.startsWith('file://')) {
        console.log('✓ Local file URLs (no ngrok configured):', url);
      } else {
        console.log('✓ URL format:', url);
      }
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
  
  await client.close();
  console.log('\n✅ E2E Tests completed!');
}

testMCPSearch().catch(console.error);