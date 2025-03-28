# Hanzo MCP

Hanzo AI + Platform capabilities via the Model Context Protocol (MCP).

<a href="https://glama.ai/mcp/servers/@hanzoai/mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@hanzoai/mcp/badge" />
</a>

## Overview

This project provides an MCP server that enables access to Hanzo APIs and Platform capabilities, as well as providing development tools for managing and improving projects. By leveraging the Model Context Protocol, this server enables seamless integration with various MCP clients including Claude Desktop, allowing LLMs to directly access Hanzo's platform functionality.

![example](./doc/example.gif)

## Features

- **Code Understanding**: Analyze and understand codebases through file access and pattern searching
- **Code Modification**: Make targeted edits to files with proper permission handling
- **Enhanced Command Execution**: Run commands and scripts in various languages with improved error handling and shell support
- **File Operations**: Manage files with proper security controls through shell commands
- **Code Discovery**: Find relevant files and code patterns across your project
- **Project Analysis**: Understand project structure, dependencies, and frameworks
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
| `project_analyze_tool` | Analyze project structure and dependencies                                                   |
| `rule_check`          | Search for and retrieve cursor rules that define AI coding standards for specific technologies |
| `run_mcp`            | Manage and interact with multiple MCP servers (browser automation, Slack, GitHub, etc.)      |
| `read_notebook`        | Extract and read source code from all cells in a Jupyter notebook with outputs               |
| `edit_notebook`        | Edit, insert, or delete cells in a Jupyter notebook                                         |
| `think`                | Structured space for complex reasoning and analysis without making changes                    |

## Getting Started

### Usage

#### Configuring Claude Desktop

You can run it with `uvx run hanzo-mcp` without installation. Configure Claude Desktop to use this server by adding the following to your Claude Desktop configuration file:

```json
{
  "mcpServers": {
    "hanzo": {
      "command": "uvx",
      "args": [
        "--from",
        "hanzo-mcp",
        "hanzo-mcp",
        "--allow-path",
        "/path/to/your/project"
      ]
    }
  }
}
```

Make sure to replace `/path/to/your/project` with the actual path to the project you want Claude to access.

#### Advanced Configuration Options

You can customize the server using other options:

```json
{
  "mcpServers": {
    "hanzo": {
      "command": "uvx",
      "args": [
        "--from",
        "hanzo-mcp",
        "hanzo-mcp",
        "--allow-path",
        "/path/to/project",
        "--name",
        "custom-hanzo",
        "--transport",
        "stdio"
      ]
    }
  }
}
```

#### Using with External MCP Servers

Hanzo MCP can integrate with other MCP servers like iTerm2-MCP or Neovim-MCP. You can enable and manage these servers in several ways:

1. **Using the command line**:

```bash
# Directly specify MCP server commands
uvx run hanzo-mcp --allow-path /path/to/project --mcp="npx -y iterm-mcp" --mcp="npx -y @bigcodegen/mcp-neovim-server"

# Or use the management UI
uvx run hanzo-mcp-servers ui
```

2. **Using the registry**:

```bash
# View available servers
uvx run hanzo-mcp-servers registry search

# Install a server from the registry
uvx run hanzo-mcp-servers registry install iterm2
```

### Configuring Claude Desktop System Prompt

To get the best experience with Hanzo MCP, you need to add the provided system prompt to your Claude Desktop client. This system prompt guides Claude through a structured workflow for interacting with Hanzo platform services and managing project files.

Follow these steps:

1. Locate the system prompt file in this repository at `doc/system_prompt`
2. Open your Claude Desktop client
3. Create a new project or open an existing one
4. Navigate to the "Project instructions" section in the Claude Desktop sidebar
5. Copy the contents of `doc/system_prompt` and paste it into the "Project instructions" section
6. Replace `{project_path}` with the actual absolute path to your project

The system prompt provides Claude with:

- A structured workflow for analyzing and modifying code
- Best practices for project exploration and analysis
- Guidelines for development, refactoring, and quality assurance
- Special formatting instructions for mathematical content

This step is crucial as it enables Claude to follow a consistent approach when helping you with code modifications.

## Cursor Rules Support

