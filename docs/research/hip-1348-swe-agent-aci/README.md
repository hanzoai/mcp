# HIP-1348 Research Report: Agent-Computer Interface (ACI) Optimization (SWE-agent)

- **Issue**: `hanzoai/mcp#44` (HIP-1348, research bounty)
- **Package**: `@hanzo/mcp` (MIT License)
- **Reproducibility Command**: `pnpm exec tsx bench/aci/eval.ts --seed 1348 --out-dir docs/research/hip-1348-swe-agent-aci`
- **Artifacts**: [`score_table.md`](./score_table.md) | [`raw_results.json`](./raw_results.json)

---

## 1. Primary Paper, Design Summary & License Audit

- **Primary Paper**: John Yang, Carlos E. Jimenez, Alexander Wettig, Kilian Lieret, Shunyu Yao, Karthik Narasimhan, and Ofir Press, *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering*, **NeurIPS 2024**, https://papers.nips.cc/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html
- **Upstream Reference Repository**: `princeton-nlp/SWE-agent` (**MIT License**)
- **Core Paper Insight**: Standard POSIX CLI/editor outputs (`cat`, verbose test/compiler stdout, unlinted string edits) are designed for humans with unconstrained terminal scrollback, not fixed-context language model agents. Designing an explicit **Agent-Computer Interface (ACI)** — combining bounded line-numbered file viewports, syntax-linter-gated atomic editing with rollback, and structured compact command feedback — improves software-engineering task completion while cutting wasted context tokens and recovery turns.
- **Published Numbers Disclaimer**: All metrics published in the NeurIPS 2024 SWE-agent paper belong strictly to the original authors' SWE-bench evaluation environment and are **not** Hanzo performance claims. Every figure reported in this directory is freshly measured on `@hanzo/mcp` via `bench/aci/eval.ts`.
- **Clean-Room & License Audit**:
  - All TypeScript code in `src/aci/swe-agent-aci.ts`, `src/aci/swe-agent-benchmark.ts`, `bench/aci/eval.ts`, and `test/aci/swe-agent-aci.test.ts` is a 100% clean-room implementation authored from scratch under the repository's **MIT License**.
  - Zero lines of code were copied from `princeton-nlp/SWE-agent`, no external datasets or model weights were imported, and no patent encumbrances apply.
  - **New runtime dependencies**: `0` (`package.json` is completely unchanged; only Node.js built-ins `crypto`, `fs`, `os`, `path`, `perf_hooks`, `vm`, `child_process` and internal `@hanzo/mcp` types are used).

---

## 2. Reproducible Baselines & Canonical Hanzo Stack Alignment

### Canonical Architecture Boundaries
This deliverable strictly preserves Hanzo's canonical architecture without introducing parallel services or mutating defaults:
- **Storage & Execution (`vfs -> Hanzo S3 -> Visor`)**: All file reads and atomic edits resolve workspace roots via `fs.realpathSync` and operate through standard workspace files / `fs` & `exec` MCP tools without creating parallel filesystems or storage daemons.
- **Lifecycle, Routing, Generation & Decisions**: Hanzo Cloud owns lifecycle and billing, Enso routes models, Zen generates code, and Kai makes structured non-generative decisions. `AciResponseAdapter` is strictly **opt-in** and wraps the canonical `fs`, `exec`, and `code` tools in place without altering the default 19-tool HIP-0300 surface.

### Matched 5-Regime Experimental Matrix
Every regime executes the **identical deterministic edit-planner / fault-recovery agent loop** against the **identical 24 real multi-file temporary repositories on disk** (TypeScript, JavaScript, Python, and JSON across 7 bug classes: off-by-one, wrong operator, missing null/empty guard, broken import/JSON config, multi-file symbol rename, 720–820 line surgical edit, and 520–550 line noisy ANSI test-log triage) using **real `@hanzo/mcp` tools** (`fs`, `exec`, `code` via `createMCPServer()`) and fixed budgets (`maxSteps=10`, `contextTokenBudget=24000`):

1. **`raw_unbounded_cli`**: Raw full-file `fs.read`, unlinted `fs.apply_patch`, raw verbose `exec` stdout/stderr.
2. **`naive_head_truncation`**: Blindly truncates tool outputs to the first `1200` characters — tests whether naive truncation destroys tail error locations.
3. **`windowed_viewer_only`**: Adds bounded 100-line `viewWindow` only; retains unlinted edits and raw verbose command output.
4. **`swe_agent_aci_full`**: Full SWE-agent ACI via `AciResponseAdapter` (`viewWindow` + `lintedEdit` with atomic syntax-error rollback + `formatCompactToolResponse` budgeted envelopes).
5. **`over_compressed_negative`**: Documented negative control compressing responses to `120` chars while stripping file paths and line anchors.

---

## 3. Falsifiable Hypothesis, Metrics & Expected Failure Modes

### Hypothesis
On realistic multi-file repositories (320–820 lines per target file, 220–550 lines of verbose test output, and seeded draft syntax hazards on 50% of tasks) under a fixed 24000-token context budget:
1. `swe_agent_aci_full` will achieve higher **Task Completion Rate** and **Unit-Test-Verified Patch Correctness** than `raw_unbounded_cli`, `naive_head_truncation`, and `over_compressed_negative`.
2. `swe_agent_aci_full` will cut **Mean Response Tokens** by `>= 50%` vs `raw_unbounded_cli` while strictly reducing or maintaining **Mean Tool-Call Count** (avoiding wasted test runs on broken syntax).
3. `lintedEdit` will intercept **100%** of injected lexical/structural syntax hazards before writing to disk (`0` corrupted disk writes, original file SHA-256 preserved byte-for-byte).
4. **Falsification / Negative Controls**:
   - `naive_head_truncation` and `over_compressed_negative` will collapse task completion when tail error locations or file/line anchors are dropped.
   - `semantic_logic_error_passes_syntax_lint` will prove that fast syntax linting passes **100%** of syntactically valid logic errors and therefore complements—never replaces—unit-test execution.
   - `tiny_single_file_overhead_regime` will prove that on tiny (<20-line) files with clean 1-line logs and zero syntax hazards, ACI headers add measurable byte overhead with zero turn savings.

