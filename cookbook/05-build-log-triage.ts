/**
 * Recipe 05: Build & Test Log Triage
 * 
 * Objective: Parse complex compilation and test error logs, pinpoint the exact file/line span,
 * classify the failure category, and determine whether the error is deterministic or flaky.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe05(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const rawLogs = `
   Compiling parser v0.1.0 (/workspace/parser)
error[E0308]: mismatched types
  --> src/number.rs:88:15
   |
88 |         Ok(val) => val,
   |                    ^^^ expected \`f64\`, found enum \`Result<f64, ParseFloatError>\`
   |
   = note: expected type \`f64\`
              found enum \`Result<f64, ParseFloatError>\`

For more information about this error, try \`rustc --explain E0308\`.
error: could not compile \`parser\` (lib) due to 1 previous error
`;

  const res = await client.callTool("kai_log_triage", {
    logs: rawLogs,
    command: "cargo build"
  });

  const result: RecipeResult = {
    recipe: "05: Build & Test Log Triage",
    tool: "kai_log_triage",
    success: !res.isError && res.data.category === "compilation_error" && res.data.relevant_files.includes("src/number.rs:88:15"),
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Isolated src/number.rs:88:15, classified as compilation_error with recoverable severity."
  };

  return result;
}

if (process.argv[1]?.endsWith("05-build-log-triage.ts")) {
  runRecipe05().then(logRecipe).catch(console.error);
}
