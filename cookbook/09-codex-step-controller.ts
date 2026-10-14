/**
 * Recipe 09: OpenAI Codex Step Controller
 * 
 * Objective: Steer multi-step coding workflows in OpenAI Codex by evaluating agent trajectory
 * states to decide whether to continue (NEXT), recover from error (RECOVER), or finish (STOP).
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe09(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const goal = "Implement and verify parse_exponent function in parser/src/number.rs";
  const trajectory = [
    { step_index: 0, action: "read_file", tool_name: "Read", arguments: { path: "parser/src/number.rs" }, observation: "Found parse_exponent returning Result<f64>", is_error: false },
    { step_index: 1, action: "edit_file", tool_name: "Edit", arguments: { path: "parser/src/number.rs", line: 88 }, observation: "Applied fix", is_error: false },
    { step_index: 2, action: "run_test", tool_name: "Bash", arguments: { command: "cargo test -p parser" }, observation: "test number::parses_exponent ... ok\ntest result: ok. 15 passed; 0 failed", is_error: false }
  ];

  // Evaluate if task is now complete or needs further action
  const res = await client.callTool("kai_decide", {
    state: {
      goal,
      last_test_output: "test number::parses_exponent ... ok\ntest result: ok. 15 passed; 0 failed",
      status: "All 15 parser unit tests passed cleanly"
    },
    questions: {
      status: {
        type: "choice",
        instructions: "What is the status of this coding task?",
        criteria: {
          task_completed: "The requested implementation is complete and verified with passing tests",
          needs_further_edits: "Implementation requires additional code changes or debugging"
        }
      },
      remaining_work: {
        type: "score",
        instructions: "How much work remains to complete the user request?",
        criteria: ["nothing_remaining", "minor_cleanup", "substantial_work_remains"]
      }
    }
  });

  const answers = res.data.answers;
  const result: RecipeResult = {
    recipe: "09: Codex Step Controller",
    tool: "kai_decide",
    success: !res.isError && answers?.status?.choice === "task_completed",
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Kai recognized tests passed and confirmed task_completed with zero remaining work."
  };

  return result;
}

if (process.argv[1]?.endsWith("09-codex-step-controller.ts")) {
  runRecipe09().then(logRecipe).catch(console.error);
}
