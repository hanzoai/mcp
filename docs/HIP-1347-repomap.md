# HIP-1347: Dynamic Repository Map Ranked by Symbol Graph (RepoMap)

Tracking issue: `hanzoai/mcp#36` (`HAI-499`)
Package: `@hanzo/mcp` (MIT License)

## 1. Reference Architecture and Clean-Room License Audit

- **Architectural references**:
  - Aider `RepoMap` (`Aider-AI/aider`, Apache-2.0): structural symbol extraction, cross-file reference graph construction, PageRank ranking seeded by active context, and token-budgeted signature rendering.
  - Taher H. Haveliwala (WWW 2002), *Topic-Sensitive PageRank*: Personalized PageRank teleportation vectors over directed graphs.
- **License audit**:
  - `@hanzo/mcp` is distributed under the **MIT** license.
  - All code in `src/repomap/` and `test/repomap/` is an independent, clean-room TypeScript implementation authored from scratch under MIT. No source code was copied from Aider or any GPL/LGPL/AGPL codebase.
  - **Transitive dependency check**: Zero runtime or optional dependencies were added to `package.json`. The module uses only Node.js standard library modules (`crypto`, `fs/promises`, `path`) and `@hanzo/mcp`'s existing `glob` dependency (ISC license).

## 2. Source Identity, Derived Index Invariant, and Pre-Hit Access Control

Per the HIP-1347 shared retrieval and memory rules:

1. **Stable source identity and version**:
   - Every repository file enters the pipeline as a `SourceBlobRecord` carrying `filePath`, `blobSha` (`sha256:<hex>` content address), `commitRevision`, `tenantId`, `allowedRoles`, and `aclTags`.
   - `SymbolGraph`, `SymbolDefinition` nodes (`${filePath}#${kind}:${name}:${line}`), and `DerivedSymbolCache` entries are strictly **derived representations** keyed by `(tenantId, filePath, blobSha, commitRevision, adapterName)`. Wiping `DerivedSymbolCache.clear()` and re-running `buildSymbolGraph()` reconstructs byte-identical symbol nodes and edges without mutating source records.
2. **Fail-closed tenant and ACL filtering before indexing and ranking**:
   - `authorizeSourceBlobs()` runs **before** symbol extraction, import resolution, graph edge linking, Personalized PageRank power iteration, and map rendering.
   - Blobs failing `tenantId` equality, `requireTenantMatch` (unlabeled blobs in tenant-scoped queries, or tenant-owned blobs queried without a caller `tenantId`), RBAC `allowedRoles`, required `aclTags`, `deniedPathPrefixes`, or path-traversal normalization (`..` / null bytes) are excluded prior to graph construction.
   - Cross-tenant files never create symbol nodes or graph edges and therefore cannot leak symbol names or perturb PageRank scores.

## 3. Falsifiable Hypothesis and Negative Control

- **Falsifiable hypothesis**:
  On multi-package polyglot repositories where an issue prompt, stack trace, or `git diff` names an entry-point file whose root cause or downstream caller sits 1-2 hops across module or barrel boundaries using distinct internal domain vocabulary, ranking the symbol graph with Personalized PageRank (`symbol_graph_repomap`) under a fixed 650-token map budget will achieve higher target-file recall, lower tokens before the first useful edit, fewer exploratory navigation tool calls, and higher multi-file task completion than both a lexicographic 100-file truncated dump (`naive_dump_100`) and a BM25 lexical top-k selector (`lexical_topk`).
- **Boundary / negative control**:
  When a workspace consists of standalone scripts with **zero** cross-file imports or symbol calls (`graphEdgeCount = 0`), symbol-graph edges carry no structural signal; `symbol_graph_repomap` must show zero artificial recall lift (`|recallLiftOverLexical| <= 0.01`) over `lexical_topk`.

## 4. Method and Matched Baselines

### Symbol Graph and Personalized PageRank (`src/repomap/repo-map.ts`)

1. **Sanitized multi-language extraction + pluggable AST adapter**:
   - `DefaultStructuralExtractor` strips comments, docstrings, and string literals while preserving exact 1-based line spans, then extracts exported/internal declarations, compact body-less signatures, imports/re-exports (following up to 2 hops of barrel `export *` / `export { ... } from`), and enclosing-symbol call/identifier references across **TypeScript, JavaScript, Rust, Python, and Go**.
   - External Tree-sitter or compiler AST integrations plug in via `SymbolExtractorAdapter`.
