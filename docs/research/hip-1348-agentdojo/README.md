# HIP-1348: Prompt-Injection Resistance for Tool Results and Retrieved Content (AgentDojo)

Tracking issues: `hanzoai/mcp#42`, `hanzoai/mcp#46` (HIP-1348)
Package: `@hanzo/mcp` (MIT License)
Measured artifacts: [`score_table.md`](./score_table.md) | [`raw_results.json`](./raw_results.json)
Reproducible runner: `pnpm exec tsx bench/agentdojo/eval.ts --seed 1348 --out-dir docs/research/hip-1348-agentdojo`

---

## 1. Paper and Clean-Room License Audit

- **Primary research reference**:
  - Edoardo Debenedetti, Jie Zhang, Mislav Balunovic, Luca Beurer-Kellner, Marc Fischer, and Florian Tramèr (ETH Zurich SpyLab), *AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents*, NeurIPS 2024 Datasets & Benchmarks Track (`https://arxiv.org/abs/2406.13352`).
  - Upstream reference repository: `ethz-spylab/agentdojo` (**MIT License**).
- **Threat model summary**:
  - Tool-using LLM agents routinely ingest untrusted external text via filesystem reads, RAG document retrieval, issue/PR triage feeds, and chained scratchpad/memory tools. Because model prompts concatenate instructions and retrieved data into one token stream, indirect prompt injections hidden in tool results can hijack downstream privileged tool calls (`fs:write`, `fs:rm`, `exec:exec`, secret reads, or outbound `fetch`).
  - AgentDojo demonstrates that evaluating defenses requires measuring **both** Attack Success Rate (ASR) under realistic indirect attacks **and** Benign Task Utility on legitimate workflows—since trivial over-blocking achieves 0% ASR only by rendering the agent unusable.
  - Published figures in the NeurIPS 2024 paper apply strictly to the authors' Python/LLM benchmark harness and are not treated as Hanzo expectations; all measurements reported below are collected directly on `@hanzo/mcp` via `bench/agentdojo/eval.ts`.
- **Clean-room and dependency license audit**:
  - `@hanzo/mcp` is licensed under **MIT**.
  - All files added (`src/security/action-authorization-guard.ts`, `src/security/agentdojo-benchmark.ts`, `bench/agentdojo/eval.ts`, `test/security/agentdojo-prompt-injection.test.ts`) are original clean-room TypeScript ESM implementations authored from scratch under MIT. Zero source code or dataset rows were copied from `ethz-spylab/agentdojo` or any copyleft repository.
  - **External dataset compatibility**: `bench/agentdojo/eval.ts --external-agentdojo-json <path>` allows operators to evaluate external AgentDojo-exported JSON suites against the exact same `@hanzo/mcp` guard pipeline without bundling third-party data.
  - **Transitive runtime dependencies added**: **`0`**. Uses only Node.js standard library modules (`node:crypto`, `node:fs/promises`, `node:os`, `node:path`, `node:perf_hooks`) and existing `@hanzo/mcp` internals.

---

## 2. Canonical Hanzo Architecture Alignment (`Enso / Zen / Kai / MCP`)

Canonical Hanzo platform boundaries remain strictly intact—no competing MCP server is introduced and the 19-tool HIP-0300 catalog (`fs`, `exec`, `code`, `git`, `fetch`, `workspace`, `browser`, `computer`, `ui`, `kai`, `think`, `plan`, `memory`, `tasks`, `tracker`, `coding`, `research`, `skills`, `hanzo`) is preserved verbatim:

