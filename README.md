# @hanzo/mcp

Unified Model Context Protocol (MCP) server providing comprehensive AI development tools and UI component management.

## Installation

```bash
npm install -g @hanzo/mcp
```

## Quick Start

```bash
# Start with all tools enabled (default: 54 tools)
hanzo-mcp serve

# Core tools only (19 tools)
hanzo-mcp serve --core-only

# Disable specific tool categories
hanzo-mcp serve --disable-ui             # Exclude UI tools
hanzo-mcp serve --disable-autogui        # Exclude AutoGUI tools
hanzo-mcp serve --disable-orchestration  # Exclude orchestration tools

# List all available tools (54 by default)
hanzo-mcp list-tools

# Install for Claude Desktop
hanzo-mcp install-desktop
```

## Features

### Core Tools (19 tools)
- **File Operations**: Read, write, list, create, delete, move files
- **Search**: Grep, find files, unified search strategies
- **Editing**: Single and multi-edit operations
- **Shell**: Command execution, background processes

### UI Tools (11 tools - enabled by default)
Disable with `--disable-ui` flag:
- **Component Management**: List, search, and get component details
- **Source Code Access**: Retrieve component source and demos
- **Project Setup**: Initialize projects with Hanzo UI
- **Blocks & Patterns**: Access UI blocks and patterns
- **Installation Guides**: Complete setup documentation

### AutoGUI Tools (18 tools - enabled by default)
Disable with `--disable-autogui` flag:
- **Mouse Control**: Move, click, drag, scroll operations
- **Keyboard Control**: Type text, press keys, hotkey combinations
- **Screen Capture**: Screenshots, pixel color detection
- **Image Recognition**: Find images on screen with confidence matching
- **Window Management**: List, activate, control windows
- **Multi-monitor Support**: Screen information and coordinates

### Orchestration Tools (6 tools - enabled by default)
Disable with `--disable-orchestration` flag:
- **Agent Spawning**: Create AI agents with specific models and constraints
- **Swarm Orchestration**: Coordinate multiple agents in parallel or sequence
- **Critic Agents**: Code review and quality gate enforcement
- **Hanzo Node**: Connect to distributed AI compute nodes
- **LLM Router**: Intelligent model selection and fallback chains
- **Consensus**: Multi-agent voting and decision making

## Usage

### CLI Options

```bash
# All tools enabled (default - 54 tools)
hanzo-mcp serve

# Core tools only (19 tools)
hanzo-mcp serve --core-only

# Disable specific categories
hanzo-mcp serve --disable-ui --disable-autogui --disable-orchestration

# Custom tool selection
hanzo-mcp serve --enable-categories files,ui --disable-tools bash,shell

# List tools by category
hanzo-mcp list-tools --category ui
```

### Programmatic Usage

```typescript
import { createMCPServer } from '@hanzo/mcp';

// Basic server with core tools
const server = await createMCPServer();

// Server with UI tools enabled
const serverWithUI = await createMCPServer({
  toolConfig: {
    enableCore: true,
    enableUI: true
  }
});

// Custom configuration
const customServer = await createMCPServer({
  name: 'my-mcp-server',
  version: '1.0.0',
  toolConfig: {
    enableCore: true,
    enableUI: true,
    enableAutoGUI: true,
    enableOrchestration: true,
    disabledTools: ['bash'],
    customTools: [/* your tools */]
  }
});
```

## AI Client Configuration

### Claude Desktop
Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "hanzo": {
      "command": "npx",
      "args": ["@hanzo/mcp", "serve"]
    }
  }
}
```

### Cursor
Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "hanzo": {
      "command": "npx",
      "args": ["@hanzo/mcp", "serve"]
    }
  }
}
```

## Features

- **Modular Tool System**: Enable only the tools you need (54 tools total)
- **Agent Orchestration**: Spawn and coordinate multiple AI agents
- **Consensus Mechanisms**: Multi-agent decision making and voting
- **Critic System**: Automated code review and quality enforcement
- **LLM Routing**: Intelligent model selection with fallback chains
- **UI Component Integration**: Access Hanzo UI components and patterns
- **Computer Control**: Full mouse, keyboard, and screen automation
- **File System Operations**: Comprehensive file manipulation
- **Code Execution**: Safe shell command execution
- **Search Capabilities**: Multiple search strategies
- **Distributed Computing**: Connect to Hanzo compute nodes
- **Multi-Implementation Support**: RustAutoGUI, JSAutoGUI, PyAutoGUI with automatic fallback
- **Extensible Architecture**: Add custom tools easily
- **AI Client Integration**: Works with Claude, Cursor, and other MCP clients

## License

MIT © Hanzo AI