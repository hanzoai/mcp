/**
 * Recipe 13: Git Operation Security Guard
 * 
 * Objective: Protect git repositories by distinguishing safe local inspection commands
 * (git status, git diff) from destructive operations (git push --force, git reset --hard).
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe13(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const commands = [
    { cmd: "git status --porcelain", expected: "allow" },
    { cmd: "git diff HEAD~1", expected: "allow" },
    { cmd: "git reset --hard origin/main", expected: "ask" },
    { cmd: "git push --force origin main", expected: "ask" }
  ];

  const verdicts: Record<string, string> = {};
  for (const c of commands) {
    const res = await client.callTool("kai_command_guard", {
      command: c.cmd
    });
    verdicts[c.cmd] = res.data.verdict;
  }

  const success = verdicts["git status --porcelain"] === "allow" &&
                  verdicts["git diff HEAD~1"] === "allow" &&
                  verdicts["git reset --hard origin/main"] !== "allow" &&
                  verdicts["git push --force origin main"] !== "allow";

  const result: RecipeResult = {
    recipe: "13: Git Destructive Guard",
    tool: "kai_command_guard",
    success,
    output: verdicts,
    explanation: "Safe git queries allowed; destructive force push and hard reset flagged for user approval (ask)."
  };

  return result;
}

if (process.argv[1]?.endsWith("13-git-destructive-guard.ts")) {
  runRecipe13().then(logRecipe).catch(console.error);
}
