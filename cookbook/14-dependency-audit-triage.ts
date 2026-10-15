/**
 * Recipe 14: Dependency Audit Triage
 * 
 * Objective: Triage vulnerability alert outputs (e.g. from cargo audit or npm audit)
 * into actionable severity tiers and select appropriate remediation strategies.
 */

import { createRecipeClient, logRecipe, RecipeResult } from "./helper.js";

export async function runRecipe14(): Promise<RecipeResult> {
  const client = await createRecipeClient();

  const auditOutput = `
Crate:     openssl
Version:   0.10.38
Warning:   RUSTSEC-2023-0044: Memory corruption in OpenSSL X.509 certificate verification
Severity:  critical (CVSS 9.8)
Solution:  Upgrade to >= 0.10.55
Dependency tree:
  auth-service v0.1.0
  └── openssl v0.10.38
`;

  const res = await client.callTool("kai_extract", {
    text: auditOutput,
    schema: {
      package_name: {
        type: "choice",
        description: "Vulnerable package identified in report",
        options: ["openssl", "tokio", "serde", "reqwest"]
      },
      severity_tier: {
        type: "score",
        description: "Vulnerability severity level",
        levels: ["low", "moderate", "high", "critical"]
      },
      actionable_fix: {
        type: "choice",
        description: "Recommended remediation action",
        options: [
          "update_cargo_toml_version",
          "ignore_advisory_in_audit_config",
          "vendor_patched_source",
          "rearchitect_to_remove_dependency"
        ]
      }
    }
  });

  const extracted = res.data.extracted;
  // A field counts when it is right or abstains: the caller acts only on fields that do not abstain.
  const rightOrAbstained = (f: any, ok: unknown[]) => f.abstained || ok.includes(f.value);
  const success = rightOrAbstained(extracted.package_name, ["openssl"]) &&
                  rightOrAbstained(extracted.actionable_fix, ["update_cargo_toml_version", "vendor_patched_source"]);

  const result: RecipeResult = {
    recipe: "14: Dependency Audit Triage",
    tool: "kai_extract",
    success,
    latency_ms: res.latency_ms,
    output: res.data,
    explanation: "Each field comes back with its confidence; one near uniform abstains rather than guess. Act only on fields that do not abstain."
  };

  return result;
}

if (process.argv[1]?.endsWith("14-dependency-audit-triage.ts")) {
  runRecipe14().then(logRecipe).catch(console.error);
}
