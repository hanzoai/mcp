#!/usr/bin/env node

// Simple direct test of search functionality
import { searchTools } from './dist/index.js';

const searchTool = searchTools.find(t => t.name === 'search');
const fetchTool = searchTools.find(t => t.name === 'fetch');

async function testSearch() {
  console.log('🧪 Testing MCP Search Implementation\n');
  
  // Test 1: Basic search
  console.log('Test 1: Basic search for "LanceDB"');
  try {
    const result = await searchTool.handler({
      query: 'LanceDB',
      maxResults: 5
    });
    
    console.log('Results:', JSON.stringify(result, null, 2));
    console.log(`✓ Found ${result.results?.length || 0} results\n`);
    
    // Test 2: Fetch first result
    if (result.results && result.results.length > 0) {
      console.log('Test 2: Fetch first result');
      const fetchResult = await fetchTool.handler({
        id: result.results[0].id
      });
      
      console.log('Fetched document:');
      console.log('- ID:', fetchResult.id);
      console.log('- Title:', fetchResult.title);
      console.log('- URL:', fetchResult.url);
      console.log('- Text length:', fetchResult.text?.length || 0);
      console.log('✓ Document fetched successfully\n');
    }
  } catch (error) {
    console.error('Error:', error);
  }
  
  // Test 3: Search with pattern
  console.log('Test 3: Search in TypeScript files');
  try {
    const result = await searchTool.handler({
      query: 'search',
      filePattern: '*.ts',
      maxResults: 3
    });
    
    console.log('TypeScript search results:', result.results?.length || 0);
    result.results?.forEach(r => {
      console.log(`- ${r.title} (${r.url})`);
    });
    console.log('✓ Pattern search completed\n');
  } catch (error) {
    console.error('Error:', error);
  }
  
  // Test 4: Check URL format
  console.log('Test 4: Check URL formats');
  try {
    const result = await searchTool.handler({
      query: 'test',
      maxResults: 1
    });
    
    if (result.results && result.results.length > 0) {
      const url = result.results[0].url;
      if (url.includes('ngrok')) {
        console.log('✓ Ngrok tunnel URL detected');
      } else if (url.startsWith('file://')) {
        console.log('✓ Local file URL format');
      } else if (url.startsWith('http://')) {
        console.log('✓ HTTP URL format');
      }
      console.log('  URL:', url);
    }
  } catch (error) {
    console.error('Error:', error);
  }
  
  console.log('\n✅ Tests completed!');
}

testSearch().catch(console.error);