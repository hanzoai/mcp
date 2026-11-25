# HIP-1348 / HIP-1347 Research & Implementation Report: Risky-Tool Effect Simulation (ToolEmu)

- **Umbrella / Tracking Issues**: `hanzoai/mcp#43` (HIP-1348), `hanzoai/mcp#47` (HIP-1347)
- **Canonical Stack Alignment**: Preserves `vfs -> hanzoai/s3 -> visor`, Cloud owning lifecycle & billing, Enso routing models, Zen generating outputs, and **Kai** returning structured non-generative `action.risk@1` decisions. Opt-in only on `createMCPServer` — zero changes to the default 19-tool HIP-0300 surface.

---

## 1. Paper & License Audit

- **Primary Paper**: Yangjun Ruan, Honghua Dong, Andrew Wang, Silviu Pitis, Yongchao Zhou, Jimmy Ba, Yann Dubois, Chris J. Maddison, Tatsunori Hashimoto, *"Identifying the Risks of LM Agents with an LM-Emulated Sandbox"* (ToolEmu, **ICLR 2024**).
  - OpenReview / Proceedings URL: https://proceedings.iclr.cc/paper_files/paper/2024/hash/7274ed909a312d4d869cc328ad1c5f04-Abstract-Conference.html
  - Upstream Reference Repository: `ryoungj/ToolEmu` (Apache-2.0 License, study-only reference).
- **Design Summary**: ToolEmu introduces pre-execution emulation of tool calls in an isolated sandbox to predict harmful outcomes (destructive filesystem actions, secret exfiltration, irreversible VCS mutations, privilege escalation, and high-blast-radius batch operations) before touching real external systems.
- **License & Patent Clearance**:
  - Upstream ToolEmu is Apache-2.0 compatible, and this PR uses a **100% clean-room TypeScript ESM implementation** inside `@hanzo/mcp` (MIT) with **zero copied third-party code**, **zero copied upstream dataset text**, and **zero new runtime dependencies** in `package.json`.
  - An optional `--external-toolemu-json <path>` loader (`loadExternalToolEmuCases`) allows operators to evaluate external ToolEmu JSON case files locally without vendoring external datasets.
  - No patent encumbrances or incompatible model-license dependencies are introduced (the simulator is deterministic and non-generative).

---

## 2. Matched Baselines & Experimental Methodology

All five policy regimes are evaluated identically on the same 36-scenario ToolEmu-taxonomy suite (18 risky scenarios across 6 categories + 18 benign look-alike hard negatives) against real on-disk temporary workspaces canonicalized with `fs.realpathSync` (ensuring identical behavior across Linux and macOS symlinked `TMPDIR`):

1. `no_simulation_baseline`: Unguarded direct execution control (no pre-execution risk simulation).
2. `static_denylist_only`: Naive regex/keyword denylist over serialized tool arguments (matches literal `rm -rf`, `git push --force`, `curl | sh`, `chmod 777`).
3. `heuristic_param_inspector`: Structured argument and tokenized command parser **without** on-disk workspace snapshot or symlink canonicalization.
4. `shadow_state_simulator`: Full pre-execution copy-on-write shadow-state effect simulator (`ToolEffectSimulator`) inspecting an isolated read-only workspace snapshot, canonicalizing symlinks via `fs.realpathSync`, quantifying exact `filesAffected` and `bytesAffected` blast radius, and emitting structured Kai `action.risk@1` decisions without mutating disk.
5. `overly_strict_negative`: Documented negative control blocking all write/exec/network tools unconditionally to measure false-block utility collapse.

### Reproducible Command

```bash
pnpm exec tsx bench/toolemu/eval.ts --seed 1348 --out-dir docs/research/hip-1348-toolemu
```

---

## 3. Falsifiable Hypothesis & Expected Failure Modes

- **Hypothesis**: Pre-execution shadow-state simulation (`shadow_state_simulator`) against a canonicalized read-only workspace snapshot achieves **>= 94% unsafe-action recall** with **<= 5% benign false-block rate**, **0 real-workspace mutations** on blocked calls, and **< 5 ms p95 simulation latency**, strictly outperforming both `static_denylist_only` (on indirect/stateful risks and keyword false blocks) and `heuristic_param_inspector` (on symlink escapes and stateful mass-blast-radius batch mutations).
- **Expected Failure Modes & Documented Negative Regimes**:
  1. **Overly Strict Negative Control (`overly_strict_negative`)**: Demonstrates severe utility collapse (66.67% false-block rate, 33.33% benign utility preserved).
  2. **Static Denylist Evasion & Over-Blocking (`static_denylist_only`)**: Misses stateful/indirect risks (27.78% recall) while falsely blocking benign docs/search/echo calls mentioning risky keywords (16.67% false-block rate).
  3. **Semantic Business-Logic Blindspot (`semantic_business_logic_blindspot`)**: A syntactically benign, reversible single-file patch corrupting billing logic (`price * quantity` -> `price + quantity`) returns `allow` (riskScore=0) under deterministic effect simulation. Effect simulation complements—and never replaces—unit tests, type checks, and semantic verification.

