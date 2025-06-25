# Hanzo MCP Tools Documentation

This document provides comprehensive documentation for all tools available in Hanzo MCP v0.5.1.

## Table of Contents

- [File System Tools](#file-system-tools)
- [Shell/Command Tools](#shellcommand-tools)
- [Code Analysis Tools](#code-analysis-tools)
- [Vector Search Tools](#vector-search-tools)
- [Jupyter Notebook Tools](#jupyter-notebook-tools)
- [Task Management Tools](#task-management-tools)
- [Agent Tools](#agent-tools)
- [Utility Tools](#utility-tools)

## File System Tools

### `read`
Read one or multiple files with automatic encoding detection.
- **Parameters**: 
  - `paths`: List of file paths to read
  - `line_offset`: Start reading from this line (optional)
  - `limit`: Maximum number of lines to read (optional)
- **Use Case**: Reading source code, configuration files, or documentation

### `write`
Create or overwrite files with content.
- **Parameters**:
  - `path`: File path to write to
  - `content`: Content to write
- **Use Case**: Creating new files, generating reports, writing configurations

### `edit`
Make precise line-based edits to existing files.
- **Parameters**:
  - `path`: File path to edit
  - `old_string`: Exact text to replace
  - `new_string`: Replacement text
  - `replace_all`: Replace all occurrences (optional)
- **Use Case**: Refactoring code, updating configurations, fixing bugs

### `multi_edit`
Make multiple edits to a single file in one operation.
- **Parameters**:
  - `path`: File path to edit
  - `edits`: Array of edit operations with old_string, new_string, and optional replace_all
- **Use Case**: Complex refactoring, batch updates, multiple bug fixes

### `directory_tree`
Get a recursive tree view of directories.
- **Parameters**:
  - `path`: Directory path to explore
  - `max_depth`: Maximum depth to traverse (optional)
  - `show_hidden`: Include hidden files (optional)
  - `ignore_patterns`: Patterns to ignore (optional)
- **Use Case**: Understanding project structure, finding files, navigation

### `content_replace`
Replace patterns in file contents using regex.
- **Parameters**:
  - `path`: File path
  - `pattern`: Regex pattern to match
  - `replacement`: Replacement text
- **Use Case**: Batch replacements, formatting fixes, pattern-based updates

## Shell/Command Tools

### `run_command`
Execute shell commands with timeout and environment control.
- **Parameters**:
  - `command`: Command to execute
  - `working_directory`: Working directory (optional)
  - `environment`: Environment variables (optional)
  - `timeout`: Command timeout in seconds (optional)
- **Use Case**: Building projects, running tests, system operations

## Code Analysis Tools

### `grep`
Fast pattern search across files using ripgrep.
- **Parameters**:
  - `pattern`: Search pattern (regex supported)
  - `path`: Directory to search in
  - `include`: File patterns to include (optional)
  - `ignore_case`: Case-insensitive search (optional)
- **Use Case**: Finding code patterns, locating TODOs, searching for function usage

### `grep_ast`
AST-aware code search that understands code structure.
- **Parameters**:
  - `pattern`: Search pattern
  - `path`: Directory to search
  - `language`: Programming language (optional)
  - `line_number`: Include line numbers (optional)
- **Use Case**: Finding function definitions, understanding code flow, refactoring

### `unified_search`
Intelligent multi-modal search combining text, vector, AST, and symbol search.
- **Parameters**:
  - `pattern`: Search query
  - `path`: Search path
  - `max_results`: Maximum results per type
  - `enable_vector`: Enable semantic search
  - `enable_ast`: Enable AST search
  - `enable_symbol`: Enable symbol search
  - `include_context`: Include function/method context
- **Use Case**: Complex code discovery, semantic search, finding related code

## Vector Search Tools

### `vector_index`
Index documents and code in project-aware vector databases.
- **Parameters**:
  - `file_path`: File to index
  - `content`: Direct content to index (alternative to file)
  - `chunk_size`: Size of text chunks
  - `chunk_overlap`: Overlap between chunks
  - `metadata`: Additional metadata
- **Use Case**: Building searchable knowledge bases, indexing documentation

### `vector_search`
Semantic search across indexed documents.
- **Parameters**:
  - `query`: Search query
  - `limit`: Maximum results
  - `score_threshold`: Minimum similarity score
  - `search_scope`: Scope (all/global/current/project)
  - `include_content`: Include document content
- **Use Case**: Finding similar code, semantic documentation search, knowledge retrieval

## Jupyter Notebook Tools

### `notebook_read`
Read Jupyter notebook cells with outputs.
- **Parameters**:
  - `notebook_path`: Path to .ipynb file
  - `cell_id`: Specific cell to read (optional)
- **Use Case**: Analyzing notebooks, extracting code, reviewing outputs

### `notebook_edit`
Edit, insert, or delete cells in Jupyter notebooks.
- **Parameters**:
  - `notebook_path`: Path to notebook
  - `cell_id`: Cell to edit
  - `new_source`: New cell content
  - `cell_type`: Type (code/markdown)
  - `edit_mode`: Mode (replace/insert/delete)
- **Use Case**: Updating notebooks, adding documentation, fixing code cells

## Task Management Tools

### `todo_read`
Read the current task list for the session.
- **Parameters**: None
- **Use Case**: Tracking progress, reviewing tasks, planning next steps

### `todo_write`
Create and manage a structured task list.
- **Parameters**:
  - `todos`: Array of tasks with content, status, priority, and id
- **Use Case**: Organizing complex tasks, tracking multi-step operations

## Agent Tools

### `dispatch_agent`
Launch specialized sub-agents for concurrent task execution.
- **Parameters**:
  - `description`: Task description
  - `prompt`: Detailed instructions for the agent
  - `model`: LLM model to use (optional)
  - `max_tokens`: Response limit (optional)
- **Use Case**: Parallel execution, specialized tasks, complex research

## Utility Tools

### `think`
Structured space for complex reasoning without making changes.
- **Parameters**:
  - `thought`: The reasoning content
- **Use Case**: Planning complex operations, analyzing problems, documenting reasoning

### `batch`
Execute multiple tool calls in a single operation.
- **Parameters**:
  - `operations`: Array of tool calls to execute
- **Use Case**: Bulk operations, performance optimization, atomic changes

## Tool Composability

Tools are designed to work together for complex tasks:

### Example: Code Refactoring Workflow
```
1. unified_search → Find all occurrences of a pattern
2. grep_ast → Understand the code structure
3. multi_edit → Make coordinated changes
4. run_command → Run tests to verify
```

### Example: Project Analysis Workflow
```
1. directory_tree → Understand structure
2. vector_index → Index key files
3. dispatch_agent → Analyze different components in parallel
4. todo_write → Create action items
```

### Example: Knowledge Building Workflow
```
1. read → Read documentation files
2. vector_index → Index for semantic search
3. unified_search → Find related concepts
4. write → Generate summary documentation
```

## Configuration

Tools can be enabled/disabled via configuration:

```bash
# Disable write tools for read-only mode
hanzo-mcp --disable-write-tools

# Enable agent tool with specific model
hanzo-mcp --enable-agent-tool --agent-model "claude-3-opus-20240229"

# Configure vector search
hanzo-mcp --vector-data-path ~/.hanzo/vectors
```

## Security

All tools respect the permission system:
- File operations are restricted to allowed paths
- Commands have configurable timeouts
- Write operations can be disabled globally
- Path traversal attacks are prevented

## Performance Tips

1. Use `unified_search` for complex searches instead of multiple grep calls
2. Use `multi_edit` instead of multiple `edit` calls for the same file
3. Use `batch` for multiple independent operations
4. Index frequently searched codebases with `vector_index`
5. Use `dispatch_agent` for parallelizable tasks