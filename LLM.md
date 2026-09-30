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

## `kai_*` — decisions

`kai_decide`, `kai_choice`, `kai_score`, `kai_noul` (`src/tools/kai.ts`) ask Kai,
Hanzo's decision model, at `POST /v1/decisions` on `API_URL` or
`https://api.hanzo.ai`, with the bearer from `HANZO_API_KEY` (else `API_KEY`,
`API_TOKEN`, `HANZO_TOKEN`), as the tracker tools do. `kai_decide` sends a whole
request (`state`, named `questions`, `model` defaulting to `kai`) and returns the
decision as served; the other three send one question of their type, named by the
type, and return `{answer, id, model, usage}`. They check the shape the frozen
wire contract fixes: `state` is text, an object or an array; `instructions` is
optional on every question and, when given, the same; 1 to 100 questions; a
choice names at least 2 labels (a repeated list label is one); a score lists at
least 1 level, none null; a noul's sides are `true` and `false` only.
`/v1/decisions` caps no label or level count (a wide choice is narrowed by
retrieval), so neither do the tools; only `/v1/systemone` caps them, at Jev's 255
and 10. Whether a request fits the token budget is the server's to say (422
`state_too_long`). A non-2xx returns `<status>: <the server's sentence>`
(decision's `error.message`, the gateway's `msg`).

The descriptions call `instructions` recommended and steer a noul to a statement
with both sides described, or to a choice whose labels name the outcomes (not
yes and no), because Kai reads a bare question-form yes/no poorly. They say to act on a score's argmax: `score` is the
mean level index, and `confidence` describes the likeliest level. A noul's
`confidence` is |2p − 1|.

Tools that run a whole decision program arrive with Kai's joint decoder.
TypeScript only, like `tracker_*`: neither the Rust runtime nor Python `hanzo-mcp`
carries the tracker or kai tools.

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

## `iam` — how identity is addressed

IAM's CRUD lives under `/v1/iam/` and nowhere else. A row is a path, not a query:
`/v1/iam/{plural}/{owner}/{name}` for users, organizations, roles, applications,
providers, permissions, invitations and tokens; sessions carry the application
too (`/v1/iam/sessions/{owner}/{name}/{application}`). Audit rows are
`/v1/iam/audit-logs`.

A list GET answers one object keyed by the plural (`{"users":[…],"total":N}`); an
item GET answers the bare record, except providers, which wrap
(`{"provider":{…}}`). A refusal is RFC 9457 problem+json and absence is 404 —
so a non-2xx answer is an error to raise, never a payload to read. The
`{status,msg,data}` envelope survives on `/v1/iam/account`, `/v1/iam/memberships`,
`/v1/iam/keys/{principal,org}` and `POST /v1/iam/delete-membership`. Write bodies
are the flat row, except users: `{"user":{…},"password":"…"}`.

`owner` is scope, not a constant. Send it only when the caller names one and let
the server resolve the rest from the credential — a hardcoded org answers 403 to
everyone outside it, and IAM's capability allowlists decide the rest.
`/v1/iam/applications` is the one list that requires `owner`; ask for it.