Hanzo MCP includes support for [Cursor Rules](https://cursor.sh/), which allow you to define custom guidelines for AI-generated code. These rules help ensure that code generation follows your project's specific best practices and coding standards.

### How It Works

1. **Built-in Rules**: The package comes pre-installed with rules for common technologies like JavaScript, TypeScript, Python, and their frameworks.

2. **Project-Specific Rules**: You can create your own `.cursorrules` or `.rules` files in your project directory.

3. **Rules Format**: Rules files support YAML frontmatter with metadata about the rules, followed by markdown-formatted guidelines.

```
---
name: My Custom Rules
description: Custom rules for my project
technologies:
  - JavaScript
  - React
focus:
  - frontend
---

# My Custom Rules

## Code Style
1. Use functional components with hooks
2. Follow naming conventions...
```

### Using the Rule Check Tool

You can search for and retrieve rules using the `rule_check` operation in the `dev` tool:

```python
result = await dev(
    ctx,
    operation="rule_check",
    query="react",             # Search for React-related rules
    project_dir="/path/to/project",  # Optional: look in project directory
    include_preinstalled=True,      # Include built-in rules
    detailed=False                  # Set to True for full rule content
)
```

This helps AI assistants like Claude follow your project's coding standards and best practices when generating or modifying code.

## Sub-MCP Servers Support

Hanzo MCP can integrate with and manage multiple specialized MCP servers, providing a unified interface to a wide range of capabilities:

### Built-in Server Support

1. **Browser Automation**: The `browser-use` server allows Claude to control a web browser, navigate to URLs, click buttons, fill forms, and more.

2. **Computer Use**: The `computer-use` server (disabled by default) provides full computer access capabilities.

3. **Service Integrations**: Automatically enabled when API keys are available:
   - **Slack**: Interact with Slack channels and messages
   - **GitHub**: Manage repositories, issues, and pull requests
   - **Linear**: Work with tickets and project management

### Using the Run MCP Tool

Manage and interact with sub-MCP servers using the `run_mcp` operation in the `dev` tool:

```python
# List available MCP servers
result = await dev(ctx, operation="run_mcp", subcommand="list")

# Start a specific MCP server
result = await dev(ctx, operation="run_mcp", subcommand="start", server_name="browser-use")

# Get info about a server
result = await dev(ctx, operation="run_mcp", subcommand="info", server_name="browser-use")

# Add a custom MCP server
result = await dev(
    ctx, 
    operation="run_mcp", 
    subcommand="add",
    name="custom-server",
    command="uvx",
    args=["my-custom-mcp-server"],
    env={"API_KEY": "your-api-key"}
)
```

When enabled, these additional MCP servers allow Claude to perform a much wider range of tasks without requiring those capabilities to be implemented in the main MCP server.

## Meta MCP Server

For advanced users who want to run multiple MCP servers simultaneously, we provide a `MetaMCPServer` that seamlessly orchestrates a main MCP server and multiple sub-MCP servers:

### Features

- **Unified Interface**: Manage everything through a single entry point
- **Automatic Configuration**: Detect and initialize servers based on available API keys
- **Asynchronous Operations**: All server operations use asyncio for smooth performance
- **Dynamic Tool Discovery**: Automatically expose tools from all running sub-servers

### Installation

Install with all optional dependencies:

```bash
pip install hanzo-mcp[all]  # Includes all optional dependencies
```

Or install just what you need:

```bash
pip install hanzo-mcp[subservers]  # Just sub-server support
pip install hanzo-mcp[rules]       # Just rules support
pip install hanzo-mcp[vector]      # Just vector store support
```

### Command-Line Usage

```bash
hanzo-meta-mcp --allow-path /path/to/project [options]
```

Options:
- `--name`: Name of the server (default: "hanzo-meta")
- `--transport`: Transport to use (stdio or sse, default: stdio)
- `--allow-path`: Paths to allow access to (can be specified multiple times)
- `--config`: Path to a configuration file (JSON)
- `--disable-proxy-tools`: Disable proxy tools for sub-MCP servers
- `--disable-auto-start`: Disable automatic starting of sub-MCP servers

### Configuration File

You can define your Meta MCP Server configuration in a JSON file:

```json
{
  "mcp": {
    "name": "hanzo-meta"
  },
  "sub_mcps": {
    "browser-use": {
      "enabled": "auto",
      "command": "uvx",
      "args": ["mcp-server-browser-use"],
      "env": {
        "CHROME_PATH": "/path/to/chrome"
      }
    },
    "github": {
      "enabled": "auto",
      "command": "uvx",
      "args": ["mcp-server-github"],
      "env": {
        "GITHUB_TOKEN": "your-github-token"
      }
    }
  }
}
```

### Programmatic Usage

You can also use the `MetaMCPServer` programmatically in your own Python scripts:

```python
import asyncio
from hanzo_mcp.meta_mcp import MetaMCPServer

async def main():
    # Create the Meta MCP Server
    meta_server = MetaMCPServer(
        name="hanzo-meta",
        allowed_paths=["/path/to/project"],
        sub_mcps_config={
            "browser-use": {
                "enabled": "true",
                "command": "uvx",
                "args": ["mcp-server-browser-use"]
            }
        }
    )
    
    # Start sub-MCP servers
    await meta_server.start()
    
    # Run the server
    meta_server.run()

# Run the async main function
if __name__ == "__main__":
    asyncio.run(main())
```

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
