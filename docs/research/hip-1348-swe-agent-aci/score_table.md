# HIP-1348 SWE-agent ACI Benchmark Score Table

- **Seed**: `1348`
- **Suite**: 24 real multi-file on-disk tasks (TypeScript, JavaScript, Python, JSON) via live `@hanzo/mcp` (`fs`, `exec`, `code`)
- **Fixed Budgets**: `maxSteps=10`, `contextTokenBudget=24000`, `windowSize=100`
- **Runtime**: Node `v22.23.5` on `linux/x64`

## Matched 5-Regime Comparison

| Regime | Task Completion Rate | Patch Correctness (Unit-Test Verified) | Mean Tool Calls | Mean Response Tokens | Mean Response Bytes | Syntax-Error Rollback Prevention | Mean Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `raw_unbounded_cli` | 66.7% (16/24) | 75.0% (18/24) | 5.67 | 17876.0 | 71495.4 | 0.0% (0/12) | 731.89 ms |
| `naive_head_truncation` | 4.2% (1/24) | 4.2% (1/24) | 2.13 | 661.8 | 2645.8 | 0.0% (0/12) | 451.25 ms |
| `windowed_viewer_only` | 100.0% (24/24) | 100.0% (24/24) | 6.38 | 10427.3 | 41698.9 | 0.0% (0/12) | 757.74 ms |
| `swe_agent_aci_full` | 100.0% (24/24) | 100.0% (24/24) | 4.88 | 1554.3 | 6210.2 | 100.0% (12/12) | 692.91 ms |
| `over_compressed_negative` | 0.0% (0/24) | 0.0% (0/24) | 1.00 | 30.0 | 120.0 | 0.0% (0/12) | 468.22 ms |

## Honest Negative & Boundary Regimes

| Boundary Regime | Observation | Key Measurement |
| :--- | :--- | :--- |
| `semantic_logic_error_passes_syntax_lint` | Syntactically valid edits with wrong return/config logic pass fast syntax lint and still require real unit-test execution | Syntax-lint pass: **100.0%** (4/4); Caught by unit tests: **100.0%**; Repaired via test feedback: **100.0%** |
| `tiny_single_file_overhead_regime` | On tiny (<20-line) files with clean 1-line logs and zero syntax hazards, ACI metadata headers add small byte overhead with zero turn savings | Completion: **100.0%** vs 100.0%; Turns: **4.00** vs 4.00; Mean bytes: **734.3 B** vs 60.0 B (**+674.3 B**, +1123.8%) |
