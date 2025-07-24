# Hanzo AI Tools Documentation

## Overview

Hanzo AI provides a comprehensive suite of 65+ tools designed for AI-assisted software development. The tools follow a unified design philosophy: **one tool per orthogonal task** with multiple actions where appropriate.

## Design Principles

1. **Orthogonal Design**: Each tool serves a distinct purpose with no overlap
2. **Action-Based**: Tools support multiple actions for related operations
3. **Configurable**: All tools can be configured globally or per-project
4. **Composable**: Tools work together for complex workflows
5. **Unix Philosophy**: Simple, focused tools that do one thing well

## Tool Categories

### 1. File System Tools

Core tools for file manipulation and navigation:

- **read**: Read files with encoding detection and pagination
- **write**: Create or overwrite files
- **edit**: Precise line-based edits with pattern matching
- **multi_edit**: Batch edits to a single file
- **tree**: Unix-style directory tree visualization
- **find**: Fast file finding with multiple backends (rg > ag > ack > grep)

### 2. Search Tools

Comprehensive search capabilities:

- **grep**: Fast pattern search using ripgrep
- **symbols**: AST-aware symbol search using tree-sitter
- **search**: Multi-modal search combining text, vector, AST, git, and symbols
- **git_search**: Search through git history (commits, diffs, logs, blame)
- **vector_search**: Semantic similarity search using embeddings

### 3. Shell & Process Tools

System interaction and process management:

- **run_command**: Execute shell commands with timeout and environment control
- **run_background**: Background process execution
- **processes**: List and monitor running processes
- **pkill**: Terminate processes by name/pattern
- **npx/uvx**: Run Node.js/Python packages directly

### 4. Database Tools

Database interfaces:

- **sql**: Query and manage SQL databases (actions: query, search, stats)
- **graph**: Graph database operations (actions: add, remove, query, search, stats)

### 5. Development Tools

- **jupyter**: Jupyter notebook operations (actions: read, edit)
- **neovim**: Advanced text editing with Vim
- **todo**: Task management (actions: read, write)

### 6. AI/Agent Tools

- **agent**: Launch specialized sub-agents for task delegation
- **llm**: Query multiple LLM providers (actions: query, list, consensus)
- **mcp**: Manage MCP server connections (actions: add, remove, list, stats)

### 7. System Tools

- **config**: Git-style configuration management
- **stats**: System and usage statistics
- **tool_enable/disable**: Dynamic tool management
- **batch**: Execute multiple operations atomically
- **think**: Structured reasoning space

## Configuration

### Global vs Per-Project

Tools support both global and per-project configuration:

```bash
# Set global configuration
config --action set index.scope global

# Set project-specific configuration
config --action set index.scope project --path ./myproject

# Toggle between modes
config --action toggle index.scope
```

### Tool Configuration

Each tool can be configured through:

1. **Environment variables**: `HANZO_TOOL_*` prefixed vars
2. **Configuration files**: `.hanzo/config.json` in project root
3. **Runtime configuration**: Using the config tool

### Enabling/Disabling Tools

```bash
# Disable a tool
tool_disable todo

# Enable a tool
tool_enable todo

# List all tools and their status
tool_list
```

## Usage Examples

### File Operations

```bash
# Read a file
read /path/to/file.py

# Edit with pattern matching
edit /path/to/file.py --old "def old_func" --new "def new_func"

# Multiple edits in one operation
multi_edit /path/to/file.py --edits '[
  {"old": "import old", "new": "import new"},
  {"old": "OLD_CONST", "new": "NEW_CONST", "replace_all": true}
]'
```

### Search Operations

```bash
# Fast grep search
grep "TODO" --include "*.py"

# Find symbols
symbols "class.*Controller" --type class

# Smart search (automatically chooses best strategy)
search "authentication logic"

# Git history search
git_search "bug fix" --type commit
```

### Process Management

```bash
# Run command
run_command "npm test"

# Background execution
run_background "python server.py" --name myserver

# List processes
processes --filter python

# Kill process
pkill myserver
```

### Database Operations

```bash
# SQL query
sql --action query --query "SELECT * FROM users WHERE active = true"

# Graph traversal
graph --action query --query "MATCH (n:User)-[:FOLLOWS]->(m) RETURN n, m"
```

### AI Operations

```bash
# Query specific LLM
llm --action query --model gpt-4 --prompt "Explain this code"

# Get consensus from multiple models
llm --action consensus --prompt "Is this secure?" --models '["gpt-4", "claude-3", "gemini"]'

# Launch specialized agent
agent --prompt "Refactor this module for better performance" --files '["src/module.py"]'
```

## Tool Development

### Creating a New Tool

1. Inherit from `BaseTool` or appropriate base class
2. Implement required methods: `name`, `description`, `call`
3. Register with FastMCP in the `register` method
4. Add to appropriate category in `__init__.py`

Example:

```python
from hanzo_mcp.tools.common.base import BaseTool

class MyTool(BaseTool):
    @property
    def name(self) -> str:
        return "mytool"
    
    @property
    def description(self) -> str:
        return "Brief description. Actions: action1, action2."
    
    async def call(self, ctx: MCPContext, **kwargs) -> str:
        action = kwargs.get("action", "default")
        # Implementation
        return result
```

### Tool Guidelines

1. **Naming**: Use simple, lowercase names
2. **Description**: Start with brief purpose, then list actions
3. **Actions**: Use consistent action names across similar tools
4. **Error Handling**: Return clear error messages
5. **Performance**: Implement timeouts for long operations
6. **Permissions**: Respect the permission manager

## Integration with Claude Desktop

Add to Claude Desktop configuration:

```json
{
  "mcpServers": {
    "hanzo": {
      "command": "uvx",
      "args": ["--from", "hanzo-mcp", "hanzo-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

## Best Practices

1. **Use action-based tools** when available (sql, graph, llm, mcp)
2. **Compose tools** for complex operations
3. **Configure per-project** for isolated environments
4. **Monitor with stats** to track usage
5. **Use batch** for atomic multi-step operations

## Troubleshooting

### Common Issues

1. **Tool not found**: Check if tool is enabled with `tool_list`
2. **Permission denied**: Verify path permissions with config tool
3. **Search not working**: Ensure required binaries (rg, ag) are installed
4. **LLM errors**: Check API keys in environment

### Debug Mode

Enable debug logging:

```bash
export HANZO_DEBUG=1
hanzo-mcp --dev
```

## Future Enhancements

- **Hot reload**: `--dev` mode for live tool updates
- **open tool**: Cross-platform file/URL opening
- **watch tool**: File system monitoring
- **diff tool**: Advanced file comparison
- **Plugin system**: Dynamic tool loading

For the latest updates and contributions, see the [GitHub repository](https://github.com/hanzoai/mcp).