# HIP-1346: Compiler-Aware Code Knowledge Graph (SCIP + Tree-Sitter Structural Fusion)

## 1. Provenance & Clean-Room License Audit

- **Target Issue**: `hanzoai/mcp#34` (*Compiler-aware code knowledge graph: Tree-sitter plus SCIP*)
- **Specification & Reference Licenses**:
  - Sourcegraph **SCIP** (*SCIP Code Intelligence Protocol*, `scip-typescript`, `scip-go`): **Apache-2.0**
  - **Tree-sitter** structural grammar model: **MIT**
- **Implementation**: 100% original clean-room TypeScript (`MIT`) in `src/code-graph/`, `test/code-graph/scip-knowledge-graph.test.ts`, and `bench/scip-code-graph-eval.ts` with `0` new runtime dependencies and `0` copied third-party lines.

## 2. Derived Index Architecture & Access-Control Invariants

1. **Derived Graph Over Immutable Source Identities**:
   - Every source blob is keyed by `(tenantId, repoId, commitOid, blobSha256)` and never mutated by index construction.
   - Rebuilding from immutable source blobs and optional SCIP documents produces a bit-identical SHA-256 graph digest (`computeGraphDigest()`), proved against incremental `reindexCommit` deltas.
2. **Hierarchy & Edge Semantics**:
   - Models `Repository -> Package -> File -> Symbol -> Definition / Reference / Import / Implementation`.
   - Ingests compiler-exact SCIP symbols (`parseScipSymbol`), 3/4-tuple occurrence spans, `SymbolRole` bitmasks, and `isImplementation` relationships while seamlessly falling back to comment/string-masked polyglot structural extraction across **TypeScript, Go (including duck-typed interface satisfaction), Rust (`impl Trait for T`), and Python**.
3. **Mandatory Pre-Retrieval Tenant & RBAC Isolation**:
   - `AccessContext` (`tenantId`, `principalRoles`, `allowedPackages`) is enforced **prior** to candidate scoring or hit emission across `findDefinitions`, `findReferences`, `findImplementations`, and `localizeBugFiles`.

## 3. Measured Polyglot Evaluation (`92` Files across TS, Go, Rust, Python)

Reproduce via `npx tsx bench/scip-code-graph-eval.ts`:

| Strategy | Definition Recall | Reference Precision (Overloaded) | Implementation Recall | Downstream Bug-Loc Top-2 | Cold Index (ms) | Incremental Reindex (ms) | p50 / p95 Nav (ms) | Memory |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `arbitrary_line_chunks` | `100.00%` | n/a (untyped) | `0.00%` | `50.00%` | - | - | - | - |
| `tree_sitter_structural` | `100.00%` | `51.19%` | `100.00%` | `100.00%` | `71.531` | - | - | - |
| **`hybrid_scip_plus_treesitter`** | **`100.00%`** | **`76.19%` (`+25.00 pp`)** | **`100.00%`** | **`100.00%` (`+50.00 pp`)** | **`13.947`** | **`6.947` (`2.01x`)** | **`0.923 / 1.099`** | **`134.3 KB` (`1,460 B/file`)** |
