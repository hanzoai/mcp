/**
 * Recipe 02: Zero-Inference Fast Path Execution
 * 
 * Objective: Demonstrate Hanzo Dev's core speed optimization: when a single deterministic
 * Action has satisfied preconditions, execute it in 0ms without invoking Kai inference or LLM calls.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe02(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const goal = "Fix compiler error in parser/src/number.rs";
  const candidates = [
    {
      action_id: "act_apply_patch",
      tool: "Edit",
      description: "Replace parse_exponent return type with f64 in parser/src/number.rs",
      parameters: { path: "parser/src/number.rs", line: 88, replacement: "Ok(val)" },
      preconditions_satisfied: true
    },
    {
      action_id: "act_read_again",
      tool: "Read",
      description: "Re-read parser/src/number.rs from beginning",
      parameters: { path: "parser/src/number.rs" },
      preconditions_satisfied: false
    }
  ];

  const res = await client.callTool("kai_next_action", {
    goal,
    candidates
  });

  const result: RecipeResult = {
    recipe: "02: Zero-Inference Fast Path",
    tool: "kai_next_action",
    success: !res.isError && res.data.source === "single" && res.data.action?.preconditions_satisfied === true,
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "One candidate had its preconditions met, so it was returned as is; the other was dropped. No model call."
  };

  return result;
}

if (process.argv[1]?.endsWith("02-zero-inference-fast-path.ts")) {
  runRecipe02().then(logRecipe).catch(console.error);
}
