# LLM.md — hanzoai/mcp

Guidance for AI agents working in this repo.

## What this is
The canonical Model Context Protocol server for the Hanzo AI Cloud. Collapses a
260+ tool catalog into **13 HIP-0300 action-routed tools** (`fs`, `exec`, `code`,
`git`, `fetch`, `workspace`, `ui` + optional `think`, `memory`, `hanzo`, `plan`,
`tasks`, `mode`) over MCP stdio / streamable-http. TypeScript today; Rust runtime
for latency-sensitive ops; Go runtime under `hanzoai/cloud` (HIP-0106 in flight).

## `tracker_*` — work items, and why they are not `tasks`

`tracker_boards`, `tracker_issues`, `tracker_create`, `tracker_update`
(`src/tools/tracker.ts`) are the Hanzo Cloud `/v1/tracker` surface: the ONE
work-item primitive, the board a human actually looks at. They are how an agent
reports its own progress somewhere visible.

Three planes are easy to braid, and cloud `apps/tracker/contract.go` is law about
it:

| plane | what it is | here |
|---|---|---|
| tracker Issue | engineering WORK ITEM on a board | `tracker_*` |
| hanzoai/tasks | durable ASYNC EXECUTION (Temporal fork) | not exposed |
| `tasks` tool | a private todo file at `~/.hanzo/todos.json` | `src/tools/tasks.ts` |

So the local `tasks` tool is NOT the board — it never leaves the machine. Naming
these `tasks_*` would have collided with it and pointed callers at the one plane
no human can see.

An agent's run is a **session** (`/v1/agents/sessions`), never a "mission" —
nothing in the fleet models that word. Pass `session` to `tracker_create` /
`tracker_update` and the tool writes the anchor `session:<id>` into `extRef`,
which the tracker contract defines as "a link INTO another plane". hanzo.app's
board renders that session's live status on the row.

`tracker_create` defaults `source` to `agent`, because the board's "an agent's
work" filter (`?source=agent`) is only true if agents say so.

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
