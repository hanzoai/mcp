# MCP Claude Code

An implementation of Claude Code capabilities using the Model Context Protocol (MCP).

## Overview

This project provides an MCP server that implements Claude Code-like functionality, allowing Claude to directly execute instructions for modifying and improving project files. By leveraging the Model Context Protocol, this implementation enables seamless integration with various MCP clients including Claude Desktop.

## Features

- **Code Understanding**: Analyze and understand codebases through file access and pattern searching
- **Code Modification**: Make targeted edits to files with proper permission handling
- **Enhanced Command Execution**: Run commands and scripts in various languages with improved error handling and shell support
- **File Operations**: Manage files with proper security controls through shell commands
- **Code Discovery**: Find relevant files and code patterns across your project
- **Project Analysis**: Understand project structure, dependencies, and frameworks

## Tools Implemented

| Tool                       | Description                                                                                   | Permission Required |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| `read_files`               | Read one or multiple files with encoding detection                                            | No                  |
| `write_file`               | Create or overwrite files                                                                     | Yes                 |
| `edit_file`                | Make line-based edits to text files                                                           | Yes                 |
| `directory_tree`           | Get a recursive tree view of directories                                                      | No                  |
| `get_file_info`            | Get metadata about a file or directory                                                        | No                  |
| `search_content`           | Search for patterns in file contents                                                          | No                  |
| `content_replace`          | Replace patterns in file contents                                                             | Yes                 |
| `run_command`              | Execute shell commands (also used for directory creation, file moving, and directory listing) | Yes                 |
| `run_script`               | Execute scripts with specified interpreters                                                   | Yes                 |
| `script_tool`              | Execute scripts in specific programming languages                                             | Yes                 |
| `project_analyze_tool`     | Analyze project structure and dependencies                                                    | No                  |

## Getting Started

### Installation

The project requires Python 3.13 or newer.

#### Option 1: Install from PyPI (Recommended)

You can install MCP Claude Code directly from PyPI:

```bash
# Create a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install with pip
pip install mcp-claude-code

# Or with uv
uv pip install mcp-claude-code
```

To install optional extras:

```bash
# For performance enhancements
pip install mcp-claude-code[performance]
```

#### Option 2: Install from Source

If you prefer to install from source:

```bash
# Clone the repository
git clone https://github.com/SDGLBL/mcp-claude-code.git
cd mcp-claude-code

# Create a virtual environment first
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install using make
make install
```

The Makefile will automatically detect if you have `uv` installed and use it; otherwise, it will fall back to `pip`.

If you encounter an error about no virtual environment found:

```
error: No virtual environment found; run `uv venv` to create an environment, or pass `--system` to install into a non-virtual environment
```

Make sure to create and activate a virtual environment before running `make install`.

#### For Development

If you're developing or contributing to the project, you can install additional dependencies:

```bash
make install-dev  # Install development dependencies
make install-test  # Install testing dependencies
```

### Testing

The project includes a comprehensive test suite. To run the tests:

```bash
# Run all tests
make test

# Run tests with coverage report
make test-cov
```

The Makefile will automatically create and use a virtual environment (.venv) if one doesn't exist. It's designed to work on both Unix-based systems (macOS, Linux) and Windows environments.

### Usage

#### Configuring Claude Desktop

After installing mcp-claude-code, configure Claude Desktop to use this server by adding it to your Claude Desktop config file:

##### When installed from PyPI:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "claudecode",
      "args": [
        "--allow-path",
        "/path/to/your/project"
      ]
    }
  }
}
```

##### When installed from source:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "python",
      "args": [
        "-m",
        "mcp_claude_code.server",
        "--allow-path",
        "/path/to/your/project"
      ]
    }
  }
}
```

Make sure to replace `/path/to/your/project` with the actual path to the project you want Claude to have access to.

#### Advanced Configuration Options

You can customize the server with additional options:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "claudecode",  // or "python -m mcp_claude_code.server" if installed from source
      "args": [
        "--allow-path",
        "/path/to/project",
        "--name",
        "custom-claude-code",
        "--transport",
        "stdio"
      ]
    }
  }
}
```

### Configuring Claude Desktop System Prompt

To get the best experience with Claude Code, you need to add the provided system prompt to your Claude Desktop client. This system prompt guides Claude through a structured workflow for code modifications and project management.

Follow these steps:

1. Locate the system prompt file in this repository at `doc/system_prompt.md`
2. Open your Claude Desktop client settings
3. Navigate to the system prompt configuration section
4. Copy the contents of `system_prompt.md` into your Claude Desktop system prompt
5. Replace `{{project_path}}` with the actual path to your project

The system prompt provides Claude with:

- A structured workflow for analyzing and modifying code
- Best practices for project exploration and analysis
- Guidelines for development, refactoring, and quality assurance
- Special formatting instructions for mathematical content

This step is crucial as it enables Claude to follow a consistent approach when helping you with code modifications.

## Security

This implementation follows best practices for securing access to your filesystem:

- Permission prompts for file modifications and command execution
- Restricted access to specified directories only
- Input validation and sanitization
- Proper error handling and reporting

## Development

To contribute to this project:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

