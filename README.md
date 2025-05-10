# Hanzo MCP

An implementation of Hanzo capabilities using the Model Context Protocol (MCP).

## Overview

This project provides an MCP server that implements Hanzo-like functionality, allowing Claude to directly execute instructions for modifying and improving project files. By leveraging the Model Context Protocol, this implementation enables seamless integration with various MCP clients including Claude Desktop.

![example](./docs/example.gif)

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

### Claude Desktop Integration

To install and configure hanzo-mcp for use with Claude Desktop:

```bash
# Install the package globally
uv pip install hanzo-mcp

# Install configuration to Claude Desktop with default settings
hanzo-mcp --install
```

For development, if you want to install your local version to Claude Desktop:

```bash
# Clone and navigate to the repository
git clone https://github.com/hanzoai/mcp.git
cd mcp

# Install and configure for Claude Desktop
make install-desktop

# With custom paths and server name
make install-desktop ALLOWED_PATHS="/path/to/projects,/another/path" SERVER_NAME="hanzo-dev"

# Disable write tools (useful if you prefer using your IDE for edits)
make install-desktop DISABLE_WRITE=1
```

After installation, restart Claude Desktop. You'll see "hanzo" (or your custom server name) available in the MCP server dropdown.

For detailed installation and configuration instructions, please refer to the [documentation](./docs/).

Of course, you can also read [USEFUL_PROMPTS](./docs/USEFUL_PROMPTS.md) for some inspiration on how to use hanzo-mcp.

## Security

This implementation follows best practices for securing access to your filesystem:

- Permission prompts for file modifications and command execution
- Restricted access to specified directories only
- Input validation and sanitization
- Proper error handling and reporting

## Documentation

Comprehensive documentation is available in the [docs](./docs/) directory. You can build and view the documentation locally:

```bash
# Build the documentation
make docs

# Start a local server to view the documentation
make docs-serve
```

Then open http://localhost:8000/ in your browser to view the documentation.

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

# Manual version bumping (alternative to make commands)
python -m scripts.bump_version patch  # Increment patch version
python -m scripts.bump_version minor  # Increment minor version
python -m scripts.bump_version major  # Increment major version

# Publishing (creates git tag and pushes it to GitHub)
make publish                     # Publish using configured credentials in .pypirc
PYPI_TOKEN=your_token make publish  # Publish with token from environment variable

# Publishing (creates git tag, pushes to GitHub, and publishes to PyPI)
make patch    # Bump patch version, build, publish, create git tag, and push
make minor    # Bump minor version, build, publish, create git tag, and push
make major    # Bump major version, build, publish, create git tag, and push

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