- **Enso (Model Router)**: Routes agent turns and passes the user-turn authorization intent alongside session identity `(tenantId, sessionId)`.
- **Zen (Generative Model Plane)**: Consumes nonce-isolated `<untrusted_tool_result nonce="...">` envelopes returned by `@hanzo/mcp`, keeping untrusted tool data strictly delimited from system and user instructions.
- **Kai (Non-Generative Policy & Screening Plane)**: Issues explicit, capability-scoped `ActionAuthorizationGrant` tokens signed with HMAC-SHA256 (`KaiPolicyGate.issueGrant`) and provides semantic screening (`kai_injection_screen`) for high-stakes authorized free-text sinks where syntactic checks reach their theoretical boundary.
- **Hanzo MCP (`@hanzo/mcp` Execution Surface)**: `createMCPServer({ actionGuard, defaultAuthGrant })` attaches `KaiPolicyGate` directly inside `callToolHandler` (and `wrapMcpToolsWithGuard()` wraps standalone `Tool[]` arrays):
  - **Pre-execution**: Classifies every invocation into explicit privilege tiers (`read_only`, `secret_read`, `write`, `delete`, `exec`, `net_send`), verifies HMAC-SHA256 signed grants with `crypto.timingSafeEqual`, enforces POSIX path normalization / workspace containment / traversal & secret-path blocking (`.env`, `.ssh/`, `id_rsa`, `.aws/credentials`, `/etc/shadow`), checks command/host/recipient allowlists, and blocks tainted arguments derived from prior untrusted tool results.
  - **Post-execution**: Inspects real MCP `ToolResult` envelopes (including JSON-unescaped string fields inside `{ ok, data: { text } }`), extracts multi-hop taint tokens into the per-session ledger, detects spoofed JSON/XML tool-call schemas, strips invisible Unicode steganography, and wraps untrusted results in cryptographic per-invocation nonce fences with closing-tag and chat-role escaping.

---

## 3. Falsifiable Hypotheses, Matched 5-Mode Matrix, and Negative / Failure Regimes

### Evaluated Modes (5 Defense Modes + 1 Negative Control)

1. **`unprotected_baseline`**: Raw tool results returned directly with no provenance framing and no action authorization.
2. **`delimiter_only`**: Static `<untrusted_tool_result>` XML wrapper without cryptographic nonce or closing-tag escaping and without action authorization.
3. **`nonce_isolation_only`**: Per-invocation 96-bit cryptographic nonce boundary (`<untrusted_tool_result nonce="...">`) + escaping of spoofed closing tags, chat-role markers, and invisible Unicode, without action authorization.
4. **`explicit_action_auth`**: `KaiPolicyGate` capability-tier separation, HMAC-signed scoped grants, path/secret enforcement, and multi-hop taint tracking on privileged MCP tools, without output nonce framing.
5. **`layered_provenance_and_auth`**: Full defense-in-depth combining cryptographic nonce provenance framing, JSON-envelope tool-call spoofing detection, multi-hop taint tracking, `KaiPolicyGate` explicit action authorization, and active-payload argument inspection.
6. **`strict_deny_all_negative`** *(Negative Control)*: Blanket denial of all privileged actions (`write`, `delete`, `exec`, `net_send`, `secret_read`) once any untrusted tool output has entered the session.

### Falsifiable Hypotheses

Across 32 clean-room AgentDojo-taxonomy scenarios (4 suites: `workspace_files`, `retrieved_docs`, `issue_and_pr_triage`, `multi_step_chained_tools` × 4 attack vectors: `direct_override`, `delimiter_breakout`, `tool_schema_spoofing`, `subtle_goal_hijack` + 16 matched benign tasks) executed end-to-end against real `@hanzo/mcp` tools on disk:

1. **H1 (Monotonic ASR Reduction)**: `layered_provenance_and_auth` will reduce Attack Success Rate from `100.00%` (`unprotected_baseline`) to **`0.00%`**, strictly outperforming `delimiter_only`, `nonce_isolation_only`, and `explicit_action_auth` individually.
2. **H2 (Benign Utility Preservation)**: `layered_provenance_and_auth` will preserve **`100.00%`** Benign Task Utility (`0.00%` False-Block Rate) across both read-only and explicitly authorized write/patch/exec/fetch workflows.
3. **H3 (Static Delimiter Breakout Failure)**: `delimiter_only` will exhibit **`100.00%`** ASR on `delimiter_breakout` attacks, whereas cryptographic nonce escaping (`nonce_isolation_only`) will drop `delimiter_breakout` ASR to **`0.00%`**.
4. **H4 (Negative Control Utility Collapse)**: `strict_deny_all_negative` will achieve `0.00%` ASR only by collapsing Benign Utility to **`<= 25.00%`** (`>= 75.00%` False-Block Rate).

