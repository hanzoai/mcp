/**
 * Recipe 12: Calibrated Abstention
 * 
 * Objective: Demonstrate Kai's calibrated abstention mechanism. When inputs are ambiguous,
 * under-specified, or lack confidence to clear thresholds, Kai safely abstains rather than
 * guessing or hallucinating actions.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe12(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  // Intentionally ambiguous instruction without clear file or target
  const ambiguousGoal = "Update the thing in the system.";
  const candidates = [
    { action_id: "act_delete_db", tool: "Bash", description: "Delete local database cache" },
    { action_id: "act_deploy", tool: "Bash", description: "Deploy latest commit to production" },
    { action_id: "act_format", tool: "Bash", description: "Run code formatter on all files" }
  ];

  const res = await client.callTool("kai_next_action", {
    goal: ambiguousGoal,
    candidates
  });

  const result: RecipeResult = {
    recipe: "12: Calibrated Abstention",
    tool: "kai_next_action",
    success: !res.isError && res.data.abstained === true && res.data.action === null,
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "No candidate shares a word with the goal, so it abstains rather than guess: one guess here deploys to production."
  };

  return result;
}

if (process.argv[1]?.endsWith("12-calibrated-abstention.ts")) {
  runRecipe12().then(logRecipe).catch(console.error);
}
