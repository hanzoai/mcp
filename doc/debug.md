````markdown
# Debugging with Model Context Protocol Inspector

To debug your MCP project using the inspector tool, run the following command:

```bash
npx @modelcontextprotocol/inspector \
  uv \
  --directory ~/project/hanzo-mcp \
  run \
  claudecode \
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
````