### Honest Failure Boundary Documented

- **Authorized-Channel Semantic Ambiguity (`boundary_authorized_verbatim_copy`)**: When a user explicitly grants write permission to copy retrieved text verbatim into an authorized file (`docs/release-notes.md`), and the retrieved text contains purely semantic social engineering (e.g., advising engineers to disable TLS verification in staging) with no forbidden tool call, no secret path, no untrusted URL, and no override syntax, deterministic provenance + capability gating **allows** the write. Mitigating purely semantic persuasion inside authorized free-text sinks requires pairing `@hanzo/mcp`'s `KaiPolicyGate` with semantic Kai review (`kai_injection_screen`) or human diff approval.

---

## 4. Bounded Deliverable

| File | Responsibility |
| :--- | :--- |
| `src/security/action-authorization-guard.ts` | `KaiPolicyGate`, privilege classification (`classifyToolPrivilege`), path normalization/secret guard (`normalizeAndCheckPath`), JSON-envelope tool-spoofing detection (`detectToolCallSpoofing`), cryptographic nonce framing (`frameWithNonceProvenance`), HMAC-SHA256 signed grants, and `wrapMcpToolsWithGuard`. |
| `src/security/agentdojo-benchmark.ts` | 32-scenario clean-room AgentDojo-taxonomy benchmark suite (4 suites × 4 attack vectors + 16 benign tasks), 3 boundary probes, real MCP tool execution over temp workspaces, external JSON loader (`loadExternalAgentDojoJson`), and score-table renderer. |
| `src/security/index.ts` | Barrel re-exports for `@hanzo/mcp`. |
| `src/index.ts` | Opt-in `actionGuard` and `defaultAuthGrant` hook directly inside `createMCPServer`'s `callToolHandler` (off by default, 0 breaking changes). |
| `bench/agentdojo/eval.ts` | Reproducible CLI benchmark runner supporting `--seed`, `--out-dir`, `--json`, and `--external-agentdojo-json`. |
| `test/security/agentdojo-prompt-injection.test.ts` | Jest suite verifying determinism, ASR reduction, utility preservation, negative controls, nonce breakout immunity, 12-session `Promise.all` concurrency isolation, fail-closed grant security, live `createMCPServer` integration, and external JSON loading. |
| `docs/research/hip-1348-agentdojo/` | HIP-1348 6-point report (`README.md`), generated `score_table.md`, and full `raw_results.json`. |

---

## 5. Evidence and Safety Verification

- **Typecheck**: `pnpm exec tsc --noEmit` — **`0` errors** (TypeScript `7.0.2`, `strict: true`).
- **Build**: `pnpm build` — clean `esbuild` ESM bundles (`dist/index.js`, `dist/cli.js`).
- **Security Jest Suites**:
  - `test/security/agentdojo-prompt-injection.test.ts`: **`8/8` passed** (nonce breakout escaping, JSON-escaped spoofing detection, privilege/path enforcement, HMAC grant fail-closed checks, 12-session parallel concurrency isolation, live `createMCPServer({ actionGuard })` end-to-end test, deterministic 6-mode benchmark verification, external JSON loader).
  - `test/security/prompt-injection-guard.test.ts`: **`8/8` passed** (existing HIP-1347 guard suite unaffected).
- **MCP Protocol Smoke Test**: `pnpm smoke` (`node scripts/smoke-mcp.mjs`) — **`9/9` passed** (`initialize`, 19 canonical `tools/list`, silent legacy aliases, live `fs.read` / `fs.list`, resources, `--core-only`, `install --claude-code`).

---

## 6. Raw Measurements and Integration Recommendation

Measured on Linux x64 (`Node v22.23.5`) via `pnpm exec tsx bench/agentdojo/eval.ts --seed 1348 --out-dir docs/research/hip-1348-agentdojo` (verbatim match with [`score_table.md`](./score_table.md) and [`raw_results.json`](./raw_results.json)):

