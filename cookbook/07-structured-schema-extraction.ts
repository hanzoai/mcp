/**
 * Recipe 07: Structured Value Extraction
 * 
 * Objective: Extract discrete categorical classifications, risk ratings, and boolean flags
 * from pull request descriptions or issue tickets in a single fast forward pass.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe07(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const prText = `
PR Title: Migrate payment gateway from Stripe v2 to v3 webhook endpoints
Description:
This change updates our payment webhook listener to handle asynchronous bank debits
and 3D-Secure 2.0 verification. It touches credit card transaction storage and
database billing columns. Comprehensive unit tests and integration tests have been added.
Database migration 0042_add_payment_intent.sql must be applied before deployment.
`;

  const res = await client.callTool("kai_extract", {
    text: prText,
    schema: {
      domain: {
        type: "choice",
        description: "Primary domain impacted by this pull request",
        options: ["billing_and_payments", "auth_and_iam", "frontend_ui", "infra_devops"]
      },
      risk_score: {
        type: "score",
        description: "Production risk severity of this change",
        levels: ["low_risk_cosmetic", "medium_risk_feature", "high_risk_financial_or_security"]
      },
      requires_db_migration: {
        type: "choice",
        description: "Does this change require running database migrations prior to release?",
        options: ["requires_migration", "no_migration_needed"]
      }
    }
  });

  const result: RecipeResult = {
    recipe: "07: Structured Value Extraction",
    tool: "kai_extract",
    // A field counts when it is right or abstains; every field carries its confidence.
    success: !res.isError &&
             [["domain", "billing_and_payments"], ["requires_db_migration", "requires_migration"]]
               .every(([k, v]) => res.data.extracted[k].abstained || res.data.extracted[k].value === v),
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Three typed fields in one call, each with its confidence; a field near uniform abstains. Low confidence here means check before acting."
  };

  return result;
}

if (process.argv[1]?.endsWith("07-structured-schema-extraction.ts")) {
  runRecipe07().then(logRecipe).catch(console.error);
}
