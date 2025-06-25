# Hanzo MCP

[![Open in Hanzo.App](https://img.shields.io/badge/Open%20in-Hanzo.App-8A2BE2?style=for-the-badge&logo=rocket)](https://hanzo.app/launch?repo=https://github.com/hanzoai/mcp)
[![Add Feature with Hanzo Dev](https://img.shields.io/badge/Add%20Feature-Hanzo%20Dev-00D4AA?style=for-the-badge&logo=plus)](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=feature)
[![Fix Bugs with Hanzo Dev](https://img.shields.io/badge/Fix%20Bugs-Hanzo%20Dev-FF6B6B?style=for-the-badge&logo=wrench)](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=bugfix)

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

### Core File Operations
| Tool              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `read`            | Read one or multiple files with encoding detection and line range support           |
| `write`           | Create or overwrite files with content                                              |
| `edit`            | Make precise line-based edits to existing files                                     |
| `multi_edit`      | Make multiple edits to a single file in one atomic operation                        |
| `directory_tree`  | Get a recursive tree view of directories with customizable depth and filters        |
| `content_replace` | Replace patterns in file contents using regex                                       |

### Search & Analysis
| Tool              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `grep`            | Fast pattern search across files using ripgrep                                      |
| `grep_ast`        | AST-aware code search that understands code structure                               |
| `unified_search`  | Intelligent multi-modal search combining text, vector, AST, and symbol search       |
| `vector_search`   | Semantic search across indexed documents and code                                   |
| `vector_index`    | Index documents and code in project-aware vector databases                          |

### Shell & Commands
| Tool              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `run_command`     | Execute shell commands with timeout, environment control, and session support       |

### Jupyter Support
| Tool              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `notebook_read`   | Read Jupyter notebook cells with outputs and metadata                               |
| `notebook_edit`   | Edit, insert, or delete cells in Jupyter notebooks                                  |

### Task Management
| Tool              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `todo_read`       | Read the current task list for tracking progress                                    |
| `todo_write`      | Create and manage structured task lists with status and priority                    |

### Advanced Tools
| Tool              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `think`           | Structured space for complex reasoning and analysis without making changes          |
| `dispatch_agent`  | Launch specialized sub-agents for concurrent task execution                         |
| `batch`           | Execute multiple tool calls in a single operation for performance                   |

For detailed documentation on all tools, see [TOOLS_DOCUMENTATION.md](./TOOLS_DOCUMENTATION.md).

## Getting Started

### 🚀 Try it Instantly in Hanzo.App

**No setup required!** Launch this project instantly in your browser:

[![Open in Hanzo.App](https://img.shields.io/badge/Launch%20Now-Hanzo.App-8A2BE2?style=for-the-badge&logo=rocket&logoColor=white)](https://hanzo.app/launch?repo=https://github.com/hanzoai/mcp)

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
make install-desktop ALLOWED_PATHS="/path/to/projects,/another/path" SERVER_NAME="hanzo"

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

**New contributors welcome!** 🎉 We've made it easy to contribute:

[![Contribute with Hanzo Dev](https://img.shields.io/badge/Contribute%20with-Hanzo%20Dev-00D4AA?style=for-the-badge&logo=code)](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=contribute)

**Traditional approach:**

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

**Or use Hanzo Dev for AI-assisted contributions:**
- [Launch in Hanzo.App](https://hanzo.app/launch?repo=https://github.com/hanzoai/mcp) for instant setup
- [Add new features](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=feature) with AI assistance
- [Fix bugs automatically](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=bugfix)

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
