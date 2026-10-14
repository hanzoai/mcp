/**
 * Recipe 15: Multi-Question Joint Decision Pipeline
 * 
 * Objective: Execute a comprehensive multi-faceted evaluation of a pull request or code change
 * in a single fast forward pass (<30ms) over Kai, returning joint calibrated answers across
 * architectural complexity, testing completeness, security risk, and deployment readiness.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe15(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const changeEvidence = {
    title: "Refactor database connection pool and retry backoff",
    diff_stats: { files_changed: 4, insertions: 142, deletions: 89 },
    summary: "Replaced fixed reconnect sleep with exponential backoff and jitter. Added circuit breaker when PostgreSQL drops connections.",
    test_coverage: "Unit tests added for backoff calculations; integration test simulates database disconnect."
  };

  const res = await client.callTool("kai_decide", {
    state: changeEvidence,
    questions: {
      architectural_risk: {
        type: "choice",
        instructions: "What is the architectural risk tier of this connection pooling change?",
        criteria: {
          low: "Local isolated changes with zero shared state impact",
          medium: "Alters timing or concurrency characteristics without schema modifications",
          high: "Core data persistence or transaction isolation changes"
        }
      },
      quality_score: {
        type: "score",
        instructions: "Rate the engineering completeness and test adequacy of this change",
        criteria: ["incomplete_no_tests", "adequate_tests_included", "exemplary_complete_coverage"]
      },
      ready_for_review: {
        type: "noul",
        instructions: "Is this pull request mature and well-tested enough for senior engineering review?"
      }
    }
  });

  const answers = res.data.answers;
  const success = Boolean(!res.isError &&
                  answers?.architectural_risk &&
                  answers?.quality_score &&
                  answers?.ready_for_review);

  const result: RecipeResult = {
    recipe: "15: Multi-Question Joint Decision Pipeline",
    tool: "kai_decide",
    success,
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Jointly evaluated risk tier, quality score, and review readiness in a single forward pass."
  };

  return result;
}

if (process.argv[1]?.endsWith("15-multi-question-pipeline.ts")) {
  runRecipe15().then(logRecipe).catch(console.error);
}
