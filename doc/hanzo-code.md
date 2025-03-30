# hanzo-code CLI Tool

The `hanzo-code` CLI tool provides a command-line interface and stdio interface for editing and interacting with code. It can be used directly from the command line or as an interface for AI development environments like Claude Desktop.

## Installation

The `hanzo-code` CLI tool is installed as part of the `hanzo-mcp` package. To install it, run:

```bash
pip install hanzo-mcp
```

Or install from the repository:

```bash
pip install -e .
```

## Usage

### Stdio Mode

By default, `hanzo-code` runs in stdio mode, which is designed for integration with AI development environments. In this mode, the tool accepts JSON commands from stdin and writes JSON results to stdout.

```bash
hanzo-code
```

In this mode, you send JSON commands to the tool in the following format:

```json
{"operation": "operation_name", "args": {"arg1": "value1", "arg2": "value2"}}
```

For example, to read a file:

```json
{"operation": "read", "args": {"paths": "/path/to/file.py"}}
```

The tool will respond with a JSON result:

```json
{"success": true, "message": "Read file successfully", "content": "..."}
```

### Command Line Mode

You can also run specific operations directly from the command line:

```bash
hanzo-code operation_name --arg1 value1 --arg2 value2
```

For example, to read a file:

```bash
hanzo-code read --paths /path/to/file.py
```

To list a directory tree:

```bash
hanzo-code directory_tree --path /path/to/project --depth 3
```

### Global Options

- `--allow-path PATH`: Add an allowed path (can be specified multiple times)
- `--project-dir DIR`: Set the project directory
- `--verbose`: Enable verbose output

### Available Operations

#### File Operations

- `read`: Read file(s)
- `write`: Write to a file
- `edit`: Edit a file
- `directory_tree`: Get directory tree
- `get_file_info`: Get file information
- `search_content`: Search for content in files
- `find_replace`: Find and replace content in files

#### Command Operations

- `run_command`: Run a shell command
- `run_script`: Run a script

#### Project Operations

- `analyze_project`: Analyze a project

#### Jupyter Operations

- `jupyter_read`: Read a Jupyter notebook
- `jupyter_edit`: Edit a Jupyter notebook

#### Vector Operations

- `vector_search`: Search the vector store
- `vector_index`: Index a file or directory in the vector store
- `vector_list`: List indexed documents in the vector store
- `vector_delete`: Delete documents from the vector store

#### Cursor Rules Operations

- `rule_check`: Check for cursor rules matching a query

#### MCP Server Operations

- `run_mcp`: Run MCP server operations

#### LLM.md Operations

- `llm_read`: Read LLM.md content
- `llm_update`: Update LLM.md content
- `llm_append`: Append a section to LLM.md

#### Symbol Operations (Tree-sitter based)

- `symbol_find`: Find symbols in a file or directory
- `symbol_references`: Find references to a symbol
- `ast_explore`: Explore the AST of a file
- `ast_query`: Query the AST of a file
- `symbolic_search`: Perform symbolic search in a project

## Examples

### Read a File

```bash
hanzo-code read --paths /path/to/file.py
```

### Run a Command

```bash
hanzo-code run_command --command "ls -la" --cwd /path/to/dir
```

### Analyze a Project

```bash
hanzo-code analyze_project --project-dir /path/to/project
```

### Search for Content

```bash
hanzo-code search_content --pattern "TODO" --path /path/to/project --file-pattern "*.py"
```

## Integration with Claude Desktop

To integrate the `hanzo-code` tool with Claude Desktop, you can use the `--install` option with the `hanzo-mcp` command:

```bash
hanzo-mcp --install --name hanzo-code --allow-path /path/to/project
```

This will register the hanzo-code CLI as an MCP server in Claude Desktop.
