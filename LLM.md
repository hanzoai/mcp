# MCP - LLM Context

## Overview

Hanzo MCP (Model Context Protocol) implementation. Provides unified code search, UI component management, and secure remote access for AI tools.

**Install**: `npm install -g @hanzo/mcp`

## Architecture

### Search Engine (`/src/search/`)

Strategy pattern with priority-based parallel execution:

| Strategy | Priority | Technology | Triggers |
|----------|----------|------------|----------|
| Symbol | 10 | TreeSitter AST | `class `, `function `, `def `, `interface ` |
| AST | 20 | TreeSitter | Code-like patterns, brackets |
| Vector | 30 | LanceDB embeddings | Natural language queries |
| Text | 40 | Ripgrep | Default for all queries |
| File | 50 | Glob patterns | Path separators, file extensions |

### Key Files

| File | Purpose |
|------|---------|
| `/src/search/search-engine.ts` | Search orchestrator |
| `/src/search/secure-tunnel.ts` | Ngrok security layer |
| `/src/search/file-server.ts` | HTTP file serving |
| `/src/search/url-helper.ts` | URL generation (ngrok > vscode > file://) |
| `/src/search/strategies/*.ts` | Search implementations |
| `/src/ui/unified-ui-tool.ts` | Unified UI tool (13 methods) |
| `/rust/src/tools/ui_tool/` | Rust native UI control |

## UI Tool

Consolidated 14 separate tools into 1 unified tool with method-based routing.

```typescript
await ui({ method: 'list_components', type: 'ui', category: 'Forms' });
```

### Rust UI Tool (`/rust/src/tools/ui_tool/`)
Native platform control: macOS (CoreGraphics), Linux (xdotool), Windows (winapi).
Performance: <5ms clicks, <2ms keypress, <50ms screenshots.

Actions: Click, DoubleClick, RightClick, Move, Drag, Scroll, Type, Press, Hotkey, Screenshot, GetActiveWindow, ListWindows, FocusWindow, Batch.

## GitHub UI Component Integration

Fetches components from multiple framework repos:

| Framework | Repository | Components Path |
|-----------|------------|-----------------|
| Hanzo (default) | hanzoai/ui | packages/ui/src/components |
| React | shadcn/ui | apps/v4/registry/new-york-v4/ui |
| Svelte | shadcn-svelte | apps/www/src/lib/registry/new-york/ui |
| Vue | shadcn-vue | apps/www/src/lib/registry/new-york/ui |
| React Native | react-native-reusables | packages/reusables/src |

Tools: `ui_fetch_component`, `ui_fetch_demo`, `ui_fetch_block`, `ui_list_github_components`, `ui_list_blocks`, `ui_component_metadata`, `ui_get_directory_structure`, `ui_github_rate_limit`.

Features: 15min TTL cache, circuit breaker (5 failures/60s), rate limit tracking, GITHUB_TOKEN auth.

## Security

**Local-only by default.** Ngrok tunnel only activates with explicit credentials.

### Environment Variables

```bash
# Tunnel (only set to go online)
NGROK_API_KEY=...
NGROK_AUTHTOKEN=...

# Auth (auto-generates if not set)
MCP_ACCESS_TOKEN=...        # Bearer token
MCP_API_KEYS=key1,key2     # API keys
MCP_JWT_SECRET=...          # JWT signing

# Security
MCP_POST_QUANTUM_TLS=true
MCP_ALLOWED_ORIGINS=https://chat.openai.com
```

Auth methods: `Authorization: Bearer TOKEN`, `X-MCP-Access-Token: TOKEN`, `X-API-Key: KEY`.

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
