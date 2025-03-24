# Hanzo MCP Developer Guide

## Project Overview

Hanzo MCP is a Model Context Protocol server that enables AI models like Claude to interact with file systems, execute commands, analyze projects, and manage code in a secure, controlled manner. This document captures the key architectural patterns, implementation details, and development guidelines for the project.

## Architecture

### Core Components

- **HanzoMCPServer**: Main server class that initializes all components and registers tools
- **PermissionManager**: Security layer controlling file system access through path validation
- **DocumentContext**: Tracks and manages file content for context preservation
- **CommandExecutor**: Handles shell command and script execution
- **ProjectAnalyzer/ProjectManager**: Analyzes projects, detects languages and frameworks
- **FileOperations**: Core file system interaction functionality
- **ThinkingTool**: Structured thinking space for planning without making changes

### Tool Registration Pattern

All tools follow a consistent registration pattern:
1. Tool classes define a `register_tools(mcp_server)` method
2. Individual tools are implemented as async functions with standardized error handling
3. Tools validate inputs, check permissions, perform operations, and return formatted results
4. Progress reporting is implemented for long-running operations

## Security Model

The permission system is based on:
1. Explicitly allowed paths (allowlisting)
2. Excluded paths and patterns for sensitive directories/files
3. Path normalization and validation before operations
4. Per-operation permission checks

Security exclusions include:
- Sensitive directories (`.ssh`, `.gnupg`, etc.)
- Credential files (`.env`, `*.key`, etc.)
- Database files and logs

## Implemented Tools

### Filesystem Tools
- `read_files`: Read contents of one or multiple files
- `write_file`: Create or overwrite files
- `edit_file`: Make line-based edits with diff generation
- `directory_tree`: Generate structured directory view
- `get_file_info`: Retrieve file metadata
- `search_content`: Search for patterns (like grep)
- `content_replace`: Find and replace across files

### Shell Tools
- `run_command`: Execute shell commands
- `run_script`: Execute scripts with specified interpreters
- `script_tool`: Run code in different languages

### Project Analysis
- `project_analyze_tool`: Analyze project structure and dependencies
  - Detects programming languages
  - Identifies frameworks and libraries
  - Analyzes file types and code statistics
  - Examines dependencies

### Jupyter Notebook Tools
- `read_notebook`: Extract cells and outputs
- `edit_notebook`: Modify notebook cells

### Thinking Tool
- `think`: Structured space for reasoning and planning

## Error Handling

The error handling pattern includes:
1. Parameter validation at the beginning of each tool
2. Consistent error message formatting with descriptive details
3. Proper exception handling with specific error messaging
4. Progress tracking and status updates for user feedback

## Development Guidelines

### Adding New Tools

When implementing new tools:
1. Create a class in the appropriate module under `tools/`
2. Implement `register_tools(mcp_server)` with tool functions
3. Use `create_tool_context(ctx)` for logging and progress reporting
4. Validate all input parameters
5. Check permissions for any file system operations
6. Handle exceptions with specific error messages
7. Return formatted results with appropriate status information

### Permission System

When working with the permission system:
1. Always use `permission_manager.is_path_allowed()` before file operations
2. Add path validation for any new tool that accesses the file system
3. Consider security implications for new functionality
4. Don't bypass permission checks even for seemingly safe operations

### Tool Implementation Best Practices

1. Start with parameter validation
2. Log operation start with `await tool_ctx.info()`
3. Check permissions before file system access
4. Use try/except blocks for error handling
5. Report progress for long-running operations
6. Return clear success/failure messages
7. Include relevant metadata in responses

## Project Structure

```
hanzo_mcp/
├── __init__.py
├── cli.py            # Command-line interface
├── server.py         # HanzoMCPServer implementation
└── tools/            # Tool implementations
    ├── __init__.py   # Tool registration
    ├── common/       # Shared functionality
    │   ├── context.py      # Document context
    │   ├── permissions.py  # Permission system
    │   ├── thinking.py     # Think tool
    │   └── validation.py   # Parameter validation
    ├── filesystem/   # File operations
    ├── jupyter/      # Notebook operations
    ├── project/      # Project analysis
    └── shell/        # Command execution
```

## Configuration

The server can be configured through:
1. Command-line arguments to `hanzo-mcp`
2. Claude Desktop configuration for MCP servers
3. Programmatic API through `HanzoMCPServer` initialization

Key configuration options:
- `--allow-path`: Paths the server can access
- `--name`: Name of the MCP server
- `--transport`: Transport protocol (stdio, sse)
- `--install`: Install configuration in Claude Desktop
