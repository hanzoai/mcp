/**
 * Recipe 11: Test Assertion Failure Recovery
 * 
 * Objective: Given a failed test assertion (e.g. left Err("1e3"), right Ok(1000.0)),
 * evaluate available recovery actions to pick the most direct path to resolution.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe11(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const failureSnippet = "assertion failed: `(left == right)`\n  left: `Err(\"1e3\")`,\n right: `Ok(1000.0)`\nat parser/src/number.rs:88:9";

  const res = await client.callTool("kai_recover", {
    error_category: "test",
    failure_fingerprint: {
      tool: "Bash",
      error_snippet: failureSnippet,
      attempt_count: 1,
      last_action: "cargo test -p parser"
    }
  });

  const result: RecipeResult = {
    recipe: "11: Test Failure Recovery",
    tool: "kai_recover",
    success: !res.isError && res.data.strategy === "run_focused_test_diagnostics",
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "A test failure reruns only the failing test, verbose, before any edit. No model call."
  };

  return result;
}

if (process.argv[1]?.endsWith("11-test-failure-recovery.ts")) {
  runRecipe11().then(logRecipe).catch(console.error);
}
