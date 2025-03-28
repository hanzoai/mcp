# Hanzo MCP Developer Guide

_Updated: March 28, 2025_

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
- **JupyterNotebookTools**: Tools for working with Jupyter notebooks

### Directory Structure
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
    │   └── file_operations.py  # File and directory operations
    ├── jupyter/      # Notebook operations
    │   └── notebook_operations.py  # Jupyter notebook tools
    ├── project/      # Project analysis
    │   └── analysis.py      # Project structure analysis
    └── shell/        # Command execution
        └── command_executor.py  # Enhanced command execution
```

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

### Vector Store Tools
- `vector_index`: Index files or directories for semantic search
- `vector_search`: Search indexed content with semantic and full-text filtering
- `vector_delete`: Remove documents from the vector store
- `vector_list`: List indexed documents
- `git_ingest`: Ingest and index entire git repositories

## Vector Search Implementation

The vector search functionality is implemented using ChromaDB and provides the following capabilities:

### Vector Store Architecture

1. **Persistent Storage**: Vector embeddings are stored persistently in a local database at `~/.hanzo/vector_db/{project_hash}` for each indexed project
2. **Multiple Modalities**: Support for indexing and searching:
   - Text files and source code (with syntax highlighting)
   - Document files (PDF, DOCX, etc.)
   - Image files (when available)
3. **Full-Text Search**: Combined vector similarity search with full-text filtering
4. **Metadata Filtering**: Filter search results by file types, paths, and custom metadata

### Search Patterns

Full-text search is implemented using Chroma's document filtering capabilities:

```python
# Example with full-text filtering
collection.query(
    query_texts=["find important functions"],
    where_document={"$contains": "def process_data"}
)

# Example with metadata filtering
collection.query(
    query_texts=["authorization code"],
    where={"file_extension": ".py"},
    where_document={"$contains": "auth"}
)
```

### Git Repository Indexing

The `git_ingest` tool enables seamless indexing of entire git repositories:

1. Clones the repository to a temporary directory
2. Indexes all files based on configurable filters
3. Extracts metadata like branch, commit hash, and dates
4. Cleans up temporary files after indexing

## Best Practices and Patterns

### Error Handling Pattern
The error handling pattern includes:
1. Parameter validation at the beginning of each tool
2. Consistent error message formatting with descriptive details
3. Proper exception handling with specific error messaging
4. Progress tracking and status updates for user feedback

### Permission Checking Pattern
1. Path normalization using `normalize_path`
2. Path validation using `permission_manager.is_path_allowed()`
3. Permission checks before any file system operations
4. Error handling for permission violations

### Command Execution Pattern
1. Command validation and sanitization
2. Working directory checks
3. Execution with proper environment setup
4. Output and error capture with timeout handling

## System Requirements
- Python 3.13+
- Dependencies:
  - mcp>=1.3.0
  - httpx>=0.27.0
  - uvicorn>=0.23.1
  - pytest

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

### Using the Think Tool

The Think Tool is designed for structured reasoning and planning:
- Use it to analyze information without making changes
- Plan complex multi-step operations
- Evaluate different approaches
- Document your thought process

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

## Build System

The project uses a Makefile-based build system with the following features:

### Makefile Targets

- `make help`: Display all available targets with descriptions
- `make install`: Install the package and dependencies
- `make test`: Run the test suite
- `make lint`: Run linters on the codebase
- `make format`: Format code according to project standards
- `make clean`: Clean up temporary files and caches

### Docker Support

The Makefile includes Docker integration with the following targets:

- `make docker-build`: Build a Docker image for the project
- `make docker-push`: Push the built image to a Docker registry
- `make docker-run`: Run the application in a Docker container

### Environment Setup

- Automatic Python installation using uv if needed
- Virtual environment creation and management with version checking
- Cross-platform support (Windows, macOS, Linux, WSL)
- Package manager detection and automatic fallback (uv with pip fallback)
- System and dependency detection
- Comprehensive error handling and diagnostics
- Colorized output for better readability

## Change History
- March 28, 2025: Enhanced Makefile with uv-based Python management, dependency checking, and improved build system
- March 28, 2025: Added Docker support and improved output formatting
- March 25, 2025: Updated with additional component details and best practices
