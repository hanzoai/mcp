# Hanzo MCP Tools Documentation

This document provides comprehensive documentation for all tools available in Hanzo MCP v0.6.0.

## Overview

Hanzo MCP provides 65+ tools organized by category, following the principle of **one tool per orthogonal task** with multiple actions where appropriate.

## Table of Contents

- [File System Tools](#file-system-tools)
- [Search Tools](#search-tools)
- [Shell & Process Tools](#shell--process-tools)
- [Database Tools](#database-tools)
- [Development Tools](#development-tools)
- [AI/Agent Tools](#aiagent-tools)
- [System Tools](#system-tools)

## File System Tools

### `read`
Read files with encoding detection and pagination.
- **Parameters**: 
  - `file_path`: File path to read
  - `offset`: Start reading from this line (optional)
  - `limit`: Maximum number of lines to read (optional)
- **Use Case**: Reading source code, configuration files, documentation

### `write`
Create or overwrite files.
- **Parameters**:
  - `file_path`: File path to write to
  - `content`: Content to write
- **Use Case**: Creating new files, generating reports, writing configurations

### `edit`
Precise line-based edits with pattern matching.
- **Parameters**:
  - `file_path`: File path to edit
  - `old_string`: Exact text to replace
  - `new_string`: Replacement text
  - `expected_replacements`: Number of replacements expected (optional)
- **Use Case**: Refactoring code, updating configurations, fixing bugs

### `multi_edit`
Batch edits to a single file.
- **Parameters**:
  - `file_path`: File path to edit
  - `edits`: Array of edit operations with old_string, new_string, and optional replace_all
- **Use Case**: Complex refactoring, batch updates, multiple bug fixes

### `tree`
Unix-style directory tree visualization.
- **Parameters**:
  - `path`: Directory path (optional, defaults to current)
  - `depth`: Maximum depth to traverse (optional)
  - `show_hidden`: Include hidden files (optional)
  - `dirs_only`: Show only directories (optional)
  - `pattern`: File pattern to match (optional)
  - `show_size`: Show file sizes (optional)
- **Use Case**: Understanding project structure, finding files, navigation

### `find`
Fast file finding with multiple backends (rg > ag > ack > grep).
- **Parameters**:
  - `pattern`: File name pattern to search for
  - `path`: Directory to search in (optional)
  - `type`: File type filter (f=file, d=directory)
  - `case_sensitive`: Case sensitive search (optional)
- **Use Case**: Locating files, finding resources, navigation

## Search Tools

### `grep`
Fast pattern search using ripgrep.
- **Parameters**:
  - `pattern`: Search pattern (regex supported)
  - `path`: Directory to search in (optional)
  - `include`: File patterns to include (optional)
- **Use Case**: Finding code patterns, locating TODOs, searching for function usage

### `symbols`
AST-aware symbol search using tree-sitter.
- **Parameters**:
  - `pattern`: Symbol pattern to search for
  - `path`: Directory to search (optional)
  - `type`: Symbol type filter (function, class, method, etc.)
- **Use Case**: Finding function definitions, locating classes, understanding code structure

### `search`
Multi-modal search combining text, vector, AST, git, and symbols.
- **Parameters**:
  - `pattern`: Search query (natural language or pattern)
  - `path`: Directory to search (optional)
  - `max_results`: Maximum results to return (optional)
  - `enable_grep`: Enable text search (default: true)
  - `enable_symbols`: Enable symbol search (default: true)
  - `enable_vector`: Enable semantic search (default: true)
  - `enable_git`: Enable git history search (default: false)
- **Use Case**: Comprehensive code discovery, semantic search, finding related code

### `git_search`
Search through git history.
- **Parameters**:
  - `pattern`: Search pattern
  - `search_type`: Type of search (commits, diff, log, blame)
  - `path`: Path to search (optional)
  - `max_results`: Maximum results (optional)
- **Use Case**: Finding when changes were made, understanding code evolution

### `vector_search`
Semantic similarity search using embeddings.
- **Parameters**:
  - `query`: Natural language search query
  - `path`: Directory to search (optional)
  - `max_results`: Maximum results (optional)
- **Use Case**: Finding conceptually similar code, discovering implementations

## Shell & Process Tools

### `run_command`
Execute shell commands with timeout and environment control.
- **Parameters**:
  - `command`: Command to execute
  - `cwd`: Working directory (optional)
  - `shell_type`: Shell to use (optional)
  - `use_login_shell`: Use login shell (default: true)
- **Use Case**: Building projects, running tests, system operations

### `run_background`
Background process execution.
- **Parameters**:
  - `command`: Command to run
  - `name`: Process name for identification
  - `cwd`: Working directory (optional)
- **Use Case**: Starting servers, long-running processes

### `processes`
List and monitor running processes.
- **Parameters**:
  - `filter`: Filter processes by name (optional)
  - `sort`: Sort by cpu, memory, or time (optional)
- **Use Case**: System monitoring, debugging, process management

### `pkill`
Terminate processes by name/pattern.
- **Parameters**:
  - `pattern`: Process name or pattern
  - `signal`: Signal to send (default: TERM)
- **Use Case**: Stopping services, cleaning up processes

### `npx`
Run Node.js packages directly.
- **Parameters**:
  - `package`: Package name to run
  - `args`: Arguments to pass (optional)
  - `cwd`: Working directory (optional)
- **Use Case**: Running Node.js tools without installation

### `uvx`
Run Python packages directly.
- **Parameters**:
  - `package`: Package name to run
  - `args`: Arguments to pass (optional)
  - `cwd`: Working directory (optional)
- **Use Case**: Running Python tools without installation

## Database Tools

### `sql`
SQL database operations with actions.
- **Parameters**:
  - `action`: Operation type (query, search, stats)
  - `query`: SQL query (for query action)
  - `pattern`: Search pattern (for search action)
  - `connection`: Database connection string (optional)
- **Use Case**: Data analysis, database management, reporting

### `graph`
Graph database operations with actions.
- **Parameters**:
  - `action`: Operation type (add, remove, query, search, stats)
  - `query`: Cypher query (for query action)
  - `node`/`edge`: Node or edge data (for add/remove)
  - `pattern`: Search pattern (for search action)
- **Use Case**: Knowledge graphs, relationship analysis, network data

## Development Tools

### `jupyter`
Jupyter notebook operations.
- **Parameters**:
  - `action`: Operation type (read, edit)
  - `notebook_path`: Path to notebook file
  - `cell_number`: Cell index (for edit)
  - `new_source`: New cell content (for edit)
  - `cell_type`: Cell type (code/markdown)
  - `edit_mode`: Edit mode (replace/insert/delete)
- **Use Case**: Data science workflows, interactive documentation

### `neovim`
Advanced text editing with Vim.
- **Parameters**:
  - `file`: File to edit
  - `command`: Vim command to execute
  - `mode`: Edit mode (command/insert)
- **Use Case**: Advanced text manipulation, batch edits

### `todo`
Task management with actions.
- **Parameters**:
  - `action`: Operation type (read, write)
  - `session_id`: Session identifier (optional)
  - `todos`: Task list (for write action)
- **Use Case**: Project management, tracking progress, organizing work

## AI/Agent Tools

### `agent`
Launch specialized sub-agents for task delegation.
- **Parameters**:
  - `prompt`: Task description for the agent
  - `model`: LLM model to use (optional)
  - `temperature`: Model temperature (optional)
  - `max_tokens`: Maximum response tokens (optional)
  - `tools`: Tools available to agent (optional)
  - `a2a`: Enable agent-to-agent communication (optional)
- **Use Case**: Complex tasks, parallel execution, specialized processing

### `llm`
Query multiple LLM providers with actions.
- **Parameters**:
  - `action`: Operation type (query, list, consensus)
  - `prompt`: Query for the LLM
  - `model`: Specific model to use (optional)
  - `models`: List of models for consensus (optional)
  - `temperature`: Model temperature (optional)
- **Use Case**: AI assistance, code generation, analysis

### `mcp`
Manage MCP server connections.
- **Parameters**:
  - `action`: Operation type (add, remove, list, stats)
  - `server`: Server name
  - `url`: Server URL (for add)
  - `env`: Environment variables (optional)
- **Use Case**: Tool integration, extending capabilities

## System Tools

### `config`
Git-style configuration management.
- **Parameters**:
  - `action`: Operation type (get, set, list, toggle)
  - `key`: Configuration key
  - `value`: Configuration value (for set)
  - `path`: Project path (optional)
- **Use Case**: Tool configuration, environment setup

### `stats`
System and usage statistics.
- **Parameters**:
  - `format`: Output format (text/json)
  - `category`: Specific category to show (optional)
- **Use Case**: Performance monitoring, usage analysis

### `tool_enable` / `tool_disable`
Dynamic tool management.
- **Parameters**:
  - `tool_name`: Name of tool to enable/disable
- **Use Case**: Security, customization, resource management

### `tool_list`
List all available tools and their status.
- **Parameters**: None
- **Use Case**: Discovery, debugging, configuration

### `batch`
Execute multiple operations atomically.
- **Parameters**:
  - `description`: Batch operation description
  - `invocations`: Array of tool invocations
- **Use Case**: Complex workflows, atomic operations, performance

### `think`
Structured reasoning space.
- **Parameters**:
  - `thought`: Reasoning content
- **Use Case**: Planning, analysis, complex problem solving

## Best Practices

1. **Use the right tool**: Choose tools based on their specific purpose
2. **Leverage actions**: Use action-based tools for related operations
3. **Compose tools**: Combine tools for complex workflows
4. **Configure appropriately**: Use per-project or global configuration as needed
5. **Monitor performance**: Use stats to track tool usage and performance

## Configuration

Tools can be configured through:
- Environment variables: `HANZO_TOOL_*`
- Configuration files: `.hanzo/config.json`
- Runtime: Using the `config` tool

## Error Handling

All tools provide clear error messages and follow consistent patterns:
- Permission errors include the required permission
- File not found errors include the searched path
- Timeout errors include the timeout value
- Invalid input errors describe the expected format

For more information, see the [full documentation](https://github.com/hanzoai/mcp).