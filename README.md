# mcp

Model Context Protocol server. HIP-0300 unified action-routed tool surface. TypeScript today, Go rewrite in flight per HIP-0106.

[![Status](https://img.shields.io/badge/status-beta-blue)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

## Quick start

```bash
npm install -g @hanzo/mcp
hanzo-mcp serve
```

## What this is

`mcp` is the canonical Model Context Protocol server for the Hanzo platform. Exposes 13 HIP-0300 unified tools (`fs`, `exec`, `code`, `git`, `fetch`, `workspace`, `ui`, plus optional `think`, `memory`, `hanzo`, `plan`, `tasks`, `mode`) over the MCP stdio / streamable-http transports. Every Hanzo agent uses the same tool surface; Python SDK (`hanzo-mcp` on PyPI) and Rust crate (`hanzo-mcp::brain`) mirror the TS surface 1-1.

## Specs

Implements:
- HIP-0300 Unified MCP Tools
- HIP-0106 Unified Cloud Binary (mcp subsystem)

## Architecture

```
   Claude Desktop / Cursor / Code  ->  stdio MCP transport
                                              |
                                          hanzo-mcp serve
                                              |
                          +-------------------+-------------------+
                          |                                       |
                  HIP-0300 unified tools          legacy individual tools (--legacy)
                  fs / exec / code / git /         read_file, write_file, bash, ...
                  fetch / workspace / ui +
                  optional think / memory /
                  hanzo / plan / tasks / mode
                          |
                  TS runtime (today) | Rust runtime (latency-sensitive)
                          |
                  Go runtime under hanzoai/cloud (HIP-0106 in flight)
```


---

# @hanzo/mcp

Model Context Protocol (MCP) server with HIP-0300 unified tool architecture. TypeScript + Rust dual runtime.

## Installation

```bash
npm install -g @hanzo/mcp
```

## Quick Start

```bash
# Start with unified tools (default: 13 HIP-0300 tools)
hanzo-mcp serve

# Legacy individual tools
hanzo-mcp serve --legacy

# With UI extensions
hanzo-mcp serve --enable-ui

# List available tools
hanzo-mcp list-tools

# Install for Claude Desktop
hanzo-mcp install-desktop
```

## HIP-0300 Tool Surface

13 canonical tools organized by axis. Each tool uses action-routed dispatch.

### Core Tools (7)

| Tool | Axis | Key Actions |
|------|------|-------------|
| `fs` | Bytes + Paths | read, write, stat, list, mkdir, rm, mv, apply_patch, search_text |
| `exec` | Execution | run, background, ps, kill, logs |
| `code` | Symbols + Semantics | parse, search, transform, summarize |
| `git` | Diffs + History | status, diff, log, commit, branch, stash |
| `fetch` | HTTP/API | get, post, put, delete, download |
| `workspace` | Project Context | info, config, env, dependencies |
| `ui` | UI Components | list_components, fetch_component, search, install |

### Optional Tools (6)

| Tool | Purpose |
|------|---------|
| `think` | Structured reasoning |
| `memory` | Persistent storage |
| `hanzo` | Hanzo platform API (iam, kms, paas, commerce) |
| `plan` | Task planning |
| `tasks` | Task tracking |
| `mode` | Developer modes |

## Usage

### CLI Options

```bash
# Default: HIP-0300 unified surface (13 tools)
hanzo-mcp serve

# Legacy individual tools (read_file, write_file, bash, etc.)
hanzo-mcp serve --legacy

# Enable UI extensions
hanzo-mcp serve --enable-ui --enable-desktop

# Disable specific tools
hanzo-mcp serve --disable-tools plan,tasks
```

### Programmatic Usage

```typescript
import { getConfiguredTools } from '@hanzo/mcp';

// HIP-0300 unified surface (default)
const tools = getConfiguredTools({ unified: true });

// Legacy individual tools
const tools = getConfiguredTools({ enableLegacy: true });

// With UI extensions
const tools = getConfiguredTools({
  unified: true,
  enableUI: true,
  enableDesktop: true,
});
```

## AI Client Configuration

### Claude Desktop / Cursor

Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "hanzo": {
      "command": "npx",
      "args": ["-y", "--package=@hanzo/mcp", "hanzo-mcp", "serve"]
    }
  }
}
```

> **Why `--package=`?** Without it, `npx -y @hanzo/mcp serve` resolves
> `serve` as a *separate* npm package (the unrelated static-file server)
> and runs that instead of `hanzo-mcp`. The `--package=` form binds npx
> to the right binary. This matters on every platform — Windows, macOS,
> and Linux.

## Troubleshooting

If MCP "doesn't work" in Claude Desktop, Claude Code, Cursor, or any
other client:

1. **Verify the stdio handshake from the command line:**
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
     | npx -y --package=@hanzo/mcp@latest hanzo-mcp serve
   ```
   A working install prints a JSON-RPC response with
   `"serverInfo":{"name":"hanzo-mcp","version":"…"}` within ~10 s.
   Silence (or a long hang) means the wrong binary is running.

2. **Turn on debug logging** by setting `HANZO_MCP_DEBUG=1` in the
   client's MCP server env block. Stderr will then include the
   resolved CLI path, cwd, argv, and PATH prefix — a few seconds of
   output usually tells you whether a stray `serve` binary, a wrong
   `npx` arg form, or a port conflict is shadowing the server.

   ```json
   "hanzo": {
     "command": "npx",
     "args": ["-y", "--package=@hanzo/mcp", "hanzo-mcp", "serve"],
     "env": { "HANZO_MCP_DEBUG": "1" }
   }
   ```

   In Claude Desktop the stderr lands in
   `~/Library/Logs/Claude/mcp-server-hanzo.log` (macOS) or
   `%APPDATA%\Claude\logs\mcp-server-hanzo.log` (Windows).

3. **Rerun the installer** to overwrite a stale (2.4.1 or earlier) config:
   ```bash
   npx -y --package=@hanzo/mcp@latest hanzo-mcp install --claude-desktop
   ```
   Then restart Claude Desktop.

4. **Windows specifics.** `npx.cmd` shells out to `cmd.exe` for arg
   parsing, which is sensitive to quoting. If the JSON config uses
   single quotes anywhere, switch to double quotes.

5. **CI invariants.** The protocol-level contract is exercised on every
   push to main, on native Linux amd64 + arm64 (Hanzo self-hosted
   runners, no QEMU), via `scripts/smoke-mcp.mjs` and an e2e test
   against the *published* npm package using the same npx invocation
   shipped to clients. If MCP works locally but fails for you, open an
   issue with the `HANZO_MCP_DEBUG=1` log attached.

## Architecture

```
src/tools/unified/    # HIP-0300 action-routed tools (fs, exec, code, fetch, workspace, hanzo)
src/tools/            # Individual tools (git, think, memory, tasks, plan, mode, etc.)
rust/src/tools/       # Rust native tools (exec, git, fetch, code, computer, etc.)
```

The Rust runtime provides native performance for latency-sensitive operations (<5ms clicks, <2ms keypress, <50ms screenshots).

## Python SDK Parity

The Python implementation (`hanzo-mcp` on PyPI) exposes the same 13 HIP-0300 tools via entry-point discovery from `hanzo-tools-*` packages. Tool names and action schemas are identical across both runtimes.

```bash
pip install hanzo-mcp
```

## License

MIT
