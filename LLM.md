# MCP - LLM Context

## Overview

Hanzo MCP (Model Context Protocol) implementation. TypeScript + Rust dual runtime providing HIP-0300 unified tool surface for AI coding agents.

**Install**: `npm install -g @hanzo/mcp`
**Version**: 2.2.2

## HIP-0300 Unified Tool Architecture

13 canonical tools organized by axis. Each tool uses action-routed dispatch.

### Core Tools (7)

| Tool | Axis | Actions |
|------|------|---------|
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
| `hanzo` | Hanzo platform (iam, kms, paas, commerce, storage, auth, api) |
| `plan` | Task planning |
| `tasks` | Task tracking |
| `mode` | Developer modes |

### File Layout

```
src/tools/unified/     # HIP-0300 implementations
  fs.ts, exec.ts, code.ts, fetch.ts, workspace.ts, hanzo.ts, index.ts
src/tools/             # Individual tools (legacy + new)
  git.ts, think.ts, memory.ts, tasks.ts, plan.ts, mode-preset.ts, ...
src/tools/index.ts     # Tool registry and configuration
rust/src/tools/        # Rust native tools (parallel implementations)
```

### Tool Configuration

```typescript
import { getConfiguredTools } from './tools/index.js';

// HIP-0300 unified surface (default)
const tools = getConfiguredTools({ unified: true });

// Legacy individual tools
const tools = getConfiguredTools({ enableLegacy: true });
```

## Search Engine (`/src/search/`)

Strategy pattern with priority-based parallel execution:

| Strategy | Priority | Technology | Triggers |
|----------|----------|------------|----------|
| Symbol | 10 | TreeSitter AST | `class `, `function `, `def `, `interface ` |
| AST | 20 | TreeSitter | Code-like patterns, brackets |
| Vector | 30 | LanceDB embeddings | Natural language queries |
| Text | 40 | Ripgrep | Default for all queries |
| File | 50 | Glob patterns | Path separators, file extensions |

## Rust Native Tools (`/rust/`)

Platform-native implementations for performance-critical operations:
- `exec_tool.rs` — Process execution
- `git_tool.rs` — Git operations
- `fetch_tool.rs` — HTTP client
- `code_tool.rs` — AST parsing
- `computer_tool/` — OS/desktop control (CoreGraphics/xdotool/winapi)
- `tasks_tool.rs` — Task management
- `workspace_tool.rs` — Project context
- `hanzo_tool.rs` — Platform API

Performance: <5ms clicks, <2ms keypress, <50ms screenshots.

## Python SDK Parity

The Python implementation (`hanzoai/python-sdk/pkg/hanzo-mcp`) exposes the same 13 HIP-0300 tools via entry-point discovery from `hanzo-tools-*` packages. Tool names and action schemas are identical across both runtimes.

## Security

**Local-only by default.** Ngrok tunnel only activates with explicit credentials.

```bash
NGROK_API_KEY=...           # Tunnel (only set to go online)
MCP_ACCESS_TOKEN=...        # Bearer token
MCP_API_KEYS=key1,key2     # API keys
MCP_POST_QUANTUM_TLS=true  # Post-quantum TLS
```

Auth: `Authorization: Bearer TOKEN`, `X-MCP-Access-Token: TOKEN`, `X-API-Key: KEY`.
Rate limit: 100 req/min per IP. Max file size: 10MB.

## MCP API

```
POST /search  { query, maxResults?, filePattern? }  -> { results: [{ id, title, url }] }
POST /fetch   { id }                                -> { id, title, text, url, metadata }
GET  /files/{path}                                  -> file content
```

## Integration

- **Claude Desktop**: Configure in settings, tools auto-available
- **ChatGPT**: Set NGROK + MCP_ACCESS_TOKEN, add endpoints to GPT instructions
- **VS Code**: Local file:// or vscode://file/path:line:col URLs