Two callers: `src/tools/cloud.ts` (the generated `iam` subsystem tool, which `auth` folded into) and
`rust/src/tools/hanzo_tool.rs` (the `hanzo` router's `iam` service). Identity
questions belong to `iam` alone — `platform` answers for deployments.

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
synchronously**, before any request has been made, and a client that needs the
network to say what it can do has nothing to say when the network is what failed.

**Refresh it FROM CLOUD, which is where the operations are declared:**
`make -f mk/fleet.mk mcp` in `hanzoai/cloud` writes `fleet/mcp.json` and every
sibling checkout's copy in one pass — this file and python-sdk's. A sibling that
is not checked out beside cloud is skipped, never created. It REFUSES to write a
smaller catalog than it replaces without `--shrink`: a fleet answering partially
and a fleet that lost capabilities look identical, and the quiet direction of that
mistake is a client that stops offering operations the API still serves.

There was a `pnpm sync:catalog` here doing the same job in JavaScript. Two
generators for one projection is how they come to disagree about the rule, and
the rule is cloud's — so the script is deleted and the Go one writes every copy.

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

**The fleet does not grow the default surface.** `getConfiguredTools({})` is 26 tools;
the fleet sits behind `hanzo`, whose `resource` enum is derived from the catalog
rather than listed, so a subsystem the fleet gains is reachable the day it is
generated. The 114 individual tools appear only on the legacy branch.

A `tools/call` answer IS a tool result and is returned as one. Re-wrapping it
buries the fleet's own `isError` inside a body that reads as a success — a
refusal a client cannot see is worse than no answer, because it is acted on.

**The Rust runtime reads the SAME file** (`rust/src/catalog.rs`,
`include_str!("../../src/tools/catalog.json")`), which is what makes "the runtimes
mirror one-to-one" true rather than aspirational. Its `hanzo` tool went from 1,017
lines to 460: nine hand-written service routers over four hosts became one
dispatch to `api.hanzo.ai/v1/mcp`, and its `SERVICES` list became a read of the
catalog. Two things that list had were worse than stale — it named `paas` and
`commerce`, which the fleet no longer serves, and `base_url("commerce")` was
`https://api.hanzo.ai/api/v1`, an `/api/` prefix this estate does not serve.

**The aliases are gone, not renamed.** `platform -> paas`, `identity -> iam`,
`payments -> billing`, `store -> commerce` pointed at the OLD names, so three of
the four mapped a caller off the surface the fleet serves. `resolve_service`
normalises spelling and renames nothing; one thing has one name.

## `browser` and `cdp` — the user's browser over ZAP

The browser is reached the way Python `hanzo-mcp` reaches it: through this
login's ZAP router (zapd, HIP-0069). An fcntl lock on
`$XDG_RUNTIME_DIR/zap/zapd.lock` elects one process as router; it owns
`zapd.sock` and the loopback door (9998, else 21000-21007) that admits the
Hanzo extension's Blink origin without pairing. The extension registers as
`browser/<host>/<engine>-<id>`; a command is one ROUTE (method + string
params, the extension's `decodeCmd` body) answered by one RESPONSE (JSON, or
`ERR:<why>`).

- **Rust** (`rust/src/zap.rs`) links `zapd` v1.1.5 by git tag (crates.io has
  only 1.1.2, which predates the unpaired door). `main` calls `zap::seat()`:
  it stands for router and joins as `mcp/hanzo-<pid>`, as Python does.
  `hanzo-mcp pair [--reset]` prints the door's code for a browser that must
  pair.
- **Native host** (`rust/src/native.rs`): the same binary run as
  `hanzo-zap-host` is Chrome/Firefox native messaging host `ai.hanzo.zap`,
  relaying `{"z": base64 envelope}` messages to the socket, as Python's
  `native_host.py` does. Each start registers it (a symlink at
  `~/.hanzo/zap/hanzo-zap-host`) with every installed browser, but never over
  a manifest whose program exists: Python's host serves the same extension,
  and two runtimes rewriting one file would trade it forever.
- **TypeScript** (`src/zap.ts`) is a consumer only: zapd has no JS or wasm
  build, so it joins whichever process holds the lock and never stands for
  router. With no router it says so (`NO_ROUTER`). Node cannot read a unix
  socket's peer credentials, so unlike zapd's own node it does not check the
  peer is the lock holder; it trusts the 0700 runtime dir, which it refuses
  otherwise.
- `browser` (`rust/src/tools/browser_tool.rs`, `src/tools/browser.ts`) carries
  Python's `ACTIONS` table verbatim: names, topics, usage, extension method,
  `hanzo.act` op. Core parameters are typed; the rest ride in `args`, and an
  unknown `args` key is refused. An action with a method goes to the browser;
  with none registered it falls back to headless Playwright, except a ref
  (`@e2`), `annotate`, or an explicit `BROWSER_BACKEND`, which error instead.
  Rust's fallback is the full driver; TypeScript's covers core, navigation and
  tabs. A capture is saved under `~/.hanzo/screenshots` and returned as an MCP
  image block.
- `cdp` sends a raw CDP method verbatim to the same browser; no fallback.
- Tests never touch the owner's router: `rust/tests/test_browser_tools.rs`
  embeds the router on a private `XDG_RUNTIME_DIR`/`XDG_STATE_HOME`/`HOME` with
  a pairing pinned to a random port; `test/tools/browser.test.ts` runs PyPI
  `zapd` as the router in another process. Both use a fake extension.

## Parity with hanzo-mcp (Python)

Python `hanzo-mcp` (`python-sdk/pkg/hanzo-tools-*`) is the reference. Counted
from code, one row per registered Python tool: **72 tools**. TypeScript: 14 yes,
22 partial, 36 missing. Rust: 25 yes, 19 partial, 28 missing. † not a
`hanzo-mcp` dependency (extras); ‡ shipped but disabled when `hanzo` is on.

| Python tool (pkg) | TS | Rust |
|---|---|---|
| agent (agent) | partial `src/tools/think.ts` (action=agent only) | yes `rust/src/tools/agent_tool.rs` |
| zen (agent) | missing | yes `agent_tool.rs` (agent action=zen) |
| review (agent) | missing | yes `agent_tool.rs` |
| hanzo (api) | yes `src/tools/unified/hanzo.ts` | yes `rust/src/tools/hanzo_tool.rs` |
| api (api) ‡ | missing | missing |
| auth (auth) ‡ | missing | partial `hanzo_tool.rs` (no login) |
| billing, commerce, iam, ingress, kms, team, s3 (†) | partial `hanzo.ts` (resource=…, catalog ops) | partial `hanzo_tool.rs` (resource=…) |
| paas (paas) † | partial `hanzo.ts` (resource=platform) | partial `hanzo_tool.rs` (resource=platform) |
| mpc (mpc) ‡ | missing | missing |
| browser (browser) | partial `src/tools/browser.ts` (all 88 names; Playwright fallback core/navigation/tabs) | yes `rust/src/tools/browser_tool.rs` (no Firefox BiDi fast path) |
| cdp (browser) | yes `src/tools/browser.ts` | yes `rust/src/tools/cdp_tool.rs` |
| playwright (browser) | partial (`browser` with `BROWSER_BACKEND=playwright`) | partial (same) |
| code (code) | partial `src/tools/unified/code.ts` (search/context/ask/index are `code_*`) | partial `rust/src/tools/code_tool.rs` |
| computer (computer) | partial `src/autogui/` (opt-in; no touch/record/regions) | partial `rust/src/tools/computer_tool/` (no touch, record, locate, pixel, regions) |
| config (config) | missing | yes `rust/src/tools/config_tool.rs` |
| mode (config) | partial `src/tools/mode-preset.ts` (no activate, show) | yes `rust/src/tools/mode_tool.rs` |
| workspace (config) | yes `src/tools/unified/workspace.ts` | yes `rust/src/tools/workspace_tool.rs` |
| sql_query, sql_search, sql_stats, graph_add/remove/query/search/stats (database) † | missing | missing |
| devserver (devserver) | missing | missing |
| neovim_edit, neovim_command, neovim_session (editor) † | missing | missing |
| fs (fs) | yes `src/tools/unified/fs.ts` | yes `rust/src/tools/fs_tool.rs` |
| gimp (gimp) † | yes `src/tools/gimp.ts` | missing |
| ide (ide) † | missing | missing |
| jupyter (jupyter) † | missing | missing |
| llm (llm) | missing | partial `rust/src/tools/llm_tool.rs` (no enable, disable, test) |
| consensus (llm) | yes `think.ts` (action=consensus) | yes `llm_tool.rs` (action=consensus) |
| lsp (lsp) | missing | yes `rust/src/tools/lsp_tool.rs` |
| mcp, mcp_add, mcp_remove, mcp_stats, proxy (mcp) † | missing | missing |
| memory (memory) | partial `src/tools/memory.ts` (no create, kb) | yes `rust/src/tools/memory_tool.rs` |
| fetch (net) | partial `src/tools/unified/fetch.ts` (no web_read, research) | partial `rust/src/tools/fetch_tool.rs` (web_read/research are tools) |
| vision (net) | missing | partial `rust/src/tools/vision_tool.rs` (ask only) |
| plan (plan) † | partial `src/tools/plan.ts` (no get, clear, intent, route, compose, chains) | partial `rust/src/tools/plan_tool.rs` (no intent, route, compose, chains) |
| think (reasoning) | partial `think.ts` (no review) | yes `rust/src/tools/think_tool.rs` |
| critic (reasoning) | yes `think.ts` (action=critic) | yes `think_tool.rs` (action=critic) |
| refactor (refactor) | partial `src/tools/refactor.ts` (no rename_batch) | partial `rust/src/tools/refactor_tool.rs` (no rename_batch, find_references) |
| repl (repl) † | missing | missing |
| zsh, exec, ps (shell) | yes `src/tools/unified/exec.ts` | yes `rust/src/tools/exec_tool.rs` |
| open, curl, wget (shell) | yes `fetch.ts` (open, request, download) | yes `fetch_tool.rs` (same) |
| npx, uvx, jq (shell) | missing | missing |
| test (test) † | missing | missing |
| tasks (todo) | partial `src/tools/tasks.ts` (no clear, remove) | yes `rust/src/tools/tasks_tool.rs` |
| ui (ui) | partial `src/tools/unified-ui.ts` (no ask, semantic_search, index) | partial `rust/src/tools/ui_tool.rs` (7 of 18 actions) |
| git (vcs) | yes `src/tools/git.ts` | yes `rust/src/tools/git_tool.rs` |
| vector (vector) † | partial `src/tools/vector-search.ts` (legacy; no embed) | missing |
| version, stats (system) | missing | yes `rust/src/tools/system_tool.rs` |
| tool (system) | missing | partial `system_tool.rs` (no install, upgrade, reload, self_update) |

A grouped row counts once per Python tool it names. Not in Python: TS
`code_*`, `tracker_*`, `kai_*`; Rust `code_*`, `web_search`, `web_read`,
`research`, `system`. Rust's `search` alias of fs is gone: `fs action=search_text`
is the one search. Recount after closing a gap and update both numbers.

## Canonical role
Part of the AI/agents SDK line. This TS package (`@hanzo/mcp`) is canonical; the
Python `hanzo-mcp` (PyPI) and Rust `hanzo-mcp::brain` mirror the same tool surface
1-to-1 — tool names and action schemas identical across runtimes — except
`tracker_*` and `kai_*`, which are TypeScript only. Where they do not yet, the
parity table above says so. DRY: one impl
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

`.github/workflows/publish.yml` runs on push to `main`, on the hanzoai org
runners on github.com (`linux-amd64`). git.hanzo.ai holds this repo as a pull
mirror of GitHub with actions off, so a workflow under `.hanzo/workflows` runs
nowhere; every pipeline here lives in `.github/workflows`. It asks the registry
whether the tree is ahead, typechecks, bundles (`dist/` is gitignored, so this is
also what fills the tarball), reads `NPM_TOKEN` from KMS, then `npm publish`. A
version already on the registry is skipped, so re-runs are safe. Same shape as
`@hanzo/logo`.

The KMS read is the flat form, answering `{name, env, value}`:

    GET https://kms.hanzo.ai/v1/kms/secrets/NPM_TOKEN?env=prod   -> .value

The org is not a path segment — the read is scoped by the token's owner claim,
and `NPM_TOKEN` sits at the org root. The only credential in GitHub is the
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
