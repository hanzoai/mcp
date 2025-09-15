#!/usr/bin/env node

// Test MCP protocol directly
console.log('Testing MCP Protocol...\n');

// Send initialize request
const initRequest = {
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    clientInfo: {
      name: "test-client",
      version: "1.0.0"
    },
    capabilities: {}
  },
  id: 1
};

console.log('Sending:', JSON.stringify(initRequest));
process.stdout.write(JSON.stringify(initRequest) + '\n');

// Send tools/list request
setTimeout(() => {
  const toolsRequest = {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: 2
  };
  
  console.log('\nSending:', JSON.stringify(toolsRequest));
  process.stdout.write(JSON.stringify(toolsRequest) + '\n');
}, 100);

// Test search tool
setTimeout(() => {
  const searchRequest = {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "search",
      arguments: {
        query: "test",
        maxResults: 3
      }
    },
    id: 3
  };
  
  console.log('\nSending:', JSON.stringify(searchRequest));
  process.stdout.write(JSON.stringify(searchRequest) + '\n');
}, 200);

// Listen for responses
process.stdin.on('data', (data) => {
  console.log('Response:', data.toString());
});