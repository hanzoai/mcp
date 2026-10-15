# Kai tools cookbook

Fifteen runnable recipes for the `kai_*` MCP tools in Claude Code, Codex, Cursor and Hanzo Dev.

Most of these tools make no model call: where kai-1.2 read a task at or near chance, rules and BM25 decide it,
and Kai is asked only where it measured better. Each tool's reads, this handler beside the one it replaced,
are research runs with their items stored beside them; [hanzo.ai/benchmarks](https://hanzo.ai/benchmarks) draws them.

| Tool | What decides | Reads |
|---|---|---|
| `kai_injection_screen` | Rules (override, role, addressed, conceal, exfiltrate, tool_call, act, extract), and Kai's `planted` capability (kai-1.3) | [`mcp.injection`](https://api.hanzo.ai/v1/research/runs?org=hanzo&benchmark=mcp.injection) |
| `kai_command_guard` | Deny and ask classes; allow only for known workspace work; anything else asks | [`mcp.command`](https://api.hanzo.ai/v1/research/runs?org=hanzo&benchmark=mcp.command) |
| `kai_tool_select` | A tool the task names, then BM25 over name, description and parameters | [`mcp.select`](https://api.hanzo.ai/v1/research/runs?org=hanzo&benchmark=mcp.select) |
| `kai_log_triage` | Failure signatures, root cause first; `none`, `unknown` | [`mcp.triage`](https://api.hanzo.ai/v1/research/runs?org=hanzo&benchmark=mcp.triage) |
| `kai_recover` | Three failures with one fingerprint switch strategy; else the triage class picks the step | rules |
| `kai_next_action` | Drops actions with unmet preconditions; BM25 among the rest; abstains on a tie | rules |
| `kai_extract` | Kai, one typed question a field; a field near uniform abstains | not read |
| `kai_decide` | Kai, up to 100 typed questions | the model's runs |

`bench/tools/post.py` files these runs; a read is posted once and linked, never re-run to quote.

The screen and the guard are advice. A flag means treat the text as data; a verdict means nothing
until the client blocks on it. No flag does not make text safe.

## Recipes

| # | Recipe | Tool |
|---|---|---|
| 01 | [`01-tool-shortlisting.ts`](./01-tool-shortlisting.ts) | `kai_tool_select` |
| 02 | [`02-zero-inference-fast-path.ts`](./02-zero-inference-fast-path.ts) | `kai_next_action` |
| 03 | [`03-shell-command-security-gate.ts`](./03-shell-command-security-gate.ts) | `kai_command_guard` |
| 04 | [`04-prompt-injection-screening.ts`](./04-prompt-injection-screening.ts) | `kai_injection_screen` |
| 05 | [`05-build-log-triage.ts`](./05-build-log-triage.ts) | `kai_log_triage` |
| 06 | [`06-failure-loop-breaker.ts`](./06-failure-loop-breaker.ts) | `kai_recover` |
| 07 | [`07-structured-schema-extraction.ts`](./07-structured-schema-extraction.ts) | `kai_extract` |
| 08 | [`08-claude-code-tool-resolution.ts`](./08-claude-code-tool-resolution.ts) | `kai_tool_select` |
| 09 | [`09-codex-step-controller.ts`](./09-codex-step-controller.ts) | `kai_decide` |
| 10 | [`10-cursor-context-selector.ts`](./10-cursor-context-selector.ts) | `kai_tool_select` |
| 11 | [`11-test-failure-recovery.ts`](./11-test-failure-recovery.ts) | `kai_recover` |
| 12 | [`12-calibrated-abstention.ts`](./12-calibrated-abstention.ts) | `kai_next_action` |
| 13 | [`13-git-destructive-guard.ts`](./13-git-destructive-guard.ts) | `kai_command_guard` |
| 14 | [`14-dependency-audit-triage.ts`](./14-dependency-audit-triage.ts) | `kai_extract` |
| 15 | [`15-multi-question-pipeline.ts`](./15-multi-question-pipeline.ts) | `kai_decide` |

```bash
pnpm build
HANZO_API_KEY=... pnpm tsx cookbook/index.ts           # all fifteen, against api.hanzo.ai
LOCAL_KAI_URL=http://127.0.0.1:8080 pnpm tsx cookbook/04-prompt-injection-screening.ts   # one, against a local `kai serve`
pnpm test test/cookbook.test.ts
```

Recipes that call Kai need `HANZO_API_KEY` or `LOCAL_KAI_URL`; the rest run offline.

## Clients

Claude Code:
```bash
claude mcp add --scope user -e HANZO_API_KEY=$HANZO_API_KEY hanzo -- npx -y @hanzo/mcp serve
claude mcp list
```

Codex:
```bash
codex mcp add --env HANZO_API_KEY=$HANZO_API_KEY hanzo -- npx -y @hanzo/mcp serve
```

Cursor, `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):
```json
{ "mcpServers": { "hanzo": { "command": "npx", "args": ["-y", "@hanzo/mcp", "serve"], "env": { "HANZO_API_KEY": "..." } } } }
```

Hanzo Dev reaches the same tools through its MCP configuration.
