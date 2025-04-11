# Hanzo MCP

An implementation of Hanzo capabilities using the Model Context Protocol (MCP).

## Overview

This project provides an MCP server that implements Hanzo-like functionality, allowing Claude to directly execute instructions for modifying and improving project files. By leveraging the Model Context Protocol, this implementation enables seamless integration with various MCP clients including Claude Desktop.

![example](./doc/example.gif)

## Features

- **Code Understanding**: Analyze and understand codebases through file access and pattern searching
- **Code Modification**: Make targeted edits to files with proper permission handling
- **Enhanced Command Execution**: Run commands and scripts in various languages with improved error handling and shell support
- **File Operations**: Manage files with proper security controls through shell commands
- **Code Discovery**: Find relevant files and code patterns across your project
- **Project Analysis**: Understand project structure, dependencies, and frameworks
- **Agent Delegation**: Delegate complex tasks to specialized sub-agents that can work concurrently
- **Multiple LLM Provider Support**: Configure any LiteLLM-compatible model for agent operations
- **Jupyter Notebook Support**: Read and edit Jupyter notebooks with full cell and output handling

## Tools Implemented

| Tool                   | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `read_files`           | Read one or multiple files with encoding detection                                            |
| `write_file`           | Create or overwrite files                                                                     |
| `edit_file`            | Make line-based edits to text files                                                           |
| `directory_tree`       | Get a recursive tree view of directories                                                      |
| `get_file_info`        | Get metadata about a file or directory                                                        |
| `search_content`       | Search for patterns in file contents                                                          |
| `content_replace`      | Replace patterns in file contents                                                             |
| `run_command`          | Execute shell commands (also used for directory creation, file moving, and directory listing) |
| `run_script`           | Execute scripts with specified interpreters                                                   |
| `script_tool`          | Execute scripts in specific programming languages                                             |
| `project_analyze_tool` | Analyze project structure and dependencies                                                    |
| `read_notebook`        | Extract and read source code from all cells in a Jupyter notebook with outputs                |
| `edit_notebook`        | Edit, insert, or delete cells in a Jupyter notebook                                           |
| `think`                | Structured space for complex reasoning and analysis without making changes                    |
| `dispatch_agent`       | Launch one or more agents that can perform tasks using read-only tools concurrently           |

## Getting Started

### Quick Install

```bash
# Install using uv
uv pip install hanzo-mcp

# Or using pip
pip install hanzo-mcp
```

For detailed installation and configuration instructions, please refer to [INSTALL.md](./doc/INSTALL.md).

Of course, you can also read [USEFUL_PROMPTS](./doc/USEFUL_PROMPTS.md) for some inspiration on how to use hanzo-mcp.

## Security

This implementation follows best practices for securing access to your filesystem:

- Permission prompts for file modifications and command execution
- Restricted access to specified directories only
- Input validation and sanitization
- Proper error handling and reporting

## Development

### Setup Development Environment

```bash
# Clone the repository
git clone https://github.com/hanzoai/mcp.git
cd mcp

# Install Python 3.13 using uv
make install-python

# Setup virtual environment and install dependencies
make setup

# Or install with development dependencies
make install-dev
```

### Testing

```bash
# Run tests
make test

# Run tests with coverage
make test-cov
```

### Building and Publishing

```bash
# Build package
make build

# Version bumping
make bump-patch    # Increment patch version (0.1.x → 0.1.x+1)
make bump-minor    # Increment minor version (0.x.0 → 0.x+1.0)
make bump-major    # Increment major version (x.0.0 → x+1.0.0)

# Publishing (creates git tag and pushes it to GitHub)
make publish                     # Publish using configured credentials in .pypirc
PYPI_TOKEN=your_token make publish  # Publish with token from environment variable

# Version bump and publish in one step (with automatic git tagging)
make publish-patch  # Bump patch version, publish, and create git tag
make publish-minor  # Bump minor version, publish, and create git tag
make publish-major  # Bump major version, publish, and create git tag

# Publish to Test PyPI
make publish-test
```

### Contributing

To contribute to this project:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
