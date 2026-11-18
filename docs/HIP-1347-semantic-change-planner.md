# HIP-1347: AST-Aware Structural Edits, Semantic Diffs & Incremental Test Selection (`#38`)

## 1. Overview & Primary Reference Audit

- **Tracking Issue**: [`hanzoai/mcp#38`](https://github.com/hanzoai/mcp/issues/38) (`HAI-501`, `HIP-1347`)
- **Primary Reference & License Audit**:
  - Structural search and metavariable rewrite semantics draw conceptual inspiration from [`ast-grep/ast-grep`](https://github.com/ast-grep/ast-grep) (**MIT License**, Herrington Darkholme) and classic regression test selection / Test Impact Analysis literature (Gligoric et al., *Practical Regression Test Selection with Dynamic File Dependencies*, ISSTA 2015).
  - **Clean-Room Attestation**: `100%` original clean-room TypeScript (**MIT License**) authored in `src/semantic-edit/`, `test/semantic-edit/semantic-change-planner.test.ts`, and `bench/semantic-edit-eval.ts`. Zero external lines copied, zero new runtime or transitive dependencies added (`package.json` untouched), and zero patent or dataset restrictions. Published external metrics are never presented as Hanzo claims; all numbers below are reproduced directly on `@hanzo/mcp`.

## 2. Canonical Stack & Retrieval Program Invariants

Canonical Hanzo boundaries remain intact (`vfs -> hanzoai/s3 -> visor`, Cloud owning lifecycle and billing, Enso routing models, Zen generating completions, Kai returning structured non-generative decisions), composing directly with SWE-agent ACI (`#48`) and symbol-graph RepoMap (`#36`):

1. **Stable Canonical Identity & Rebuildable Derived Indexes**:
   - Every repository file or test blob is stored as an immutable `CanonicalBlobRecord` keyed by `{ blobId, tenantId, repoId, packageName, filePath, commitVersion, sha256, allowedRoles }`.
   - `DerivedSemanticIndex` (lexical code-token hashes, normalized symbol signatures, call-site arity graphs, cross-package import bindings, and dynamic hazard flags) is a **pure derived representation** over canonical identities. Calling `rebuildDerivedRepresentations()` discards and reconstructs the entire index deterministically (`sha256` snapshot digest verified bit-identical in tests) without mutating canonical records.
2. **Pre-Retrieval Multi-Tenant & RBAC Isolation**:
   - `checkBlobAccess(blob, access)` enforces `tenantId`, optional `repoId`, and RBAC `allowedRoles` **before** any structural AST match, caller edge, semantic diff, or selected test path is returned. Tenant isolation is never relaxed for speed or recall.
3. **Constrained Structural AST Search & Rewrite (`change-planner.ts`)**:
   - Polyglot lexical-state-aware scanner across TypeScript, JavaScript, Python, Rust, Go, and JSON skips line comments, block comments, docstrings, raw strings (`r#"..."#`, Go backticks), and quoted literals during structural matching so code rewrites never corrupt strings or documentation comments.
   - Supports balanced single-node metavariables (`$EXPR`, `$IDENT`), variadic balanced argument lists (`$$$ARGS`) with automatic comma elision on empty captures, repeated-metavariable unification (`$X === $X`), kind/regex guards, and pre-flight delimiter/JSON/conflict-marker validation (`validateStructuralSyntax`) before accepting any edit.
4. **Semantic Diffs & Cross-Package Contract Gate (`computeSemanticDiff`)**:
   - Classifies changes into `formatting_or_comment_only`, `body_implementation_changed`, `compatible_signature_extension`, `breaking_arity_change`, `breaking_param_type_change`, `breaking_return_type_change`, `symbol_removed_or_unexported`, `symbol_added`, and `config_or_data_modified`.
   - Inspects cross-package importers and call-site argument counts on the post-edit state, flagging un-updated cross-package consumers (`IncompatibleCrossPackageChange`) before execution.
5. **Confidence-Escalated Incremental Test Selection (`selectIncrementalTests`)**:
   - Computes calibrated `dependencyConfidence` (`[0.05, 0.99]`) over 2-hop transitive symbol/caller closures and deducts confidence when dynamic reflection (`eval`, `Function`, `Reflect`, `getattr`, `importlib`, dynamic `import()`), global workspace configs (`tsconfig.json`, `package.json`, `Cargo.toml`, `go.mod`), or public contract mutations appear.
   - Escalates across three tiers (`minimal_targeted` -> `package_and_dependents` -> `full_suite_escalation`) and embeds an explicit `validationContract` (`requiresCompilerCheck: true`, `selectionIsNotSafetyProof: true`).

## 3. Falsifiable Hypotheses & Documented Failure Boundaries

- **Hypotheses**:
  1. Lexical-state-aware structural AST rewrites eliminate string/comment corruption and nested-call regex truncation (`0%` compile failure rate vs `>= 15%` for naive regex replacement).
  2. Confidence-escalated test selection + cross-package compatibility gating reduce silent regression escapes from `>= 30%` (under unescalated 1-hop static selection) to `0.00%` while cutting mean tests executed per change by `> 60%` vs running the full test suite on every edit.
- **Expected Failure Boundaries**:
  - External behavioral contracts not encoded in repository source/config (e.g., out-of-repo database triggers or remote HTTP wire consumers) cannot be inferred statically; `validationContract.selectionIsNotSafetyProof` is always `true` and full gated CI remains required prior to release.

## 4. Reproducible Benchmark Results

Executed over `10` polyglot multi-package tasks (`typescript`, `python`, `rust`, `go`, `json`, `12` test suites per workspace) plus `4` comment/formatting-only negative controls under identical corpus, budget, and ground-truth oracle:

| Strategy | Refactoring Success Rate | Compile Failures | Silent Regression Escapes | Mean Tests / Change | Test Reduction vs Full | Mean Planner Latency (ms) | Mean / p50 / p95 Completion (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `naive_regex_full_suite` | `20.00%` (2/10) | `20.00%` (2/10) | `0.00%` (0/10) | `12.00 / 12` | `0.00%` | `0.347` | `2160.35 / 2160.20 / 2161.41` |
| `static_1hop_no_escalation` | `60.00%` (6/10) | `0.00%` (0/10) | `40.00%` (4/10) | `0.90 / 12` | `92.50%` | `3.862` | `165.86 / 182.40 / 194.40` |
| **`constrained_semantic_planner`** | **`100.00%` (10/10)** | **`0.00%` (0/10)** | **`0.00%` (0/10)** | **`3.80 / 12`** | **`68.33%`** | **`2.569`** | **`686.57 / 183.10 / 2162.85`** |

### Per-Task Breakdown

| Task ID | Language | Category | `naive_regex` | `static_1hop` | `semantic_planner` | Planner Tests Run |
| :--- | :--- | :--- | :---: | :---: | :---: | ---: |
| `ts-nested-call-string-trap` | TypeScript | Nested call + string/comment literal hazard | compile fail | pass (1 test) | **pass (1 test)** | `1` |
| `ts-variadic-zero-arg-logger` | TypeScript | Variadic `$$$ARGS` zero-arg comma elision | compile fail | pass (1 test) | **pass (1 test)** | `1` |
| `ts-cross-package-arity-break` | TypeScript | Cross-package arity break (`auth -> gateway`) | fail | **ESCAPED** | **pass (repaired)** | `4` |
| `py-dynamic-getattr-escalation` | Python | Dynamic `getattr` reflection escalation | fail | **ESCAPED** | **pass (escalated)** | `12` |
| `rust-hash-fastpath-body-only` | Rust | Body-only optimization (`pub fn`) | pass | pass (1 test) | **pass (1 test)** | `1` |
| `go-sql-literal-error-wrap` | Go | Backtick SQL literal collision hazard | fail | pass (1 test) | **pass (1 test)** | `1` |
| `ts-repeated-metavar-unification` | TypeScript | Repeated `$X === $X` unification | fail | pass (1 test) | **pass (1 test)** | `1` |
| `ts-2hop-transitive-caller-selection` | TypeScript | 2-hop transitive caller test selection | fail | **ESCAPED** | **pass (2 tests)** | `2` |
| `ts-compatible-optional-param` | TypeScript | Compatible optional param extension | pass | pass (1 test) | **pass (3 tests)** | `3` |
| `json-global-tsconfig-escalation` | JSON | Global `tsconfig.json` full-suite escalation | fail | **ESCAPED** | **pass (escalated)** | `12` |

### Negative Controls (`4` Comment / Formatting-Only Edits across TS, Python, Rust, Go)

- `formattingOnlyZeroTestsCount`: **`4 / 4`** (`tier: "none_formatting_only"`, `0` unnecessary tests triggered)
- `zeroFalseBreakagesCount`: **`4 / 4`**
- `allControlsSucceeded`: **`true`**

## 5. Reproduction Commands

```bash
pnpm exec tsc --noEmit
pnpm build
node scripts/smoke-mcp.mjs
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand test/semantic-edit/semantic-change-planner.test.ts
npx tsx bench/semantic-edit-eval.ts
```
