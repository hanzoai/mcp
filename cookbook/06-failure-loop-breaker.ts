/**
 * Recipe 06: Failure Loop Breaker
 * 
 * Objective: Prevent infinite agent retry loops by fingerprinting failure states and tripping
 * a deterministic circuit breaker when an agent repeats identical failing actions 3 times.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe06(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const failureFingerprint = {
    tool: "Edit",
    error_snippet: "mismatched types: expected f64, found Result<f64, ParseFloatError>",
    attempt_count: 3,
    last_action: "Edit parser/src/number.rs at line 88"
  };

  const res = await client.callTool("kai_recover", {
    error_category: "compilation_error",
    failure_fingerprint: failureFingerprint
  });

  const result: RecipeResult = {
    recipe: "06: Failure Loop Breaker",
    tool: "kai_recover",
    success: !res.isError && res.data.loop_breaker_triggered === true && res.data.strategy === "revert_and_switch_strategy",
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Circuit breaker tripped at attempt 3, commanding revert_and_switch_strategy in 0ms."
  };

  return result;
}

if (process.argv[1]?.endsWith("06-failure-loop-breaker.ts")) {
  runRecipe06().then(logRecipe).catch(console.error);
}
