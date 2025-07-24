# @hanzo/mcp

TypeScript implementation of Model Context Protocol (MCP) server for AI development tools.

## Installation

```bash
npm install -g @hanzo/mcp
```

## Usage

### As a CLI

```bash
# Start MCP server
hanzo-mcp serve

# Use with Claude Desktop
hanzo-mcp install-desktop
```

### As a Library

```typescript
import { createMCPServer } from '@hanzo/mcp';

const server = createMCPServer({
  name: 'my-mcp-server',
  version: '1.0.0',
  tools: [
    // Your custom tools
  ]
});

await server.start();
```

## Features

- File system operations (read, write, search)
- Code execution
- Web fetching
- Integration with Claude Desktop
- Extensible tool system

## License

MIT © Hanzo AI