# LLM.md — hanzoai/mcp

Guidance for AI agents working in this repo.

## What this is
The canonical Model Context Protocol server for the Hanzo AI Cloud. Collapses a
260+ tool catalog into **13 HIP-0300 action-routed tools** (`fs`, `exec`, `code`,
`git`, `fetch`, `workspace`, `ui` + optional `think`, `memory`, `hanzo`, `plan`,
`tasks`, `mode`) over MCP stdio / streamable-http. TypeScript today; Rust runtime
for latency-sensitive ops; Go runtime under `hanzoai/cloud` (HIP-0106 in flight).

## Canonical role
Part of the AI/agents SDK line. This TS package (`@hanzo/mcp`) is canonical; the
Python `hanzo-mcp` (PyPI) and Rust `hanzo-mcp::brain` mirror the same tool surface
1-to-1 — tool names and action schemas identical across runtimes. DRY: one impl
per tool in its canonical home; do not duplicate tool logic across runtimes beyond
the shared schema. Full model: `~/work/hanzo/SDK-ARCHITECTURE.md`.

## Install / run
```bash
npm install -g @hanzo/mcp && hanzo-mcp serve   # or: pip install hanzo-mcp
```

## Key entry points
- `src/tools/unified/` — HIP-0300 action-routed tools (fs, exec, code, fetch, workspace, hanzo)
- `src/tools/` — individual/legacy tools (git, think, memory, tasks, plan, mode)
- `rust/src/tools/` — Rust native tools (exec, git, fetch, code, computer)
- `scripts/smoke-mcp.mjs` — protocol smoke test run in CI

## Brand rules (hard — enforce in all docs/code)
- Hanzo is a full **AI SDK / AI cloud**, never an "LLM gateway" or proxy; never
  position against LiteLLM.
- Zen models are our own family — never name upstream models.
- Paths are `/v1/` only — never an `/api/` prefix.
- Voice: "Hanzo — the Open AI Cloud." Modern, crisp, developer-first.
