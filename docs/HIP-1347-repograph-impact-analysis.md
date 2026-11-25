# HIP-1347: Graph Tools for Repository Reasoning & Change-Impact Analysis — RepoGraph (`#37`)

## 1. Overview & Primary Reference Audit

- **Tracking Issue**: [`hanzoai/mcp#37`](https://github.com/hanzoai/mcp/issues/37) (`HAI-500`, `HIP-1347`)
- **Primary Reference & License Audit**:
  - Ouyang et al., *RepoGraph: Enhancing AI Software Engineering with Repository-level Code Graph*, ICLR 2025 (`https://openreview.net/forum?id=uVXg3C4g3K`, upstream [`ozyygen/RepoGraph`](https://github.com/ozyygen/RepoGraph) **MIT License**).
  - **Clean-Room Attestation**: `100%` original clean-room TypeScript (**MIT License**) authored in `src/repograph/`, `test/repograph/repograph.test.ts`, and `bench/repograph-eval.ts`. Zero external lines copied, zero new runtime or dev dependencies added (`package.json` untouched), and zero patent or dataset restrictions. Published paper figures are never claimed as Hanzo metrics; all numbers below are reproduced directly on `@hanzo/mcp`.

## 2. Canonical Identities, Pre-Retrieval Isolation & Derived Graph

Canonical Hanzo stack boundaries stay intact (`vfs -> hanzoai/s3 -> visor`, Cloud owning lifecycle and billing, Enso routing models, Zen generating completions, Kai returning structured non-generative decisions):

1. **Four Canonical Identity Classes**:
   - `CanonicalSourceBlob`: `{ blobId, tenantId, repoId, packageName, filePath, commitSha, sha256, allowedRoles, content }`
   - `CanonicalRuntimeTrace`: `{ traceId, tenantId, repoId, commitSha, entryPoint, callerFile, callerSymbol, calleeFile, calleeSymbol, calleeOwnerType, invocations, errorCount, p95LatencyMs, allowedRoles }`
   - `CanonicalFailureRecord`: `{ failureId, tenantId, repoId, commitSha, testFile, errorMessage, stackFrames, allowedRoles }`
   - `CanonicalGitCommit`: `{ commitSha, parentSha, tenantId, repoId, timestampEpochSec, author, message, touchedFiles, allowedRoles }`
2. **Derived Graph Rebuild Guarantee**:
   - All AST symbol nodes, receiver-disambiguated call edges, interface/trait implementations, and Git co-change probabilities are **derived representations** over those canonical identities. Calling `rebuildDerivedGraph()` discards all derived state and reconstructs a bit-identical snapshot digest (`sha256`) without altering canonical records.
3. **Strict Pre-Retrieval Tenant & RBAC Isolation**:
   - `isAuthorizedRecord(record, access)` enforces `tenantId`, optional `repoId`, and RBAC `allowedRoles` **before** any blob, trace, failure, or commit enters graph construction or query results.

## 3. Six Explicit Architectural Reasoning Tools (`createRepoGraphTools()`)

- **`find_callers`**: Direct and transitive caller traversal with receiver-type disambiguation (pruning shadowed method names on unrelated classes/structs) and runtime invocation enrichment.
- **`find_implementations`**: Resolves TypeScript `implements`/`extends`, Go structural interface satisfaction (method-set matching), Rust `impl Trait for Struct`, Python base-class inheritance, and runtime polymorphic dispatch observations.
- **`trace_dependency`**: Directed shortest and k-bounded dependency path search (`from -> to`) across `static_call`, `interface_dispatch`, `implements`, and `runtime_trace` edges.
- **`explain_change_impact`**: Predicts pre-execution blast radius (`low | medium | high | critical`) by fusing static caller/implementor reachability, runtime trace traffic and error counts, recent failure stacks, and Git commit co-change coupling (`P(fileB | fileA)`).
- **`find_related_tests`**: Ranks covering unit and integration tests across static reachability, runtime trace `entryPoint` spans, failure stack frames, and Git co-change history.
- **`find_regression_origin`**: Hybrid fault localization combining failure dependency slicing, runtime trace error density, symbol-level commit hunk overlap, and commit recency weighting.

## 4. Reproducible Benchmark Results

Evaluated over `8` SWE-bench-style polyglot architectural reasoning & regression-localization scenarios (`typescript`, `go`, `rust`, `python`) plus `4` isolated negative-control scripts under identical corpus, retrieval budget, and repair oracle:

| Strategy | Mean Impact F1 | Precision | Recall | False Dependency Path Rate | Root-Cause Top-1 | Root-Cause MRR | Guided Repair Rate | Mean Tokens | Mean / p95 Latency (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `lexical_grep_gitlog` | `55.42%` | `52.08%` | `68.75%` | `22.92%` | `12.50%` (1/8) | `0.5625` | `0.00%` (0/8) | `126.1` | `0.070 / 0.229` |
| `static_graph_only` | `54.17%` | `60.42%` | `56.25%` | `27.08%` | `12.50%` (1/8) | `0.5625` | `0.00%` (0/8) | `131.9` | `2.384 / 9.162` |
| **`hybrid_repograph`** | **`100.00%`** | **`100.00%`** | **`100.00%`** | **`0.00%`** | **`100.00%` (8/8)** | **`1.0000`** | **`100.00%` (8/8)** | **`114.3`** | **`1.419 / 3.053`** |

### Per-Scenario Breakdown

| Scenario ID | Language | `lexical_grep` F1 / Rank | `static_graph` F1 / Rank | `hybrid_repograph` F1 / False Paths / Rank |
| :--- | :--- | :---: | :---: | :---: |
| `ts-interface-shadowed-decoy` | TypeScript | `80.0%` / `#2` | `50.0%` / `#2` | **`100.0%` / `0.0%` / `#1`** |
| `go-structural-interface-impact` | Go | `66.7%` / `#2` | `50.0%` / `#2` | **`100.0%` / `0.0%` / `#1`** |
| `rust-trait-impl-wal-regression` | Rust | `100.0%` / `#2` | `66.7%` / `#2` | **`100.0%` / `0.0%` / `#1`** |
| `py-subclass-and-git-cochange` | Python | `0.0%` / `#1` | `66.7%` / `#1` | **`100.0%` / `0.0%` / `#1`** |
| `ts-runtime-trace-plugin-bridge` | TypeScript | `0.0%` / `#2` | `0.0%` / `#2` | **`100.0%` / `0.0%` / `#1`** |
| `ts-3hop-transitive-impact` | TypeScript | `66.7%` / `#2` | `100.0%` / `#2` | **`100.0%` / `0.0%` / `#1`** |
| `ts-multi-receiver-disambiguation` | TypeScript | `50.0%` / `#2` | `50.0%` / `#2` | **`100.0%` / `0.0%` / `#1`** |
| `py-polymorphic-sampler-hierarchy` | Python | `80.0%` / `#2` | `50.0%` / `#2` | **`100.0%` / `0.0%` / `#1`** |

### Negative Control (`4` Standalone Python Scripts)

- `zeroSpuriousImpactEdges`: **`true`**
- `zeroFalseCallers`: **`true`**

## 5. Reproduction Commands

```bash
pnpm exec tsc --noEmit
pnpm build
node scripts/smoke-mcp.mjs
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand test/repograph/repograph.test.ts
npx tsx bench/repograph-eval.ts
```
