# Debugging Guide

This guide provides instructions for debugging your Hanzo MCP projects.

## Using Model Context Protocol Inspector

The Model Context Protocol Inspector is a powerful tool for debugging MCP-enabled applications. It allows you to see the interactions between the AI assistant and the MCP server, including all tool calls and responses.

### Running the Inspector

To debug your MCP project using the inspector tool, run the following command:

```bash
npx @modelcontextprotocol/inspector \
  uv \
  --directory ~/project/hanzo-mcp \
  run \
  hanzo-mcp \
  --allow-path \
  {allow path} \
  "--agent-model" \
  "openrouter/google/gemini-2.0-flash-001" \
  "--agent-max-tokens" \
  "100000" \
  "--agent-api-key" \
  "{api key}" \
  "--enable-agent-tool" \
  "--agent-max-iterations" \
  "30" \
  "--agent-max-tool-uses" \
  "100" \
```

Replace the following parameters with your actual values:
- `{allow path}`: The path to your project that you want to give access to
- `{api key}`: Your API key for the LLM provider

### What the Inspector Shows

The inspector provides a detailed view of:

1. All messages between the AI assistant and the MCP server
2. Tool calls made by the AI assistant
3. Responses from the MCP server
4. Errors that occur during execution

### Common Debugging Scenarios

#### 1. Permission Errors

If you're encountering permission errors, check:
- That the `--allow-path` parameter points to the correct directory
- That you have the necessary file system permissions
- That you're not attempting to access files outside the allowed path

#### 2. Tool Execution Failures

If tools are failing to execute properly:
- Check that the required tools are enabled
- Verify that the tool parameters are correctly formatted
- Look for any error messages in the inspector output

#### 3. Agent Tool Issues

If you're using the agent tool and encountering problems:
- Ensure you've enabled it with `--enable-agent-tool`
- Check the agent parameters (model, max tokens, etc.)
- Verify your API key is correct and has sufficient permissions

## Logging

You can enable verbose logging by setting the `DEBUG` environment variable:

```bash
DEBUG=* hanzo-mcp --allow-path /path/to/your/project
```

This will output detailed logs that can help pinpoint issues.

## Getting Help

If you're still encountering issues, you can:
- Check the [GitHub repository](https://github.com/hanzoai/mcp) for open issues
- Join the community discussion on [Discord](https://discord.gg/hanzo)
- Submit a new issue with detailed information about your problem