<p align="center"><img src=".github/hero.svg" alt="Hanzo MCP" width="880"></p>

# @hanzo/mcp

An MCP server for coding agents: files, shell, code, git, HTTP, project context
and UI components, plus tools that call the Hanzo API. It speaks MCP over stdio,
or over streamable HTTP with `--transport http`.

[![npm](https://img.shields.io/npm/v/@hanzo/mcp?color=blue&label=%40hanzo%2Fmcp)](https://www.npmjs.com/package/@hanzo/mcp)

## Register it with an agent

The package declares Node 18 or newer. For Claude Code:

```bash
claude mcp add hanzo -- npx -y @hanzo/mcp serve
```

`npx -y @hanzo/mcp install --claude-code` runs that command with `--scope user`,
which registers the server for every project.

`claude mcp list` then reports `hanzo: npx -y @hanzo/mcp serve - ✔ Connected`.
With `--scope project` the entry goes into the project's `.mcp.json` instead,
and Claude Code asks before it starts a server from that file. Other MCP clients
take the same command in their server config:

```json
{
  "mcpServers": {
    "hanzo": {
      "command": "npx",
      "args": ["-y", "@hanzo/mcp", "serve"]
    }
  }
}
```

The first start downloads the package; with an empty npm cache that took 80 to
100 seconds.

## Tools

`serve` with no flags offers these, in the groups `src/tools/unified/index.ts`
defines:

| group | tools |
|---|---|
| core | `fs`, `exec`, `code`, `git`, `fetch`, `workspace`, `ui` |
| optional | `think`, `memory`, `hanzo`, `plan`, `tasks`, `mode`, `gimp` |
| code intelligence | `code_search`, `code_context`, `code_ask`, `code_index` |
| tracker | `tracker_boards`, `tracker_issues`, `tracker_create`, `tracker_update` |

The core and optional tools take an `action` argument that picks the operation;
`ui` takes `method`. The code intelligence and tracker tools call
`https://api.hanzo.ai` with the key in `HANZO_API_KEY`, and `API_URL` points
them at another host.

`hanzo` reaches every Hanzo Cloud subsystem: `resource` names one, `action` one
of its operations, `args` that operation's arguments. With no `action` it lists
the resource's operations. The list is generated from cloud's catalog.

```json
{ "resource": "graph", "action": "graphResolve",
  "args": { "entity": "acme/svc/api", "relation": "owner", "as_of": "2026-09-01T00:00:00Z" } }
```

Flags on `serve` change the set:

| flag | effect |
|---|---|
| `--disable-tools plan,tasks` | removes the named tools |
| `--core-only` | only the core group |
| `--enable-ui` | adds the `ui_*` component tools |
| `--enable-desktop` | adds `hanzo_desktop` and `playwright_control` |
| `--enable-autogui`, `--enable-orchestration`, `--enable-ui-registry`, `--enable-github-ui`, `--enable-community-cryptuon` | add those tool sets |
| `--full-surface` | adds the UI, AutoGUI, orchestration, UI registry and GitHub UI sets together |

`npx -y @hanzo/mcp serve --help` lists every flag. This prints the tool names a
server offers; put any flags after `serve`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| npx -y @hanzo/mcp serve 2>/dev/null \
| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n"))if(l.includes("\"id\":2"))console.log(JSON.parse(l).result.tools.map(t=>t.name).join(" "))})'
```

## Over HTTP

```bash
npx -y @hanzo/mcp serve --transport http --port 3000
```

The endpoint is the root path, `http://127.0.0.1:3000/`. POST JSON-RPC to it
with `Accept: application/json, text/event-stream`; answers come back as
server-sent events.

## When a client shows no tools

Start the server by hand. A working one answers `initialize` with its name and
version:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | npx -y @hanzo/mcp serve
```

With `HANZO_MCP_DEBUG=1` in the server's environment, stderr also shows its
working directory, the resolved binary, its arguments and the start of `PATH`.

## Python

`hanzo-mcp` on PyPI is a separate server, built from
[hanzoai/python-sdk](https://github.com/hanzoai/python-sdk).

## Development

```bash
pnpm install
pnpm build
pnpm smoke    # runs dist/cli.js over stdio: initialize, tools/call, resources
```

## License

MIT
