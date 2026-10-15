/**
 * Recipe 08: Tool-Name Resolution
 *
 * A model asks for `bash`, `read_file` or `git_status`; the client registers `Bash`, `Read` and `Git`.
 * kai_tool_select maps each request to a registered tool: a name the request spells in any case wins,
 * else BM25 over names and descriptions. No model call.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

const REGISTERED = [
  { name: "Bash", description: "Run a shell command" },
  { name: "Read", description: "Read a file from the workspace" },
  { name: "Edit", description: "Replace text in a file" },
  { name: "Git", description: "Git status, diff, log and blame" }
];
const WANT: Record<string, string> = { bash: "Bash", read_file: "Read", git_status: "Git" };

export async function runRecipe08(): Promise<RecipeResult> {
  const client = await createRecipeClient();
  const resolutions = [];
  let elapsed = 0;
  for (const [requested, expected] of Object.entries(WANT)) {
    const res = await client.callTool("kai_tool_select", { task: requested.replace(/_/g, " "), tools: REGISTERED, limit: 1 });
    elapsed += res.latency_ms;
    resolutions.push({ requested, resolved: res.data?.top_tool, source: res.data?.source, expected });
  }

  return {
    recipe: "08: Tool-Name Resolution",
    tool: "kai_tool_select",
    success: resolutions.every((r) => r.resolved === r.expected),
    latency_ms: elapsed,
    output: { resolutions },
    explanation: "bash -> Bash by name; read_file -> Read and git_status -> Git by BM25."
  };
}

if (process.argv[1]?.endsWith("08-claude-code-tool-resolution.ts")) {
  runRecipe08().then(logRecipe).catch(console.error);
}
