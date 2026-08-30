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

## `research` — one door, one mode

`research` (Rust `rust/src/tools/cloud_web.rs`) is POST `/v1/ask` with
`mode: "research"` and `Accept: text/event-stream`. Deep research is a MODE of
that one endpoint, never a second route, and the plan → search → read → rank →
synthesize → cite loop runs server-side where it is bounded and billed — so the
tool reads a stream and folds it, it does not re-implement the loop.

The frames are the `@hanzo/ai` `SearchEvent` union verbatim —
`status | sources | text | follow_ups | done | error`, data-only JSON that
self-describes via `type`. Two rules the wire depends on:

- the terminal `data: [DONE]` is an OpenAI-convention marker, NOT an event
- `deep` is `research`'s retired name; the server resolves it, and so do we

`web_search`, `web_read` and `research` are the same web capability at three
depths (a snippet, a page, a report), so `ToolsConfig::web_search` governs all
three — research is not a second flag to toggle.

Contracts: cloud `apps/answer/{mode,stream}.go`, SDK `hanzo-js/ai/src/search.ts`.

## `lsp` — one tool, two planes

`lsp` (Rust `rust/src/tools/lsp_tool.rs`, Python
`python-sdk/pkg/hanzo-tools-lsp`) answers the same questions from either a
language server on the local tree or the indexed corpus behind
`/v1/code/lsp`. `file` names the file; **`repo` (a git.hanzo.ai slug, with
optional `rev`) is what picks the plane** — cloud when present, local
otherwise. It is one tool, not two: a local server cannot see a dependency it
has no source for, and the cloud index cannot edit your working tree.

Actions map onto `/v1/code/lsp` ops. `locate` is one op carrying a `relation`,
because "where is X" is one question with four answers, not four routes:

| action | op | relation |
|---|---|---|
| `definition` | `/v1/code/lsp/locate` | `definition` |
| `references` | `/v1/code/lsp/locate` | `reference` |
| `type` | `/v1/code/lsp/locate` | `type` |
| `implementation` | `/v1/code/lsp/locate` | `implementation` |
| `hover` | `/v1/code/lsp/hover` | — |
| `symbols` | `/v1/code/lsp/symbols` | — |
| `diagnostics` | `/v1/code/lsp/diagnostics` | — |
| `completion` | `/v1/code/lsp/complete` | — |

Body: `{repo, rev?, path, line, character, relation?}`. The wire is LSP's own
frame — **0-based line, 0-based UTF-16 character** — while the tool's `line`
stays 1-based for callers, so both planes shift it at the same boundary.
`rename`, `code_action`, `organize_imports` and `status` need a working tree
and say so rather than calling out; `type`, `implementation` and `symbols` are
the index's to answer and say so rather than spawning a server.

LSP lives UNDER `/v1/code` beside `search`, `context`, `ask`, `index` — one
home for code intelligence.

## The cloud surface is GENERATED, and it is not written here

`src/tools/cloud.ts` offers the fleet the way the fleet offers itself: one tool
per subsystem carrying that subsystem's operation names in an enum, plus
`describe`, which answers one operation's prose and schema. The names come from
`src/tools/catalog.json`, generated out of cloud's own typed operations
(`plugin/gen-mcp-catalog`). Nothing in it is hand-written, so this client cannot
come to disagree with the API about what exists.

It replaced 1,051 hand-written lines offering seven resources — `iam`, `kms`,
`paas`, `commerce`, `storage`, `auth`, `api` — against a fleet serving 114
subsystems. Two of those names had already moved (`paas` is `platform`, `storage`
is `s3`) and `auth` had folded into `iam`, which alone carries 97 operations
where the hand-written tool carried a handful. It also dialled four hosts
(`api.` / `iam.` / `kms.` / `platform.`) for one API; every call now goes to
`api.hanzo.ai`.

**It is a catalog and not a fetch because a tool list is assembled
synchronously**, before any request has been made. `pnpm sync:catalog` refreshes
it — from a cloud checkout with `HANZO_CLOUD=<dir>`, otherwise from the running
fleet. It REFUSES to write a smaller catalog than it replaces without `--shrink`:
a fleet answering partially and a fleet that lost capabilities look identical,
and the quiet direction of that mistake is a client that stops offering
operations the API still serves.

**The withholding rule is applied ONCE, in cloud.** The endpoint keeps an
operation off the agent surface when its name discloses a bearer secret at any
verb, or when a mutating verb acts on identity or authority — 124 of 1,540 here.
The generator asks `fleet.Withheld`, the same predicate the endpoint asks, rather
than carrying a second copy of the words: a client deriving its set from the raw
catalog offers what the fleet refuses, so the policy would hold on one transport
and not on the other, and the half left unenforced is the one where an agent is
already holding the tool. `get_iam_users` survives and `post_iam_users` does not,
which is the rule's own distinction — knowing who holds a role is not granting
one.

**The default surface did not grow.** `getConfiguredTools({})` is still 22 tools;
the fleet sits behind `hanzo`, whose `resource` enum is derived from the catalog
rather than listed, so a subsystem the fleet gains is reachable the day it is
generated. The 114 individual tools appear only on the legacy branch.

A `tools/call` answer IS a tool result and is returned as one. Re-wrapping it
buries the fleet's own `isError` inside a body that reads as a success — a
refusal a client cannot see is worse than no answer, because it is acted on.

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

## Publishing
This repo is the only place `@hanzo/mcp` publishes from. `hanzoai/extension`
vendors a copy under `packages/mcp` as a build input; it is marked `private` so
a workspace-wide publish there can never ship a fork over this line. Leave it
private.

`.hanzo/workflows/publish.yml` runs on push to `main`, on the forge
(`hanzo-build-linux-amd64`). It asks the registry whether the tree is ahead,
typechecks, bundles (`dist/` is gitignored, so this is also what fills the
tarball), reads `NPM_TOKEN` from KMS, then `npm publish`. A version already on
the registry is skipped, so re-runs are safe. Same shape as `@hanzo/logo`.

The KMS read is the flat form, answering `{name, env, value}`:

    GET https://kms.hanzo.ai/v1/kms/secrets/NPM_TOKEN?env=prod   -> .value

The org is not a path segment — the read is scoped by the token's owner claim,
and `NPM_TOKEN` sits at the org root. The only credential on the forge is the
machine identity (`KMS_CLIENT_ID`/`KMS_CLIENT_SECRET`, org-level secrets on
`hanzoai`). `/hanzo.yml` stays a test gate; it publishes nothing.

Verify a release with `npm view @hanzo/mcp version`, never with a green run.

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
