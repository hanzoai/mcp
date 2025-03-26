# MCP Claude Code: Project Documentation

## Project Overview

MCP Claude Code implements Claude Code capabilities using the Model Context Protocol (MCP). This project provides an MCP server enabling Claude to execute file system operations, command executions, and project analysis tasks, similar to Claude Code functionality.

## Core Architecture

The project consists of these key components:

1. **MCP Server**: FastMCP-based implementation of the Model Context Protocol
2. **Tool Categories**:
   - **File System Operations**: Read, write, edit, search, and manage files
   - **Shell Command Execution**: Run commands and scripts in various languages
   - **Project Analysis**: Analyze project structure and dependencies
   - **Thinking Tool**: Support for structured reasoning during complex tasks
3. **Permission System**: Security layer controlling access to file system and command execution
4. **Context Management**: Tracks document and project state during operations

## Exposed Tools

| Tool                   | Description                                | Permission Required |
| ---------------------- | ------------------------------------------ | ------------------- |
| `read_files`           | Read one or multiple files                 | No                  |
| `write_file`           | Create or overwrite files                  | Yes                 |
| `edit_file`            | Line-based text file edits                 | Yes                 |
| `directory_tree`       | Get recursive directory tree               | No                  |
| `get_file_info`        | Get file/directory metadata                | No                  |
| `search_content`       | Search file contents                       | No                  |
| `content_replace`      | Replace patterns in files                  | Yes                 |
| `run_command`          | Execute shell commands                     | Yes                 |
| `run_script`           | Execute scripts with interpreters          | Yes                 |
| `script_tool`          | Execute scripts in specific languages      | Yes                 |
| `project_analyze_tool` | Analyze project structure and dependencies | No                  |
| `read_notebook`        | Read and format Jupyter notebooks          | No                  |
| `edit_notebook`        | Edit Jupyter notebook cells                | Yes                 |
| `think`                | Structured thinking space                  | No                  |

## Tool Architecture

The tools system uses a modular, object-oriented architecture with a consistent pattern:

1. **Base Classes**:
   - `BaseTool`: Abstract interface for all tools, defining common methods and properties
   - `FileSystemTool`: Base class for filesystem operations with permission handling
   - `ShellBaseTool`: Base class for shell command execution
   - `ProjectBaseTool`: Base class for project analysis
   - `JupyterBaseTool`: Base class for Jupyter notebook operations
2. **Implementation Classes**:

   - Each tool has its own dedicated class (e.g., `ReadFilesTool`, `RunCommandTool`)
   - Tool parameters, validation, and execution are encapsulated in the class
   - Tools follow a consistent interface for parameter definitions and execution logic
   - Each tool independently handles its own validation and error handling

3. **Module Organization**:

   - Tools are organized into modules by category (filesystem, shell, jupyter, project)
   - Each module has its own `__init__.py` that exports all tool classes
   - Module boundaries match functional boundaries for better separation of concerns

4. **Registration System**:
   - `ToolRegistry`: Static class for registering tools with the MCP server
   - Each module has its own `register_*_tools` function (e.g., `register_filesystem_tools`)
   - Module registration functions instantiate and register all tools in that category
   - The main `register_all_tools` function coordinates registration across all modules

## Thinking Tool Implementation

The "think" tool provides Claude with a dedicated space for structured thinking during complex tasks, based on Anthropic's research showing improved performance for complex tool-based interactions.

### Benefits

- Enhanced reasoning for multi-step tasks
- Improved policy adherence and verification
- Better analysis of tool outputs
- Effective debugging support
- Transparent decision-making

### When to Use

- Before executing operations to plan approach
- After receiving tool outputs to analyze results
- When breaking down complex requirements
- When verifying against project constraints
- When debugging issues in previous steps

## Security Features

- Path validation and sanitization
- Command filtering to prevent dangerous operations
- Permission checks for file operations
- Timeout limits for command execution

## Shell Environment Support

All command execution tools support:

- Login shell loading user profiles (e.g., `~/.zshrc`, `~/.bashrc`)
- Automatic shell detection (Zsh, Bash, Fish, etc.)
- Custom environment variables

Example usage:

```python
# Run with user's environment
result = await run_command("npm install", "/path/to/project", use_login_shell=True)
```

## Project Structure

```
mcp-claude-code/
├── mcp_claude_code/        # Main package
│   ├── cli.py              # Command-line interface
│   ├── server.py           # MCP server implementation
│   └── tools/              # Tool implementations
│       ├── common/         # Shared utilities
│       │   ├── base.py     # Base tool classes
│       │   ├── context.py  # Context management
│       │   ├── permissions.py # Permission handling
│       │   └── thinking_tool.py # Thinking tool implementation
│       ├── filesystem/     # File system tools
│       │   ├── base.py     # Filesystem base classes
│       │   ├── read_files.py # Read files tool
│       │   ├── write_file.py # Write file tool
│       │   └── ...         # Other filesystem tools
│       ├── jupyter/        # Jupyter notebook tools
│       │   ├── base.py     # Jupyter notebook base classes
│       │   ├── read_notebook.py # Read notebook tool
│       │   └── edit_notebook.py # Edit notebook tool
│       ├── project/        # Project analysis tools
│       │   ├── base.py     # Project base classes
│       │   ├── analysis.py # Project analysis utilities
│       │   └── project_analyze.py # Project analyze tool
│       └── shell/          # Command execution tools
│           ├── base.py     # Shell base classes
│           ├── command_executor.py # Command execution utilities
│           ├── run_command.py # Run command tool
│           ├── run_script.py # Run script tool
│           └── script_tool.py # Script language tool
```

## Usage

```bash
# Basic usage
python -m mcp_claude_code.server

# With custom name
python -m mcp_claude_code.server --name "custom-code-server"

# With allowed path
python -m mcp_claude_code.server --allow-path /path/to/project
```

## Configuration with Claude Desktop

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "python",
      "args": ["-m", "mcp_claude_code.server"]
    }
  }
}
```

## Versioning and Release Process

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- **MAJOR version (x.0.0)**: Incompatible API changes
- **MINOR version (0.x.0)**: New backward-compatible functionality
- **PATCH version (0.0.x)**: Backward-compatible bug fixes

The release process is automated via GitHub Actions when tags are pushed.

## Supported Programming Languages

- Python (`.py`)
- JavaScript (`.js`)
- TypeScript (`.ts`)
- Bash (`.sh`)
- Fish (`.fish`)
- Ruby (`.rb`)
- PHP (`.php`)
- Perl (`.pl`)
- R (`.R`)

## Future Improvements

- Add more project analysis capabilities
- Extend language support for project-specific insights
- Implement additional security features
- Improve performance for large file operations
- Add support for more transport protocols
- Add connection pooling for remote operations
- ✅ Improve shell environment support (implemented)
- ✅ Add thinking tool to improve complex reasoning (implemented)
- ✅ Refactor tools to use modular OOP architecture (implemented)