---

## 4. Bounded PR Deliverable

| File | Responsibility |
| :--- | :--- |
| `src/aci/swe-agent-aci.ts` | Clean-room `viewWindow`, `StatefulWindowViewer`, `runFastSyntaxLint` (TS/JS/Python/JSON), `lintedEdit` (atomic temp-file rename + syntax rollback), `formatCompactToolResponse`, and opt-in `AciResponseAdapter` |
| `src/aci/swe-agent-benchmark.ts` | Deterministic 24-task real-repo benchmark runner across 5 matched regimes + 2 boundary regimes using live `createMCPServer()` |
| `src/aci/index.ts` | Barrel re-exports preserving all existing ACI exports and default 19-tool HIP-0300 surface |
| `bench/aci/eval.ts` | Reproducible CLI generating `raw_results.json`, `score_table.md`, and `README.md` |
| `test/aci/swe-agent-aci.test.ts` | Jest unit, rollback-SHA256, symlinked-TMPDIR, 10-workspace parallel concurrency, live MCP server, and seeded benchmark tests |
| `docs/research/hip-1348-swe-agent-aci/*` | Complete 6-point HIP-1348 research evidence and raw benchmark outputs |

---

## 5. Correctness, Concurrency, Security & Regression Evidence

- **Correctness (Unit-Test Oracle)**: Every task in all 5 regimes is independently verified by executing the real repository test suite (`node tests/run.mjs` or `python3 tests/run_tests.py`) via `execFileSync` after the agent loop finishes.
- **Atomic Syntax-Error Rollback**: `lintedEdit` gates edits through `runFastSyntaxLint` before persisting via sibling temp-file + `fs.renameSync`. Verified in `test/aci/swe-agent-aci.test.ts` for broken JavaScript, TypeScript, JSON, and Python edits: original file SHA-256 is guaranteed bit-for-bit identical after every rejected edit.
- **Security & Path Confinement**: `resolveWorkspaceRoot` and `resolveSafeWorkspacePath` canonicalize roots via `fs.realpathSync` (guaranteeing identical behavior on Linux and macOS symlinked `TMPDIR`) and reject `../` path traversal and symlink escapes outside the workspace root.
- **Parallel Multi-Session Concurrency**: Verified via `Promise.all` across 10 isolated workspaces executing concurrent `viewWindow`, `lintedEdit`, and `AciResponseAdapter` calls with zero cross-workspace state bleed.
- **Regression Verification**:
  - `pnpm exec tsc --noEmit` — 0 errors
  - `pnpm build` — clean ESM library & CLI bundle
  - `pnpm smoke` — 9/9 canonical 19-tool HIP-0300 integration checks passing
  - Jest suites: `test/aci/swe-agent-aci.test.ts`, `test/aci/compact-response.test.ts`, `test/aci-swe-agent.test.ts`, `test/annotations.test.ts`

---

## 6. Raw Measurements, Analysis & HIP-1348 Integration Recommendation

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

### Key Measured Deltas (`swe_agent_aci_full` vs Matched Baselines)
- **Task Completion & Patch Correctness**: `swe_agent_aci_full` achieved **100.0%** completion / **100.0%** verified patch correctness vs **66.7%** (`raw_unbounded_cli`), **4.2%** (`naive_head_truncation`), **100.0%** (`windowed_viewer_only`), and **0.0%** (`over_compressed_negative`).
- **Context Efficiency**: Mean response tokens changed by **-91.3%** (17876.0 -> 1554.3 tokens; bytes -91.3%: 71495.4 -> 6210.2 B).
- **Tool-Call Efficiency**: Mean tool calls moved from **5.67** (`raw_unbounded_cli`) and **6.38** (`windowed_viewer_only`) to **4.88** (`swe_agent_aci_full`, delta -0.79 vs raw).
- **Syntax-Error Prevention**: Intercepted **12/12** (**100.0%**) draft syntax hazards with **0** corrupted disk writes (vs **11** in `raw_unbounded_cli` and **12** in `windowed_viewer_only`).
- **Honest Boundary Findings**:
  - `semantic_logic_error_passes_syntax_lint`: **100.0%** of semantic-only bugs passed fast syntax lint and required unit-test execution (**100.0%** caught by tests, **100.0%** repaired).
  - `tiny_single_file_overhead_regime`: On tiny (<20-line) files with clean 1-line logs, ACI added **+674.3 bytes** (+1123.8%) with identical turn counts (**4.00** vs **4.00**).

### HIP-1348 Integration Recommendation
**Recommend opt-in production adoption** via `AciResponseAdapter` (e.g., behind a `--aci` / `toolConfig` opt-in flag in future implementation bounties) for multi-file coding sessions where files exceed ~100 lines or test logs exceed ~50 lines. Keep raw passthrough available for tiny single-file edits or callers needing exact byte-for-byte stdout, and always pair `lintedEdit` with real test/compiler execution (`exec`) to catch semantic regressions.