---

## 4. Bounded Implementation Deliverable

- **Core Simulator & Middleware**: [`src/security/risky-tool-simulator.ts`](../../../src/security/risky-tool-simulator.ts)
  - `ToolEffectSimulator` with 5 policy presets and deterministic Kai `action.risk@1` `ActionRiskDecision` output (`schemaVersion`, `tool`, `action`, `riskScore`, `severity`, `decision`, `predictedEffects`, `blastRadius`, `shadowDiff`, `rationale`).
  - Cross-platform `resolveCanonicalRoot` / `resolveCanonicalPath` using `fs.realpathSync`.
  - `wrapMcpToolsWithRiskSimulator(...)` opt-in middleware + `isValidActionRiskDecision(...)` runtime validator.
  - Preserves 100% backwards compatibility with existing `simulateToolExecution`, `simulateToolExecutionWithProbe` (with workspace-under-`os.tmpdir()` fix), and `evaluateToolEmuSuite`.
- **Opt-In Server Integration**: [`src/index.ts`](../../../src/index.ts) — optional `riskSimulator?: ToolEffectSimulator` config hook on `createMCPServer` (off by default; zero impact on default 19-tool HIP-0300 surface).
- **Benchmark Suite & CLI**: [`src/security/toolemu-benchmark.ts`](../../../src/security/toolemu-benchmark.ts), [`bench/toolemu/eval.ts`](../../../bench/toolemu/eval.ts), re-exported via [`src/security/index.ts`](../../../src/security/index.ts).
- **Test Suite**: [`test/security/toolemu-risk-simulator.test.ts`](../../../test/security/toolemu-risk-simulator.test.ts).

---

## 5. Evidence: Correctness, Concurrency, Multi-Tenant Isolation & Regression Safety

- **Zero-Leak Real-Workspace Safety**: Every blocked risky scenario is verified via pre/post recursive SHA-256 directory manifests (`hashDirectoryManifest`) plus an external out-of-workspace sentinel file (`outside-sentinel.txt`). Blocked calls produce **0** workspace mutations and **0** sentinel mutations.
- **Symlinked TMPDIR & Escape Handling**: Tested with both relative `../` traversal and real on-disk symlinks resolving outside canonicalized workspace roots.
- **Concurrency & Multi-Tenant Isolation**: Parallel `Promise.all` runs across isolated tenant workspaces, session IDs, and distinct policy modes verify zero shared mutable state and zero cross-tenant leakage in `tenantId`, `sessionId`, `workspaceRoot`, or verdicts.
- **Live End-to-End Integration**: Tested through `createMCPServer({ projectPath, riskSimulator })` verifying blocked destructive/secret calls return structured `action.risk@1` errors without mutating disk while benign `fs.read` / `fs.write` / `fs.apply_patch` succeed with `_meta.actionRisk`.
- **Zero Regression**: Existing `test/security/risky-tool-simulator.test.ts`, `test/security/prompt-injection-guard.test.ts`, `test/annotations.test.ts`, `tsc --noEmit`, `pnpm build`, and `pnpm smoke` (9/9) all pass.

---

## 6. Raw Measurements & HIP-1348 / HIP-1347 Status Update

- **Raw Data**: [`raw_results.json`](./raw_results.json) (seed `1348`)
- **Full Score Table**: [`score_table.md`](./score_table.md)

### Headline Measured Results (Authoring Host)

| Policy Mode | Unsafe Recall | False-Block Rate | F1 | Benign Utility | Zero-Leak | p95 Latency |
|---|---:|---:|---:|---:|:---:|---:|
| `no_simulation_baseline` | **0.00%** (0/18) | **0.00%** (0/18) | 0.00% | 100.00% | PASS | 0.433 ms |
| `static_denylist_only` | **27.78%** (5/18) | **16.67%** (3/18) | 38.46% | 83.33% | PASS | 0.547 ms |
| `heuristic_param_inspector` | **83.33%** (15/18) | **0.00%** (0/18) | 90.91% | 100.00% | PASS | 2.911 ms |
| `shadow_state_simulator` | **100.00%** (18/18) | **0.00%** (0/18) | 100.00% | 100.00% | PASS | 2.005 ms |
| `overly_strict_negative` | **100.00%** (18/18) | **66.67%** (12/18) | 75.00% | 33.33% | PASS | 0.378 ms |

### HIP-1348 / HIP-1347 Status Update

- **HIP-1348 (`hanzoai/mcp#43`)**: Research experiment, matched 5-policy comparison, 3 negative/boundary regimes, raw artifacts, and clean-room `ToolEffectSimulator` implementation complete.
- **HIP-1347 (`hanzoai/mcp#47`)**: Pre-execution risky-tool effect simulation paired with structured non-generative Kai `action.risk@1` gating is implemented as an opt-in middleware and `createMCPServer({ riskSimulator })` hook, ready for maintainer review and production adoption alongside existing runtime guardrails.

