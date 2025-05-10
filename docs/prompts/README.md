# System Prompts

This directory contains system prompts for use with Hanzo MCP in different contexts.

## Available System Prompts

### MCP System Prompt

**File:** `mcp_system_prompt.txt`

This is the main system prompt used for general MCP interactions. It provides a comprehensive framework for AI assistants to help with software engineering tasks, including:

- A structured workflow for handling requests
- Guidelines for using various tools
- Patterns for approaching different types of problems
- Git workflow recommendations
- Design principles

Use this prompt when working with Hanzo MCP through the command line, API, or Claude Desktop.

### IDE System Prompt

**File:** `ide_system_prompt.txt`

This prompt is specifically designed for integration with IDE environments. It differs from the standard MCP prompt in a few key ways:

- Focuses on making suggestions that the user can implement in their IDE
- Avoids direct file modifications in favor of detailed implementation guidance
- Provides a structured format for code suggestions
- Emphasizes readability and context for IDE integration

Use this prompt when working with IDE extensions or plugins that support the MCP protocol.

## Using System Prompts

To use these prompts with Hanzo MCP:

1. For command line usage:
   ```bash
   hanzo-mcp --system-prompt /path/to/prompt/file.txt --allow-path /path/to/your/project
   ```

2. For Claude Desktop integration:
   - Use the prompt file when configuring the Hanzo MCP server in Claude Desktop settings

3. For API integration:
   - Provide the prompt content in the appropriate API parameter when establishing a connection

## Customizing Prompts

When using these prompts with your own projects, replace these placeholders:

- `{project_path}`: The absolute path to your project
- `{repo name}`: Your repository name
- `{git user name}`: Your Git username

You can further customize the prompts to match your project's specific needs and workflow preferences.