2. **Context seeding and ubiquitous hub damping**:
   - Personalization vector `p` weights `activeFiles`, `errorSpans` / parsed `diagnosticText` (`tsc`, V8/Jest, Rust `-->`, Python tracebacks, Go spans), `gitDiffPaths` / unified `gitDiffText` hunk line ranges, `mentionedSymbols`, and IDF-weighted `taskQuery` sub-tokens.
   - Ubiquitous non-seed utility hubs (imported by `>15%` of workspace files and `>=4` callers, such as a shared `logger.ts`) apply both IDF edge damping and stochastic hub-retention (`1 / (1 + inFileDegree)`), teleporting excess walk mass back to context seeds while conserving exact PageRank probability mass (`sum(scores) = 1.0`).
3. **Token-budgeted compact renderer**:
   - `renderRepoMap()` ranks `(file, symbol)` tiers and runs binary-search rank-prefix selection followed by greedy slack packing so rendered signatures and `->` / `<-` call edges never exceed `maxTokens`.

### Matched Evaluation Protocol (`src/repomap/benchmark.ts`)

All three strategies are evaluated under the same `650`-token map budget, the same 124-file polyglot monorepo (`249` cross-file symbol edges across TypeScript, Rust, Python, and Go packages, 105 console/admin/analytics distractor modules sharing surface symptom terms, and a ubiquitous `packages/common/src/logger.ts` hub), and the same **oracle-free, strategy-blind** navigation judge (`maxNavigationCalls = 4`, `maxCumulativeTokens = 2400`, input token price `$3.00 / 1M` tokens). Reading a file in the simulator reveals only its forward imports (never reverse callers across the workspace unless `<-` caller edges were rendered in the map) and never peeks at ground-truth target lists when choosing which file to open next.

## 5. Bounded Deliverable

| Path | Responsibility |
| :--- | :--- |
| `src/repomap/repo-map.ts` | Source blob authorization, multi-language symbol/import/reference extraction, `SymbolExtractorAdapter`, `DerivedSymbolCache`, `buildSymbolGraph`, `rankSymbolGraph` (Personalized PageRank + hub damping), `renderRepoMap`, `generateRepoMap`, and `generateWorkspaceRepoMap`. |
| `src/repomap/benchmark.ts` | Matched-baseline harness (`naive_dump_100`, `lexical_topk`, `symbol_graph_repomap`) plus disconnected flat-script negative control (`evaluateRepoMapBenchmark`). |
| `src/repomap/index.ts` | Module barrel exports. |
| `src/index.ts` | Re-exports `./repomap/index.js` from `@hanzo/mcp`. |
| `test/repomap/repo-map.test.ts` | 13 Jest test cases covering multi-language extraction, custom AST adapter, cache invalidation, pre-ranking tenant/RBAC/ACL/path isolation, PPR convergence & hub damping, diagnostic/diff parsing, token-budget caps, filesystem scanning, concurrency isolation, and benchmark assertions. |
| `docs/HIP-1347-repomap.md` | Engineering and benchmark report. |

## 6. Raw Measurements and Reproducibility

### Aggregate Results (124 files, 249 symbol edges, 6 multi-hop tasks, budget = 650 tokens)

| Strategy | Mean Map Tokens | Target File Recall | Full Causal Chain Selected | Tokens Before First Useful Edit | Mean Navigation Tool Calls | Task Completion Rate | Cold Latency p50 / p95 (ms) | Est. Prompt Cost / 1k Tasks (USD) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `naive_dump_100` | 650.00 | 0.00% | 0.00% | 1800.00 | 3.50 | 50.00% | 1.91 / 4.01 | $5.4000 |
| `lexical_topk` (BM25) | 633.50 | 61.11% | 16.67% | 1256.83 | 2.50 | 66.67% | 20.11 / 75.07 | $3.7705 |
| `symbol_graph_repomap` (PPR) | 644.67 | **100.00%** | **100.00%** | **764.67** | **1.00** | **100.00%** | 81.59 / 221.06 | **$2.2940** |

Key deltas (`symbol_graph_repomap` vs matched baselines):
- **Target file recall**: `+38.89` percentage points vs `lexical_topk` (`100.00%` vs `61.11%`) and `+100.00` pp vs `naive_dump_100`.
- **Full multi-hop target selection**: `100.00%` (`6/6` tasks) vs `16.67%` (`1/6`) for `lexical_topk` and `0.00%` (`0/6`) for `naive_dump_100`.
- **Tokens before first useful edit**: `-39.16%` vs `lexical_topk` (`764.67` vs `1256.83` tokens) and `-57.52%` vs `naive_dump_100` (`1800.00` tokens).
- **Navigation tool calls**: `-60.00%` vs `lexical_topk` (`1.00` vs `2.50` calls) and `-71.43%` vs `naive_dump_100` (`3.50` calls).
- **Downstream task completion**: `100.00%` (`6/6`) vs `66.67%` (`4/6`) for `lexical_topk` and `50.00%` (`3/6`) for `naive_dump_100`.

