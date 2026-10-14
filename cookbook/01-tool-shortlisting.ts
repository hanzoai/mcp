/**
 * Recipe 01: Agent Tool Shortlisting
 * 
 * Objective: Reduce large registered tool registries (20+ tools) down to the top 3-5
 * most relevant tools for a specific software engineering task, reducing prompt token costs
 * and eliminating tool confusion.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe01(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const task = "Search git commit history for the author who modified auth tokens, and create an issue.";
  const candidateTools = [
    { name: "Git", description: "Query git repository history, diffs, blame, and logs" },
    { name: "Tracker", description: "Manage project issues, tickets, and boards" },
    { name: "Bash", description: "Execute arbitrary bash terminal commands" },
    { name: "Read", description: "Read contents of an existing file" },
    { name: "Edit", description: "Modify parts of an existing file" },
    { name: "Gimp", description: "Image manipulation and visual graphics generation" },
    { name: "Browser", description: "Control browser for web scraping and UI testing" },
    { name: "Fetch", description: "Execute raw HTTP requests to external APIs" }
  ];

  const res = await client.callTool("kai_tool_select", {
    task,
    tools: candidateTools,
    limit: 3,
    min_confidence: 0.15
  });

  const result: RecipeResult = {
    recipe: "01: Agent Tool Shortlisting",
    tool: "kai_tool_select",
    success: !res.isError && res.data.top_tool === "Git",
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Kai ranked Git and Tracker as top tools while filtering out unrelated image/browser tools."
  };

  return result;
}

if (process.argv[1]?.endsWith("01-tool-shortlisting.ts")) {
  runRecipe01().then(logRecipe).catch(console.error);
}
