# MCP Claude Code

An implementation of Claude Code capabilities using the Model Context Protocol (MCP).

## What's New in v0.1.1

- **Enhanced Command Execution**: Added improved command and script execution with better error handling and support for multiple shells (including Fish shell)
- **Script Language Support**: Run scripts in Python, JavaScript, TypeScript, Ruby, PHP, Perl, R, and more
- **Improved Error Reporting**: Better formatting of command outputs with clear error messages

See [Command Execution](docs/command_execution.md) documentation for details.

## Overview

This project provides an MCP server that implements Claude Code-like functionality, allowing Claude to directly execute instructions for modifying and improving project files. By leveraging the Model Context Protocol, this implementation enables seamless integration with various MCP clients including Claude Desktop.

## Features

- **Code Understanding**: Analyze and understand codebases through file access and pattern searching
- **Code Modification**: Make targeted edits to files with proper permission handling
- **Enhanced Command Execution**: Run commands and scripts in various languages with improved error handling and shell support
- **File Operations**: Create, move, and manage files with proper security controls
- **Code Discovery**: Find relevant files and code patterns across your project

## Tools Implemented

| Tool | Description | Permission Required |
| ---- | ----------- | ------------------- |
| `run_command` | Executes shell commands with enhanced error handling | Yes |
| `run_script` | Executes scripts with specified interpreters | Yes |
| `run_language_script` | Executes scripts in specific programming languages | Yes |
| `bash_tool` | Legacy tool for executing shell commands | Yes |
| `GlobTool` | Finds files based on pattern matching | No |
| `GrepTool` | Searches for patterns in file contents | No |
| `LSTool` | Lists files and directories | No |
| `FileReadTool` | Reads the contents of files | No |
| `FileEditTool` | Makes targeted edits to specific files | Yes |
| `FileWriteTool` | Creates or overwrites files | Yes |

## Getting Started

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/mcp-claude-code.git
cd mcp-claude-code

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -e .
```

### Usage

To start the MCP server:

```bash
python -m mcp_claude_code.server
```

To configure Claude Desktop to use this server, add the following to your Claude Desktop config file:

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
