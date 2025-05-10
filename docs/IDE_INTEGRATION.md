# IDE Integration Guide

This document provides information about integrating Hanzo MCP with various IDEs and development environments.

## Using Hanzo MCP with IDE Assistants

Hanzo MCP can be used with AI assistants integrated into your IDE, such as GitHub Copilot, VSCode AI assistants, and JetBrains AI Assistant with the appropriate MCP model.

### System Prompt for IDE Integration

When using an IDE-based assistant with the MCP protocol, you might want to use a specialized system prompt. The following prompt is designed specifically for IDE integration scenarios:

```
You are an assistant that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

<goal>
I hope you can assist me with the project.
- {project_path}
</goal>

<project_info>
repo: {repo name}
owner: {git user name}
</project_info>

<standard_flow>
1. Understand: Analyze the request in the context of the project's architecture and constraints by rereading **LLM.md**
2. Plan: Propose a solution strategy with rationale and expected outcomes
3. **Confirm**: Describe your plan to the user and obtain permission before executing it
4. Suggest: Provide detailed suggestions for implementations that the user can apply in their IDE
5. Validate: Help verify changes achieve the intended outcome when user confirms they've been made
6. Learn: Document insights for future reference
</standard_flow>

<knowledge_continuity>
- At start, read "project_path/LLM.md" in project.
- If found: Read it as context for the current session
- If not found:
1. Conduct project architecture and pattern analysis
2. Generate a comprehensive LLM.md capturing key insights
3. Provide the content for the user to add to the project
Update LLM.md when:
- New architectural patterns are discovered
- Important implementation decisions are made
- Project structure evolves significantly
- Before updating, briefly describe proposed changes and reason
DO NOT Commit LLM.md
</knowledge_continuity>
```

The complete system prompt can be found in the `ide_prompt` file in the docs directory.

## Setting Up Hanzo MCP for IDE Integration

To use Hanzo MCP with your IDE:

1. Install Hanzo MCP:
   ```bash
   uv pip install hanzo-mcp
   ```

2. Configure and run the MCP server:
   ```bash
   hanzo-mcp --allow-path /path/to/your/projects
   ```

3. Configure your IDE's AI assistant to use the Hanzo MCP endpoint (usually `http://localhost:8000`).

## IDE-Specific Instructions

### Visual Studio Code

For VS Code, you can use the Claude extension with appropriate configuration to connect to the local MCP server.

### JetBrains IDEs

JetBrains IDEs like IntelliJ IDEA, PyCharm, and others can use the AI Assistant plugin, which supports local MCP servers.

### Command-Line Integration

If your IDE doesn't directly support MCP, you can use the command-line interface alongside your IDE:

```bash
hanzo-mcp --allow-path /path/to/your/projects --serve --port 8000
```

Then configure your AI assistant to connect to this endpoint.

## Debugging IDE Integration Issues

If you encounter issues with IDE integration:

1. Check that the MCP server is running with the correct allowed paths
2. Verify your IDE AI assistant is configured to use the correct endpoint
3. Look for permission issues (the MCP server must have access to the project files)
4. For detailed debugging, use the MCP inspector tool:
   ```bash
   npx @modelcontextprotocol/inspector uv --directory ~/project/hanzo-mcp
   ```
