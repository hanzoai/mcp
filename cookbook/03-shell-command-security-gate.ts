/**
 * Recipe 03: Shell Command Security Gate
 * 
 * Objective: Screen shell commands before execution using deterministic security policy
 * joined with Kai's calibrated risk assessment on the monotonic lattice: allow < ask < deny.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe03(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  // Test dangerous command that must be denied by deterministic policy
  const dangerousCmd = "rm -rf / --no-preserve-root";
  const dangerousRes = await client.callTool("kai_command_guard", {
    command: dangerousCmd,
    policy: "allow"
  });

  // Test safe development command
  const safeCmd = "cargo test -p parser -- --nocapture";
  const safeRes = await client.callTool("kai_command_guard", {
    command: safeCmd,
    policy: "allow"
  });

  const result: RecipeResult = {
    recipe: "03: Shell Command Security Gate",
    tool: "kai_command_guard",
    success: dangerousRes.data.verdict === "deny" && safeRes.data.verdict === "allow",
    latency_ms: (dangerousRes.latency_ms || 0) + (safeRes.latency_ms || 0),
    output: {
      dangerous: dangerousRes.data,
      safe: safeRes.data
    },
    explanation: "Dangerous rm -rf / blocked with 'deny' via deterministic policy; cargo test allowed."
  };

  return result;
}

if (process.argv[1]?.endsWith("03-shell-command-security-gate.ts")) {
  runRecipe03().then(logRecipe).catch(console.error);
}
