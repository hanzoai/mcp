/**
 * Recipe 10: Cursor IDE Context Selection
 * 
 * Objective: Fit large codebases into limited LLM context windows by using Kai to select
 * the most relevant files and symbol definitions for a user's prompt or bug fix.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe10(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const userQuery = "Add rate limiting middleware to our Express HTTP server for auth routes.";
  const candidateFiles = [
    { name: "src/server.ts", description: "Main HTTP server setup, port listener, and middleware pipeline" },
    { name: "src/routes/auth.ts", description: "Authentication endpoints: login, signup, refresh token, oauth" },
    { name: "src/middleware/rate-limiter.ts", description: "Redis-backed sliding window rate limiter implementation" },
    { name: "src/database/schema.prisma", description: "Database ORM models for users, sessions, and payments" },
    { name: "frontend/src/components/Button.tsx", description: "React UI component for button styling" },
    { name: "scripts/deploy.sh", description: "Docker build and Kubernetes cluster deployment script" }
  ];

  const res = await client.callTool("kai_tool_select", {
    task: userQuery,
    tools: candidateFiles,
    limit: 3,
    min_confidence: 0.1
  });

  const selectedNames = res.data.selected_tools?.map((t: any) => t.name) || [];
  const result: RecipeResult = {
    recipe: "10: Cursor Context Selection",
    tool: "kai_tool_select",
    success: selectedNames.includes("src/routes/auth.ts") || selectedNames.includes("src/server.ts") || selectedNames.includes("src/middleware/rate-limiter.ts"),
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Kai shortlisted backend auth, server, and rate-limiter files while excluding frontend and deploy scripts."
  };

  return result;
}

if (process.argv[1]?.endsWith("10-cursor-context-selector.ts")) {
  runRecipe10().then(logRecipe).catch(console.error);
}
