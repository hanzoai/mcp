## Getting Started

### Usage

#### Configuring Claude Desktop

You can run it with `uvx run mcp-claude-code` without installation. Configure Claude Desktop to use this server by adding the following to your Claude Desktop configuration file:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "uvx",
      "args": [
        "--from",
        "mcp-claude-code",
        "claudecode",
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
    "claude-code": {
      "command": "uvx",
      "args": [
        "--from",
        "mcp-claude-code",
        "claudecode",
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