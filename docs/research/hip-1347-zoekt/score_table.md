# HIP-1347 Trigram Code Search (Zoekt) — Measured Score Table

- **Corpus**: 411 on-disk files, **178,556 lines** (6.24 MiB) — real repository (120 files / 58,532 lines) + seeded multi-language corpus (291 files / 120,024 lines, seed `1347`, 20 CRLF files)
- **Languages**: `cuda`, `go`, `python`, `rust`, `text`, `toml`, `typescript`, `yaml`
- **Query Suite**: 40 matched queries (10 exact, 8 case-insensitive, 8 regex, 7 path, 7 symbol; retrieval budget `topK = 20`)
- **Downstream Agent Harness**: 12 locate-and-patch tasks (shared budget `topK = 5`, identical deterministic patch verifier)
- **Environment**: Node `v22.23.5` (linux/x64), `ripgrep 14.1.0`

## 1. Matched 4-Engine Comparison

| Engine | Cold Build (ms) | Exact Recall | CI Recall | Regex Recall | Path Recall | Symbol Recall | Overall Recall | Mean Latency (ms) | p95 Latency (ms) | Regex Throughput (lines/s) | Downstream Agent Tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `linear_fs_scan_baseline` | 0.00 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | **100.0%** | **59.05** | 105.17 | 3,728,460 | **12/12 (100%)** |
| `ripgrep_cli_baseline` | 0.00 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | **100.0%** | **14.74** | 18.62 | 9,983,697 | **12/12 (100%)** |
| `embedding_only_negative` | 144.51 | 37.9% | 37.0% | 42.7% | 85.7% | 38.1% | **47.1%** | **1.07** | 3.69 | 313,014,104 | **0/12 (0%)** |
| `zoekt_trigram_session` | 910.15 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | **100.0%** | **0.75** | 1.87 | 230,215,308 | **12/12 (100%)** |

## 2. Incremental Update Cost & Branch-Index Freshness

| Metric | Measured Value |
|---|---:|
| Single-file modified `upsertFile` latency | **4.291 ms** |
| Single-file unchanged SHA-256 skip latency | **0.118 ms** |
| Branch delta (`main` -> `feat/cuda-capture-v2`, 8 upserts, 1 delete, 404 carried) | **10.99 ms** |
| Branch-index freshness recall (new symbols/errors found, deleted excluded) | **100.0%** |
| Base branch isolation (`main` unaffected by `feat/cuda-capture-v2`) | **PASS** |

## 3. Honest Negative & Boundary Regimes

| Boundary Regime | Measured Result | Honest Assessment |
|---|---|---|
| `short_or_wildcard_regex_fallback` | Fallback triggered 4/4; recall 100.0%; mean 9.37 ms vs linear 72.34 ms | Queries with <3-char literals or pure wildcards yield zero selective trigrams and fall back safely to authorized candidate scan (100% recall preserved, no fast-path speedup claimed). |
| `cold_index_single_query_amortization` | Cold+1 query = 55.26 ms vs single linear scan = 3.24 ms; break-even = **18 queries** | For a one-shot query on a 40-file (14,025-line) repo, cold index build + 1 query (55.26 ms) exceeds a single linear scan (3.24 ms); trigram indexing pays off after ~18 queries in a warm session. |

## 4. Security, Tenant Isolation & Derived Rebuildability Audit

| Invariant | Status | Evidence |
|---|---|---|
| Pre-return multi-tenant ACL isolation | **PASS** | 0 cross-tenant hits leaked across identical planted `CUDA_ERROR_STREAM_CAPTURE_INVALIDATED` blobs |
| Derived index wipe & deterministic rebuild | **PASS** | Rebuild in 760.82 ms; digest `892cb402d0962ea3...` === `892cb402d0962ea3...` |
