/**
 * Hanzo Kai MCP Cookbook: Index & Unified Benchmark Runner
 * 
 * Runs all 15 recipes sequentially against local or remote Kai runtime.
 */

import { runRecipe01 } from "./01-tool-shortlisting.js";
import { runRecipe02 } from "./02-zero-inference-fast-path.js";
import { runRecipe03 } from "./03-shell-command-security-gate.js";
import { runRecipe04 } from "./04-prompt-injection-screening.js";
import { runRecipe05 } from "./05-build-log-triage.js";
import { runRecipe06 } from "./06-failure-loop-breaker.js";
import { runRecipe07 } from "./07-structured-schema-extraction.js";
import { runRecipe08 } from "./08-claude-code-tool-resolution.js";
import { runRecipe09 } from "./09-codex-step-controller.js";
import { runRecipe10 } from "./10-cursor-context-selector.js";
import { runRecipe11 } from "./11-test-failure-recovery.js";
import { runRecipe12 } from "./12-calibrated-abstention.js";
import { runRecipe13 } from "./13-git-destructive-guard.js";
import { runRecipe14 } from "./14-dependency-audit-triage.js";
import { runRecipe15 } from "./15-multi-question-pipeline.js";
import { RecipeResult } from "./helper.js";

export const recipes = [
  { id: "01", name: "Agent Tool Shortlisting", runner: runRecipe01 },
  { id: "02", name: "Zero-Inference Fast Path", runner: runRecipe02 },
  { id: "03", name: "Shell Command Security Gate", runner: runRecipe03 },
  { id: "04", name: "Prompt-Injection Screening", runner: runRecipe04 },
  { id: "05", name: "Build & Test Log Triage", runner: runRecipe05 },
  { id: "06", name: "Failure Loop Breaker", runner: runRecipe06 },
  { id: "07", name: "Structured Schema Extraction", runner: runRecipe07 },
  { id: "08", name: "Claude Code Tool Resolution", runner: runRecipe08 },
  { id: "09", name: "Codex Step Controller", runner: runRecipe09 },
  { id: "10", name: "Cursor Context Selection", runner: runRecipe10 },
  { id: "11", name: "Test Failure Recovery", runner: runRecipe11 },
  { id: "12", name: "Calibrated Abstention", runner: runRecipe12 },
  { id: "13", name: "Git Destructive Guard", runner: runRecipe13 },
  { id: "14", name: "Dependency Audit Triage", runner: runRecipe14 },
  { id: "15", name: "Multi-Question Pipeline", runner: runRecipe15 },
];

export async function runAllRecipes(): Promise<RecipeResult[]> {
  console.log("=========================================================================");
  console.log("  🚀 Running All 15 Hanzo Kai Native MCP Cookbook Recipes");
  console.log(`  Target: ${process.env.LOCAL_KAI_URL || process.env.API_URL || "http://127.0.0.1:18977"}`);
  console.log("=========================================================================\n");

  const results: RecipeResult[] = [];
  for (const r of recipes) {
    try {
      const start = performance.now();
      const res = await r.runner();
      const elapsed = performance.now() - start;
      if (!res.latency_ms) res.latency_ms = elapsed;
      results.push(res);
      const icon = res.success ? "✅" : "❌";
      console.log(`  ${icon} Recipe ${r.id}: ${r.name.padEnd(35)} [${res.tool}] - ${res.latency_ms.toFixed(1)}ms`);
    } catch (e: any) {
      results.push({
        recipe: r.name,
        tool: "error",
        success: false,
        output: { error: e.message },
        explanation: `Failed with exception: ${e.message}`
      });
      console.log(`  ❌ Recipe ${r.id}: ${r.name.padEnd(35)} - FAILED: ${e.message}`);
    }
  }

  const passed = results.filter(r => r.success).length;
  console.log("\n=========================================================================");
  console.log(`  Summary: ${passed}/${results.length} Recipes Passed`);
  console.log("=========================================================================\n");

  return results;
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  runAllRecipes().catch(console.error);
}
