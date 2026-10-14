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
    error_category: "test_assertion_failure",
    failure_fingerprint: {
      tool: "Bash",
      error_snippet: failureSnippet,
      attempt_count: 1,
      last_action: "cargo test -p parser"
    },
    strategies: [
      { id: "inspect_source_evidence", description: "Read number.rs around line 88 to understand exponent parsing logic" },
      { id: "retry_with_corrected_parameters", description: "Rerun test with nocapture flag" },
      { id: "revert_and_switch_strategy", description: "Revert all repository changes back to main" },
      { id: "install_missing_dependency", description: "Add new crate dependency to Cargo.toml" }
    ]
  });

  const result: RecipeResult = {
    recipe: "11: Test Failure Recovery",
    tool: "kai_recover",
    success: !res.isError && res.data.strategy === "inspect_source_evidence",
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Kai selected inspect_source_evidence to read the failing parser code rather than looping."
  };

  return result;
}

if (process.argv[1]?.endsWith("11-test-failure-recovery.ts")) {
  runRecipe11().then(logRecipe).catch(console.error);
}
