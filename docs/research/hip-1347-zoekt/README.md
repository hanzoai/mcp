# HIP-1347 Research Report: Trigram Code Search for Exact, Regex, and Symbol Queries (Zoekt)

> **Issue**: `hanzoai/mcp#35` (`p0`, `hip-1347`, `code-intel`, `research`)  
> **Reproduce**: `pnpm exec tsx bench/zoekt/eval.ts --seed 1347 --out-dir docs/research/hip-1347-zoekt`

---

## 1. Reference Architecture & License Audit

This implementation is a **100% clean-room TypeScript ESM module** (`src/search/trigram-index.ts`) with **zero copied third-party code** and **zero new runtime dependencies** (`package.json` unchanged).

| Reference System | License | Commercial Compatibility | Usage in This PR |
|---|---|---|---|
| **Zoekt** (`sourcegraph/zoekt`) | Apache-2.0 | Compatible (permissive with attribution) | Architectural reference only (trigram inverted postings, branch-scoped derived snapshots, filename/symbol/regex literal planning, exact-match fast path). Zero source copied. |
| **Tantivy** (`quickwit-oss/tantivy`) | MIT | Compatible (permissive with attribution) | Architectural reference only (derived rebuildable inverted index over immutable canonical documents). Zero source copied. |
| **Hanzo Rust Trigram** (`rust/trigram`) | MIT (in-repo) | In-repo baseline | Existing Rust tgrep-core wrapper inspected for ranking semantics (`definition` > `reference`, CRLF normalization, excerpt caps). |

---

## 2. Matched Baselines, Shared Corpus, and Retrieval Budget

All four engines are benchmarked over the **exact same on-disk corpora**, **exact same 40-query suite**, **exact same retrieval budget (`topK = 20`)**, and **exact same 12-task downstream agent locate-and-patch harness (`topK = 5`)**:

- **Real Repository Tree**: `src/` + `rust/trigram/` (120 files, 58,532 lines)
- **Seeded Multi-Language Corpus** (`--seed 1347`): 291 files, 120,024 lines spanning TypeScript, Rust, Go, Python, CUDA (`.cu`), YAML, and TOML, including 20 CRLF-terminated files.
- **Total Indexed Surface**: **411 files / 178,556 lines** (6.24 MiB).

Matched engines compared:
1. `linear_fs_scan_baseline`: Unindexed full directory walk + file read + exact/regex/symbol/path match per query (serves as exactness ground truth).
2. `ripgrep_cli_baseline`: Real `rg` CLI subprocess (ripgrep 14.1.0) invoked per query over the exact same on-disk directories.
3. `embedding_only_negative`: Documented negative control — 256-dim dense-hashed sub-token cosine vector retriever **without** an exact literal fast path.
4. `zoekt_trigram_session`: Warm persistent `TrigramCodeIndex` with 24-bit packed ASCII + Unicode trigram inverted postings, sound regex required-literal planner, symbol definition index, branch deltas, and strict pre-return ACL filtering.

---

## 3. Falsifiable Hypothesis & Honest Boundary Regimes

**Hypothesis**: For exact error literals (`CUDA_ERROR_STREAM_CAPTURE_INVALIDATED`), selective regular expressions, file paths, and symbol definitions across multi-language repositories, a warm trigram inverted index (`zoekt_trigram_session`) achieves **100% recall matching full linear scan** at **>10x lower query latency** than unindexed scans and **dramatically higher downstream agent task completion** than pure semantic/embedding retrieval — while maintaining zero cross-tenant ACL leakage and bit-identical rebuildability.

**Documented Negative / Boundary Regimes (where trigram indexing does NOT win)**:
- **`short_or_wildcard_regex_fallback`**: Queries with <3-char literals or pure wildcards yield zero selective trigrams and fall back safely to authorized candidate scan (100% recall preserved, no fast-path speedup claimed). Measured: fallback triggered on 4/4 non-selective queries (`ab`, `x1`, `a.*b`, `[0-9]{4}`), recall **100.0%**, mean latency 9.37 ms vs linear 72.34 ms.
- **`cold_index_single_query_amortization`**: For a one-shot query on a 40-file (14,025-line) repo, cold index build + 1 query (55.26 ms) exceeds a single linear scan (3.24 ms); trigram indexing pays off after ~18 queries in a warm session.

---

## 4. Bounded PR Deliverable & Derived Index Architecture

Files delivered on this branch:
- `src/search/trigram-index.ts`: Clean-room `TrigramCodeIndex`, `planRegexTrigrams`, `extractSymbolsFromContent`, `isDocumentAuthorized`, workspace indexing via `fs.realpathSync`, branch delta snapshots, and derived rebuildability.
- `src/search/zoekt-benchmark.ts`: Reproducible 4-engine benchmark harness, 40-query ground-truth suite, 12-task downstream agent evaluator, and report generators.
- `src/search/index.ts` & `src/index.ts`: Clean, non-colliding ESM exports (no changes to canonical MCP tool catalog or `package.json`).
- `bench/zoekt/eval.ts`: Deterministic CLI runner writing `raw_results.json`, `score_table.md`, and `README.md`.
- `test/search/zoekt-trigram-index.test.ts`: Comprehensive Jest suite covering exact/CRLF recall, regex/path/symbol queries, branch freshness, pre-return multi-tenant ACL isolation, 10-tenant concurrency, symlinked `TMPDIR` safety, derived rebuildability, and negative regimes.

---

## 5. Correctness, Concurrency, Pre-Return ACL Isolation & Derived Rebuildability Evidence

- **Exact-Match Fast Path**: `CUDA_ERROR_STREAM_CAPTURE_INVALIDATED` hits immediately across `.cu`, `.yaml`, `.toml`, `.rs`, `.go`, `.py`, `.ts`, and CRLF files with **100.0% recall** (vs **37.9%** for `embedding_only_negative`).
- **Pre-Return Tenant & ACL Filtering**: Every query partitions postings strictly by `TrigramAccessContext` (`tenantId`, `allowedScopes`, `allowedRepos`, `branch`) **before** scanning content or returning counts. Live audit leaked **0** hits across tenants sharing identical error strings.
- **Derived Rebuildability**: Wiping all derived postings/symbol tables (`wipeDerivedIndex()`) and rebuilding from canonical source blobs (`rebuildFromCanonicalSources()`) completed in **760.82 ms** and produced bit-identical SHA-256 index digests (`892cb402d0962ea3...`).
- **Branch Freshness & Incremental Updates**: Modified single-file `upsertFile` took **4.291 ms**; unchanged SHA-256 skip took **0.118 ms**; branch delta (`main` -> `feat/cuda-capture-v2`) achieved **100.0% freshness recall** with base branch isolation **PASS**.

---

## 6. Headline Measurements & HIP-1347 Status

- **Warm Query Speedup**: `zoekt_trigram_session` mean latency **0.75 ms** (p95 **1.87 ms**) — **78.6x faster** than `linear_fs_scan_baseline` (59.05 ms) and **19.6x faster** than per-query `ripgrep_cli_baseline` (14.74 ms).
- **Regex Throughput**: **230,215,308 lines/sec** (8048.39 MiB/s) across selective regex queries.
- **Downstream Agent Locate-and-Patch Success**: `zoekt_trigram_session` **12/12 (100%)** vs `embedding_only_negative` **0/12 (0%)**.
- **HIP-1347 Status**: **COMPLETE & VERIFIED** — see [`score_table.md`](./score_table.md) and [`raw_results.json`](./raw_results.json) for full machine-readable measurements.
