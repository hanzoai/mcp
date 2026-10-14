# Hanzo Kai Native MCP Cookbook

Production cookbook and architecture patterns for embedding **Kai**—Hanzo's decision and control intelligence—directly into AI coding agents (Claude Code, OpenAI Codex, Cursor, and native Hanzo Dev).

Kai is not a generative conversational model. It is a typed decision engine that reads multimodal context and evaluates discrete choices, ordinal rankings, and calibrated probabilities in single-digit to low double-digit milliseconds. When paired with deterministic zero-inference fast paths, Kai eliminates unnecessary LLM turns and bounds agent execution loops.

---

## 8 Purpose-Built Native Kai MCP Tools

The `@hanzo/mcp` package exports 8 purpose-built native MCP tools alongside the general `kai_decide` interface:

| MCP Tool Name | Primary Function | Fast-Path / Latency |
|---|---|---|
| `kai_tool_select` | Shortlists relevant tools from actual registered schemas; fixes casing/naming mismatches (e.g. `bash` $\to$ `Bash`). | Zero-inference alias (<0.1ms) / Kai rank (~25ms) |
| `kai_next_action` | Emits an executable structured Action (`type`, `target`, `payload`) or calibrately abstains. | Zero-inference match (<0.1ms) / Kai (~7–30ms) |
| `kai_command_guard` | Enforces command safety policy on monotonic lattice: `allow < ask < deny`. | Policy allow/deny (<0.1ms) / Kai risk eval (~30–60ms) |
| `kai_injection_screen` | Screens untrusted inputs, PR comments, or web content for prompt injection/override patterns. | Regex scan (<0.1ms) / Kai classification (~15ms) |
| `kai_log_triage` | Parses compiler/test outputs, identifies error category, and extracts pinpoint failing log spans. | Fast span finder (<0.1ms) / Kai triage (~20ms) |
| `kai_recover` | Evaluates failure fingerprints and selects a recovery strategy; activates circuit breakers on repeated failures. | Loop breaker (<0.1ms) / Kai strategy (~8ms) |
| `kai_extract` | Single-pass structured extraction over discrete enum choices or multi-dimensional criteria. | Kai calibrated extraction (~20ms) |
| `kai_decide` | Multi-question pipeline evaluating up to 100 questions (choice, score, noul) in a single joint forward pass. | Joint tensor forward pass (~10–15ms) |

---

## 15 Runnable Recipes

Each recipe in this directory is an executable TypeScript module that runs against a live Kai endpoint (`http://127.0.0.1:18977/v1` or remote `api.hanzo.ai`):

| # | Recipe File | Tool | Purpose | Typical Wall Time |
|---|---|---|---|---|
| 01 | [`01-tool-shortlisting.ts`](./01-tool-shortlisting.ts) | `kai_tool_select` | Shortlist 3–5 tools from 20+ schemas based on task context | 25.7 ms |
| 02 | [`02-zero-inference-fast-path.ts`](./02-zero-inference-fast-path.ts) | `kai_next_action` | Execute deterministic action immediately without model call | 0.1 ms |
| 03 | [`03-shell-command-security-gate.ts`](./03-shell-command-security-gate.ts) | `kai_command_guard` | Classify command safety (`allow < ask < deny`) | 31.0 ms |
| 04 | [`04-prompt-injection-screening.ts`](./04-prompt-injection-screening.ts) | `kai_injection_screen` | Detect prompt injection/override attempts in untrusted text | 15.7 ms |
| 05 | [`05-build-log-triage.ts`](./05-build-log-triage.ts) | `kai_log_triage` | Categorize compiler/test errors and isolate failing spans | 20.2 ms |
| 06 | [`06-failure-loop-breaker.ts`](./06-failure-loop-breaker.ts) | `kai_recover` | Break identical error loops after 3 consecutive failures | 0.1 ms |
| 07 | [`07-structured-schema-extraction.ts`](./07-structured-schema-extraction.ts) | `kai_extract` | Multi-question typed extraction (type, risk, impact) | 21.2 ms |
| 08 | [`08-claude-code-tool-resolution.ts`](./08-claude-code-tool-resolution.ts) | `kai_tool_select` | Resolve lowercase `bash` to registered `Bash` tool schema | 0.1 ms |
| 09 | [`09-codex-step-controller.ts`](./09-codex-step-controller.ts) | `kai_decide` | Validate agent trajectory status and prevent premature stops | 8.8 ms |
| 10 | [`10-cursor-context-selector.ts`](./10-cursor-context-selector.ts) | `kai_tool_select` | Select exact context files relevant to bug description | 5.8 ms |
| 11 | [`11-test-failure-recovery.ts`](./11-test-failure-recovery.ts) | `kai_recover` | Route test failures to specific recovery strategy | 7.7 ms |
| 12 | [`12-calibrated-abstention.ts`](./12-calibrated-abstention.ts) | `kai_next_action` | Abstain cleanly when confidence does not exceed threshold | 7.0 ms |
| 13 | [`13-git-destructive-guard.ts`](./13-git-destructive-guard.ts) | `kai_command_guard` | Enforce approval gates for destructive git operations | 61.6 ms |
| 14 | [`14-dependency-audit-triage.ts`](./14-dependency-audit-triage.ts) | `kai_extract` | Classify security alerts by severity and remediation urgency | 21.2 ms |
| 15 | [`15-multi-question-pipeline.ts`](./15-multi-question-pipeline.ts) | `kai_decide` | Execute joint triage, risk, and deployment decisions in 1 pass | 13.6 ms |

---

## Running the Recipes

### Run the entire suite
```bash
pnpm tsx cookbook/index.ts
```

### Run an individual recipe
```bash
pnpm tsx cookbook/01-tool-shortlisting.ts
pnpm tsx cookbook/08-claude-code-tool-resolution.ts
```

### Run via automated Jest test suite
```bash
pnpm test test/cookbook.test.ts
```

---

## Client Integration Guide

### 1. Claude Code

Claude Code registers user-scoped MCP tools via `claude mcp add`:

```bash
# Register Hanzo MCP in Claude Code
claude mcp add --scope user hanzo -- npx -y @hanzo/mcp serve

# Verify connection
claude mcp list
# Output: hanzo: npx -y @hanzo/mcp serve - ✔ Connected
```

To enable Kai tools with a local Kai runtime:
```bash
claude mcp add --scope user hanzo -e LOCAL_KAI_URL=http://127.0.0.1:18977 -- npx -y @hanzo/mcp serve
```

### 2. Cursor IDE

Add Hanzo MCP to `~/.cursor/mcp/config.json`:

```json
{
  "mcpServers": {
    "hanzo": {
      "command": "npx",
      "args": ["-y", "@hanzo/mcp", "serve"],
      "env": {
        "LOCAL_KAI_URL": "http://127.0.0.1:18977",
        "HANZO_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### 3. OpenAI Codex

Add Hanzo MCP to `~/.openai/codex/mcp/config.json`:

```json
{
  "mcpServers": {
    "hanzo": {
      "command": "npx",
      "args": ["-y", "@hanzo/mcp", "serve"],
      "env": {
        "LOCAL_KAI_URL": "http://127.0.0.1:18977"
      }
    }
  }
}
```

### 4. Native Hanzo Dev

In Hanzo Dev (`dev` / `hanzo-loop`), Kai acts as the embedded control engine via C ABI or stdio MCP:
- Deterministic fast paths resolve zero-inference actions in <0.1ms.
- Unmatched or ambiguous states query Kai in 8–30ms on GPU or CPU.
- Verified test outcomes trigger automated `kai_recover` without wasting LLM reasoning tokens.