### Per-Task Breakdown

| Task ID | Language / Signal | Strategy | Recall | Tokens Before 1st Edit | Nav Calls | Completed |
| :--- | :--- | :--- | ---: | ---: | ---: | :---: |
| `ts-payout-subcent-truncation` | TS (active + stack trace + barrel) | `naive_dump_100` | 0.00% | 1690 | 4 | yes |
| `ts-payout-subcent-truncation` | TS (active + stack trace + barrel) | `lexical_topk` | 66.67% | 756 | 3 | yes |
| `ts-payout-subcent-truncation` | TS (active + stack trace + barrel) | `symbol_graph_repomap` | 100.00% | 763 | 1 | yes |
| `ts-diff-receipt-caller-impact` | TS (git diff reverse callers) | `naive_dump_100` | 0.00% | 2170 | 4 | no |
| `ts-diff-receipt-caller-impact` | TS (git diff reverse callers) | `lexical_topk` | 100.00% | 732 | 1 | yes |
| `ts-diff-receipt-caller-impact` | TS (git diff reverse callers) | `symbol_graph_repomap` | 100.00% | 764 | 1 | yes |
| `rust-checkpoint-domain-tag` | Rust (`-->` compiler span, 2-hop crate) | `naive_dump_100` | 0.00% | 2170 | 4 | no |
| `rust-checkpoint-domain-tag` | Rust (`-->` compiler span, 2-hop crate) | `lexical_topk` | 33.33% | 2201 | 4 | no |
| `rust-checkpoint-domain-tag` | Rust (`-->` compiler span, 2-hop crate) | `symbol_graph_repomap` | 100.00% | 763 | 1 | yes |
| `py-reconciler-zero-quote-crash` | Python (traceback, 2-hop relative) | `naive_dump_100` | 0.00% | 2170 | 4 | no |
| `py-reconciler-zero-quote-crash` | Python (traceback, 2-hop relative) | `lexical_topk` | 66.67% | 759 | 2 | yes |
| `py-reconciler-zero-quote-crash` | Python (traceback, 2-hop relative) | `symbol_graph_repomap` | 100.00% | 766 | 1 | yes |
| `go-escrow-duplicate-signer-quorum` | Go (same-pkg + internal pkg call) | `naive_dump_100` | 0.00% | 1170 | 2 | yes |
| `go-escrow-duplicate-signer-quorum` | Go (same-pkg + internal pkg call) | `lexical_topk` | 66.67% | 888 | 1 | yes |
| `go-escrow-duplicate-signer-quorum` | Go (same-pkg + internal pkg call) | `symbol_graph_repomap` | 100.00% | 764 | 1 | yes |
| `ts-burst-limiter-ntp-rollback` | TS (active + mentioned symbol, 2-hop) | `naive_dump_100` | 0.00% | 1430 | 3 | yes |
| `ts-burst-limiter-ntp-rollback` | TS (active + mentioned symbol, 2-hop) | `lexical_topk` | 33.33% | 2205 | 4 | no |
| `ts-burst-limiter-ntp-rollback` | TS (active + mentioned symbol, 2-hop) | `symbol_graph_repomap` | 100.00% | 768 | 1 | yes |

### Negative Control Results (50 standalone Python scripts, 0 cross-file symbol edges)

| Metric | Value |
| :--- | ---: |
| `graphEdgeCount` | `0` |
| `lexical_topk` mean recall | `100.00%` |
| `symbol_graph_repomap` mean recall | `100.00%` |
| `recallLiftOverLexical` | `0.00%` |
| `lexical_topk` / `symbol_graph_repomap` completion | `100.00%` / `100.00%` |

### Local Reproduction

```bash
npm run build:lib && npm run build:cli
node --experimental-vm-modules node_modules/jest/bin/jest.js test/repomap/repo-map.test.ts
node --input-type=module -e 'import { evaluateRepoMapBenchmark } from "./dist/index.js"; console.log(JSON.stringify(evaluateRepoMapBenchmark(), null, 2));'
```
