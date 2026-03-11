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
      "args": ["@hanzo/mcp", "serve"]
    }
  }
}
```

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
