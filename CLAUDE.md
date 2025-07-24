# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Hanzo MCP (Model Context Protocol) is a comprehensive MCP server that provides 70+ tools for AI assistants to interact with the local filesystem, execute commands, and orchestrate other MCP servers. It's designed as "one MCP to rule them all" - a unified interface that can control and coordinate multiple MCP servers while providing a complete development toolkit out of the box.

## Key Architecture Components

### 1. Server Architecture (`hanzo_mcp/server.py`)
- **HanzoServer**: Main server class that inherits from FastMCP
- Handles tool registration, context management, and server lifecycle
- Supports both stdio and SSE transport modes
- Desktop Extension (DXT) packaging for one-click Claude Desktop installation

### 2. Tool System (`hanzo_mcp/tools/`)
- **BaseTool**: Abstract base class all tools inherit from (`tools/common/base.py`)
- **PermissionManager**: Centralized permission system for path access control
- **Tool Categories**: Organized by functionality (filesystem, shell, agent, etc.)
- **Dynamic Tool Loading**: Tools can be enabled/disabled at runtime
- **Plugin System**: Support for loading custom user tools

### 3. Enhanced Features
- **Agent Tool**: Delegate complex tasks to specialized LLM agents
- **Critic Tool**: Built-in code review and quality enforcement
- **Search Tool**: Unified search combining grep, AST, vector, and symbol search
- **Rules Tool**: Reads project preferences from .cursorrules and .claude files
- **Mode System**: Developer personalities that change tool behavior
- **Batch Tool**: Execute multiple tools concurrently for performance

### 4. Configuration System
- **Settings Management**: Hierarchical config from defaults → global → project → env → CLI
- **Tool Registry**: Centralized tool configuration and metadata
- **MCP Server Orchestration**: Dynamically add/remove external MCP servers
- **Project-Specific Config**: Per-project tool preferences and workflows

## Development Commands

### Initial Setup
```bash
# Install Python 3.12 via uv (auto-installs uv if missing)
make install-python

# Complete setup (venv + dependencies)
make setup

# Install for development
make install
```

### Testing
```bash
# Run all tests
make test

# Quick test run (no reinstall)
make test-quick

# Run with coverage
make test-cov

# Run specific test
make test-one TEST=test_simple.py::test_function_name

# Manual test of the server
make test-manual
```

### Code Quality
```bash
# Format code with ruff
make format

# Lint code
make lint

# Type check with mypy
make type-check
```

### Building & Publishing
```bash
# Build distribution packages
make build

# Build Desktop Extension (.dxt)
make build-dxt

# Version management
make bump-patch  # 0.6.13 → 0.6.14
make bump-minor  # 0.6.13 → 0.7.0
make bump-major  # 0.6.13 → 1.0.0

# Publish to PyPI
make publish
```

### Development Server
```bash
# Run development server
make dev

# Run with specific options
hanzo-mcp --allow-path /path/to/project --enable-agent-tool

# Install to Claude Desktop
make install-desktop
```

### Documentation
```bash
# Build docs
make docs

# Serve docs locally
make docs-serve
```

## Tool Development Guidelines

### Creating a New Tool

1. **Inherit from BaseTool or EnhancedTool**:
```python
from hanzo_mcp.tools.common.enhanced_base import EnhancedTool

class MyTool(EnhancedTool):
    name = "my_tool"
    description = "Brief description"
    
    def get_params_schema(self):
        return {
            "type": "object",
            "properties": {...},
            "required": [...]
        }
    
    async def run(self, **kwargs):
        # Implementation
        return "result"
```

2. **Register in appropriate module** (e.g., `tools/filesystem/__init__.py`)

3. **Add to TOOL_REGISTRY** in `config/tool_config.py`

4. **Write tests** in corresponding test module

### Tool Patterns

- **Permission Checks**: Always validate paths with PermissionManager
- **Error Handling**: Use try/except with clear error messages
- **Async Operations**: Most tools should be async for performance
- **Result Format**: Return strings or structured data that serialize to JSON
- **Context Usage**: Access shared context via `self.context`
- **Batch Support**: Consider if tool benefits from batch execution

## Testing Patterns

### Test Structure
- Tests organized by component: `test_agent/`, `test_filesystem/`, etc.
- Use pytest with async support (`@pytest.mark.asyncio`)
- Mock external dependencies (subprocess, file I/O, API calls)
- Fixtures defined in `conftest.py`

### Common Test Scenarios
```python
# Test with mock context
async def test_my_tool(mock_context):
    tool = MyTool()
    result = await tool.run(param="value")
    assert "expected" in result

# Test with temporary files
def test_file_operation(tmp_path):
    test_file = tmp_path / "test.txt"
    test_file.write_text("content")
    # Test file operations

# Skip complex tests
@pytest.mark.skip(reason="Complex external dependency")
def test_external_integration():
    pass
```

## Key Implementation Details

### Search System
- **Unified Search**: Runs multiple search types in parallel
- **Grep**: Fast pattern matching with ripgrep fallback
- **AST Search**: Tree-sitter powered code structure analysis  
- **Vector Search**: Semantic search with embeddings
- **Symbol Search**: Find function/class definitions

### Agent System
- **LiteLLM Integration**: Supports 100+ LLM providers
- **Recursive Delegation**: Agents can spawn sub-agents
- **Tool Access**: Agents have access to all enabled tools
- **Parallel Execution**: Multiple agents can run concurrently

### Permission System
- **Path Validation**: All file operations check allowed paths
- **Project Isolation**: Can restrict to specific project directories
- **Command Safety**: Dangerous commands are blocked or require confirmation

### Mode System (Developer Personalities)
- **Modes**: Different tool configurations and behaviors
- **Examples**: "guido" (Python focus), "linus" (systems focus)
- **Custom Modes**: Users can define their own modes
- **Mode Switching**: Change behavior without restarting

## Common Issues & Solutions

### Import Errors
- Ensure virtual environment is activated
- Run `make setup` to install all dependencies
- Check Python version (requires 3.12+)

### Permission Denied
- Add paths with `--allow-path` flag
- Check file permissions
- Ensure not trying to access system directories

### Test Failures
- Run `make install-test` for test dependencies
- Some tests require API keys (can be skipped)
- Use `make test-quick` for faster iteration

### Tool Not Found
- Check if tool is enabled in configuration
- Verify tool is registered in TOOL_REGISTRY
- Enable with `tool_enable` command

## Environment Variables

Key environment variables:
- `OPENAI_API_KEY`: For OpenAI models
- `ANTHROPIC_API_KEY`: For Claude models  
- `HANZO_API_KEY`: For Hanzo AI services
- `HANZO_MCP_*`: Various server configuration options

See `.env.example` for complete list.

## Project Philosophy

1. **Unix-Inspired**: Small tools that do one thing well
2. **Composable**: Tools work together via batch operations
3. **Safe by Default**: Permission system prevents accidents
4. **AI-First**: Designed for LLM interaction patterns
5. **Extensible**: Plugin system for custom tools
6. **Quality Focused**: Built-in critic for code review

The goal is to provide a complete, opinionated toolkit that "just works" while allowing customization when needed.