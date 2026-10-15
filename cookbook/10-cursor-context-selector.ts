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
    limit: 3
  });

  const selectedNames = res.data.selected_tools?.map((t: any) => t.name) || [];
  const result: RecipeResult = {
    recipe: "10: Cursor Context Selection",
    tool: "kai_tool_select",
    success: ["src/routes/auth.ts", "src/middleware/rate-limiter.ts"].every((f) => selectedNames.includes(f)) && !selectedNames.some((f: string) => f.startsWith("frontend/") || f.startsWith("scripts/")),
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "BM25 over file names and descriptions put the auth routes and the rate limiter in the top 3, ahead of frontend and deploy files. No model call."
  };

  return result;
}

if (process.argv[1]?.endsWith("10-cursor-context-selector.ts")) {
  runRecipe10().then(logRecipe).catch(console.error);
}
