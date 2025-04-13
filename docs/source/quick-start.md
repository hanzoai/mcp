# Quick Start Guide

This guide will help you get started with Hanzo MCP quickly.

## Basic Usage

After [installing](installation.md) Hanzo MCP, you can start using it with the following steps:

1. Start the MCP server:

```bash
hanzo-mcp --allow-path /path/to/your/project
```

2. Configure your AI assistant to use the MCP server.

## Advanced Configuration

### LLM Model and Token Configuration

You can customize the agent behavior by specifying the LLM model and token limits:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "uvx",
      "args": [
        "--from",
        "hanzo-mcp",
        "hanzo-mcp",
        "--allow-path",
        "/path/to/project",
        "--enable-agent-tool",
        "--agent-model",
        "{litellm-model-name}",
        "--agent-max-tokens",
        "100000",
        "--agent-api-key",
        "{your-api-key}",
        "--agent-max-tool-uses",
        "30",
        "--agent-max-iterations",
        "10"
      ]
    }
  }
}
```

### Available Configuration Options

The available LLM configuration options are:

- `--agent-model`: Specify the model name in LiteLLM format (e.g., 'openai/gpt-4o', 'anthropic/claude-3-sonnet')
- `--agent-max-tokens`: Specify the maximum tokens for agent responses
- `--agent-api-key`: Specify the API key for the LLM provider (for development/testing only)
- `--agent-max-iterations`: Maximum number of iterations for agent (default: 10)
- `--agent-max-tool-uses`: Maximum number of total tool uses for agent (default: 30)
- `--enable-agent-tool`: Enable the agent tool (disabled by default)

### Model Name Formats

The model name uses the LiteLLM format with provider prefixes. Examples:

- OpenAI models: `openai/gpt-4o`, `openai/gpt-4o-mini`
- Anthropic models: `anthropic/claude-3.7-sonnet`
- Google models: `openrouter/google/gemini-2.0-flash-001` (Recommended)

## Configuring System Prompt

To get the best experience with Hanzo, you should configure the system prompt in your AI assistant:

1. Locate the system prompt file in the repository at `doc/system_prompt`
2. Add it to your AI assistant's system prompt or project instructions
3. Replace `{project_path}` in the prompt with the absolute path to your project

The system prompt provides your AI assistant with:

- A structured workflow for analyzing and modifying code
- Best practices for project exploration and analysis
- Guidelines for development, refactoring, and quality assurance
- Special formatting instructions for mathematical content

## Next Steps

- Learn about [IDE integration](ide-integration.md) for using Hanzo MCP with your favorite editor
- Check out [debugging techniques](debugging.md) for troubleshooting
- Review [security considerations](security.md) for safe usage