// @hanzo/mcp - MCP Server Package
export * from '@modelcontextprotocol/sdk';

// Export a simple MCP server factory
export function createMCPServer(config?: any) {
  console.log('Creating MCP server with config:', config);
  return {
    start: () => console.log('MCP server started'),
    stop: () => console.log('MCP server stopped')
  };
}