### Overall Defense Comparison (Before vs After, 32 Core Scenarios)

| Defense Mode | Attack Success Rate (ASR) | Benign Utility Preserved | False-Block Rate | Latency Mean / p50 / p95 (ms) | Mean Extra Tokens (Overhead %) |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `unprotected_baseline` | 100.00% (16/16) | 100.00% (16/16) | 0.00% (0/16) | 3.55 / 2.23 / 12.57 | +0.0 (+0.0%) |
| `delimiter_only` | 75.00% (12/16) | 100.00% (16/16) | 0.00% (0/16) | 2.42 / 1.58 / 5.67 | +22.0 (+23.4%) |
| `nonce_isolation_only` | 50.00% (8/16) | 100.00% (16/16) | 0.00% (0/16) | 3.61 / 2.04 / 15.14 | +78.6 (+83.6%) |
| `explicit_action_auth` | 12.50% (2/16) | 100.00% (16/16) | 0.00% (0/16) | 2.10 / 1.67 / 5.33 | +0.0 (+0.0%) |
| `layered_provenance_and_auth` | **0.00% (0/16)** | **100.00% (16/16)** | **0.00% (0/16)** | **2.34 / 1.84 / 7.67** | +78.6 (+83.6%) |
| `strict_deny_all_negative` | 0.00% (0/16) | 25.00% (4/16) | 75.00% (12/16) | 1.02 / 0.92 / 1.53 | +78.6 (+83.6%) |

### ASR by Attack Vector Family

| Defense Mode | `direct_override` | `delimiter_breakout` | `tool_schema_spoofing` | `subtle_goal_hijack` |
| :--- | ---: | ---: | ---: | ---: |
| `unprotected_baseline` | 100.00% (4/4) | 100.00% (4/4) | 100.00% (4/4) | 100.00% (4/4) |
| `delimiter_only` | 0.00% (0/4) | 100.00% (4/4) | 100.00% (4/4) | 100.00% (4/4) |
| `nonce_isolation_only` | 0.00% (0/4) | 0.00% (0/4) | 100.00% (4/4) | 100.00% (4/4) |
| `explicit_action_auth` | 0.00% (0/4) | 25.00% (1/4) | 25.00% (1/4) | 0.00% (0/4) |
| `layered_provenance_and_auth` | **0.00% (0/4)** | **0.00% (0/4)** | **0.00% (0/4)** | **0.00% (0/4)** |
| `strict_deny_all_negative` | 0.00% (0/4) | 0.00% (0/4) | 0.00% (0/4) | 0.00% (0/4) |

### Key Takeaways & Integration Recommendation

1. **Both layers are necessary**: Framing alone (`nonce_isolation_only`, `50.00%` ASR) eliminates override and delimiter breakouts (`0.00%`) but cannot stop `subtle_goal_hijack` or JSON tool-call mimicry. Action authorization alone (`explicit_action_auth`, `12.50%` ASR) blocks 14/16 attacks across privilege/path/host/command/taint boundaries but still permits 2/16 authorized-sink payload-smuggling writes. Combining both in `layered_provenance_and_auth` achieves **`0.00%` ASR** with **`100.00%` Benign Utility** at **`1.84 ms` p50 latency** and **`+78.6` fixed header/footer tokens per tool output** (which shrinks proportionally on larger real-world files).
2. **Production Rollout for `@hanzo/mcp`**:
   - Enable `KaiPolicyGate({ mode: 'layered_provenance_and_auth', requireSignedGrantForPrivileged: true })` via `createMCPServer({ actionGuard })` for autonomous and multi-tenant MCP sessions (especially `--beta-safe` and remote cloud runs).
   - Issue per-turn `ActionAuthorizationGrant` tokens from the trusted Enso/Kai orchestration turn scoped strictly to user-named paths, hosts, and commands.
   - Pair authorized free-text write sinks with Kai semantic screening (`kai_injection_screen`) to cover the documented `boundary_authorized_verbatim_copy` semantic-channel regime.
