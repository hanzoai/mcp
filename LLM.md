# MCP Implementation - AI Assistant Guide

## Overview
This document provides comprehensive context for AI assistants working with the Hanzo MCP (Model Context Protocol) implementation. The system provides unified, multi-modal search capabilities, UI component management, and secure remote access for AI tools like ChatGPT.

## Latest Updates

### UI Tool Consolidation (2025-01-18)

Successfully consolidated 14+ separate UI tools into a single unified `ui` tool with method-based routing.

#### Architecture Changes
- **Before**: 14 separate tools (ui_init, ui_list_components, ui_get_component, etc.)
- **After**: 1 unified tool with method parameter
- **Reduction**: 93% fewer tools in MCP surface

#### Implementation
- **Main Tool**: `/src/ui/unified-ui-tool.ts` - Single tool with 13 methods
- **Migration Guide**: `/docs/UI_TOOL_MIGRATION.md` - Complete migration instructions
- **Tests**: `/test/ui/unified-ui-tool.test.ts` - 33 tests with full coverage
- **Examples**: `/examples/unified-ui-integration.ts` - Integration patterns

#### Usage
```typescript
// Single tool with method-based routing
await ui({
  method: 'list_components',  // or get_component, search, etc.
  type: 'ui',
  category: 'Forms'
});
```

#### Benefits
- Reduced complexity for AI assistants
- Better discoverability
- Consistent interface
- Easier maintenance
- Full backward compatibility

### Rust UI Tool Port (2025-01-27)

Ported the computer control UI tool to Rust with native platform API support.

#### Implementation
- **Location**: `/rust/src/tools/ui_tool/`
- **Platforms**: macOS (Quartz/CoreGraphics), Linux (xdotool), Windows (winapi)
- **Performance**: <5ms clicks, <2ms keypress, <50ms screenshots

#### Files
- `mod.rs` - Main tool with UiAction enum and NativeControl trait
- `macos.rs` - macOS native control using CoreGraphics framework
- `linux.rs` - Linux native control using xdotool/scrot commands
- `windows.rs` - Windows native control using winapi

#### Actions Supported
```rust
// Mouse
Click, DoubleClick, RightClick, MiddleClick, Move, MoveRelative, Drag, DragRelative, Scroll

// Keyboard
Type, Write, Press, KeyDown, KeyUp, Hotkey

// Screen
Screenshot, ScreenshotRegion, GetScreens, ScreenSize, Position

// Window
GetActiveWindow, ListWindows, FocusWindow

// Control
Sleep, SetPause, SetFailsafe, Batch, Info
```

#### Usage
```rust
let mut tool = UiTool::new();
tool.execute(UiToolArgs {
    action: "click".to_string(),
    x: Some(100),
    y: Some(200),
    ..Default::default()
}).await?;
```

#### Parity with TypeScript
| Feature | TypeScript | Rust |
|---------|------------|------|
| Core mouse/keyboard | ✅ | ✅ |
| Screenshot | ✅ | ✅ |
| Window management | ✅ | ✅ |
| Batch actions | ❌ | ✅ |
| Get pixel color | ✅ | ❌ (future) |
| Image recognition | ✅ | ❌ (future) |

## Architecture

### Core Components

#### 1. Search Engine (`/src/search/search-engine.ts`)
- **Purpose**: Unified search orchestrator
- **Pattern**: Strategy pattern with priority-based execution
- **Features**:
  - Parallel strategy execution
  - Result ranking and deduplication
  - Automatic strategy selection based on query

#### 2. Search Strategies (`/src/search/strategies/`)
Five specialized search strategies with different priorities:

| Strategy | Priority | Purpose | Technology |
|----------|----------|---------|------------|
| **Symbol** | 10 | Find class/function definitions | TreeSitter AST |
| **AST** | 20 | Code structure analysis | TreeSitter parsing |
| **Vector** | 30 | Semantic similarity search | LanceDB embeddings |
| **Text** | 40 | Pattern matching in files | Ripgrep |
| **File** | 50 | File path matching | Glob patterns |

#### 3. Security Layer (`/src/search/secure-tunnel.ts`)
- **Purpose**: Secure remote access with authentication
- **Features**:
  - Automatic ngrok detection (only enables with credentials)
  - Multi-method authentication (Bearer, API Key, JWT)
  - Post-quantum TLS configuration
  - Rate limiting and CORS protection
  - Access logging and monitoring

#### 4. File Server (`/src/search/file-server.ts`)
- **Purpose**: HTTP server for file content
- **Features**:
  - Authentication integration with SecureTunnel
  - HTML preview with syntax highlighting
  - Security restrictions (allowed extensions, max size)
  - Line number highlighting support

#### 5. URL Helper (`/src/search/url-helper.ts`)
- **Purpose**: Generate appropriate URLs for search results
- **Behavior**:
  - Uses ngrok tunnel URL when available
  - Falls back to VSCode URLs for local development
  - Standard file:// URLs as last resort

## OpenAI MCP Specification Compliance

### Search Tool
```typescript
// Input
{
  query: string,           // Search query
  maxResults?: number,     // Default: 20
  filePattern?: string     // Glob pattern filter
}

// Output
{
  results: [{
    id: string,           // Unique document identifier
    title: string,        // Document title
    url: string          // Accessible URL
  }]
}
```

### Fetch Tool
```typescript
// Input
{
  id: string              // Document ID from search
}

// Output
{
  id: string,
  title: string,
  text: string,          // Full document content
  url: string,
  metadata: object       // Additional metadata
}
```

## Security Configuration

### Environment Variables

#### Ngrok Configuration
```bash
# Automatic detection - MCP only goes online if these are set
NGROK_API_KEY=your-api-key          # Ngrok API key
NGROK_AUTHTOKEN=your-auth-token     # Ngrok auth token
NGROK_ENABLED=true                   # Explicit enable (optional)
NGROK_REGION=us                      # Region: us, eu, ap, au, sa, jp, in
```

#### Authentication
```bash
# Access control - auto-generates if not set
MCP_ACCESS_TOKEN=secure-token       # Bearer token
MCP_API_KEYS=key1,key2,key3        # Comma-separated API keys
MCP_JWT_SECRET=jwt-secret           # JWT signing secret
```

#### Security Settings
```bash
MCP_POST_QUANTUM_TLS=true          # Enable quantum-resistant TLS
MCP_ALLOWED_ORIGINS=https://chat.openai.com  # CORS origins
```

### Security Behavior

1. **Local-Only by Default**: Without ngrok credentials, MCP never exposes files over internet
2. **Auto-Detection**: Presence of `NGROK_API_KEY` or `NGROK_AUTHTOKEN` enables tunneling
3. **Required Authentication**: When tunnel is active, authentication is mandatory
4. **Token Generation**: If no token configured, generates secure random token
5. **Rate Limiting**: 100 requests/minute per IP (configurable)

### Authentication Methods

#### Bearer Token (Recommended)
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://tunnel.ngrok.io/search
```

#### Access Token Header
```bash
curl -H "X-MCP-Access-Token: YOUR_TOKEN" https://tunnel.ngrok.io/search
```

#### API Key
```bash
curl -H "X-API-Key: YOUR_API_KEY" https://tunnel.ngrok.io/search
```

## Usage Examples

### Local Development
```bash
# No configuration needed - local only
npm start
# Search accessible at: http://localhost:PORT/search
# Files accessible at: file:///absolute/path/to/file
```

### ChatGPT Integration
```bash
# Set up secure tunnel for ChatGPT
export NGROK_AUTHTOKEN=your-token
export MCP_ACCESS_TOKEN=chatgpt-token
export MCP_ALLOWED_ORIGINS=https://chat.openai.com
npm start

# Server output:
# 🔐 Starting secure ngrok tunnel...
# ✅ Secure tunnel established: https://abc123.ngrok.io
# 🔑 Access token: chatgpt-token
```

### Production Setup
```bash
# Full security configuration
export NGROK_API_KEY=your-api-key
export NGROK_AUTHTOKEN=your-token
export MCP_ACCESS_TOKEN=strong-random-token
export MCP_POST_QUANTUM_TLS=true
export MCP_ALLOWED_ORIGINS=https://your-app.com
npm start
```

## Search Strategy Selection

The engine automatically selects strategies based on query characteristics:

### Symbol Search (Priority 10)
- Triggers: `class `, `function `, `def `, `interface `, `type `, `enum `
- Best for: Finding specific code definitions
- Example: `class UserService`

### AST Search (Priority 20)
- Triggers: Code-like patterns, brackets, parentheses
- Best for: Understanding code structure
- Example: `getData() {`

### Vector Search (Priority 30)
- Triggers: Natural language queries
- Best for: Semantic similarity, concepts
- Example: `how does authentication work`

### Text Search (Priority 40)
- Triggers: Default for all queries
- Best for: Exact pattern matching
- Example: `TODO: fix this`

### File Search (Priority 50)
- Triggers: Path separators, file extensions
- Best for: Finding files by name
- Example: `src/utils/*.ts`

## API Endpoints

### Search Endpoint
```javascript
POST /search
Content-Type: application/json
Authorization: Bearer YOUR_TOKEN

{
  "query": "class UserService",
  "maxResults": 20,
  "filePattern": "*.ts"
}

// Response
{
  "results": [
    {
      "id": "src/services/user.ts:10:class",
      "title": "class UserService - src/services/user.ts",
      "url": "https://tunnel.ngrok.io/files/src/services/user.ts#L10"
    }
  ]
}
```

### Fetch Endpoint
```javascript
POST /fetch
Content-Type: application/json
Authorization: Bearer YOUR_TOKEN

{
  "id": "src/services/user.ts:10:class"
}

// Response
{
  "id": "src/services/user.ts:10:class",
  "title": "user.ts",
  "text": "// Full file content...",
  "url": "https://tunnel.ngrok.io/files/src/services/user.ts#L10",
  "metadata": {
    "language": "typescript",
    "size": 2048,
    "modified": "2024-01-01T00:00:00Z"
  }
}
```

### File Access
```javascript
GET /files/src/services/user.ts
Authorization: Bearer YOUR_TOKEN

// Returns file content with appropriate MIME type
// Add #L10 to highlight line 10
// Add ?preview=true for HTML preview
```

## Development Patterns

### Adding New Search Strategies

1. Create new strategy file in `/src/search/strategies/`
2. Implement `SearchStrategy` interface:
```typescript
export interface SearchStrategy {
  readonly name: SearchType;
  shouldApply(query: string): boolean;
  search(query: string, options?: SearchOptions): Promise<InternalSearchResult[]>;
  getPriority(): number;
}
```

3. Register in search engine initialization:
```typescript
new SearchEngine({
  strategies: [
    createYourStrategy(),  // Add here
    // ... other strategies
  ]
})
```

### Extending Security

1. Custom authentication in `SecureTunnel`:
```typescript
// Add to authenticateRequest method
if (customAuthCheck(req)) {
  this.logAccess(req, 'custom', true);
  return true;
}
```

2. Additional CORS headers:
```typescript
// In handleCORS method
res.setHeader('X-Custom-Header', 'value');
```

## Troubleshooting

### Ngrok Not Starting
```bash
# Check ngrok installation
ngrok version

# Install if missing
brew install ngrok  # macOS

# Verify credentials
ngrok config check
```

### Authentication Failures
1. Check token in environment: `echo $MCP_ACCESS_TOKEN`
2. Verify header format: `Authorization: Bearer TOKEN`
3. Check CORS for browser: `MCP_ALLOWED_ORIGINS`
4. Review logs: Access logs show auth attempts

### Search Not Finding Results
1. Check file extensions are indexed
2. Verify search strategy is applicable
3. Check file permissions
4. Review pattern syntax (regex for text, glob for files)

## Performance Optimization

### Caching
- Search results cached for 5 minutes
- File content cached for 15 minutes
- Vector embeddings persisted in LanceDB

### Parallel Execution
- All applicable strategies run in parallel
- Results merged and ranked by relevance
- Duplicate removal by file path and line

### Resource Limits
- Max 20 results by default (configurable)
- Max 10MB file size for serving
- Rate limit 100 req/min per IP

## Security Best Practices

1. **Never commit tokens**: Use `.env.local` (git-ignored)
2. **Rotate tokens regularly**: Generate new with `openssl rand -hex 32`
3. **Monitor access logs**: Check `tunnel.getAccessLogs()`
4. **Restrict origins**: Set specific `MCP_ALLOWED_ORIGINS`
5. **Use HTTPS only**: Enable `MCP_POST_QUANTUM_TLS=true`

## Common Integration Patterns

### ChatGPT Custom GPT
1. Configure MCP with ngrok and access token
2. Add to GPT instructions:
```
Search codebase: POST https://tunnel.ngrok.io/search
Headers: Authorization: Bearer TOKEN
Body: {"query": "search term"}

Fetch file: POST https://tunnel.ngrok.io/fetch
Headers: Authorization: Bearer TOKEN
Body: {"id": "file_id_from_search"}
```

### Claude Desktop MCP
1. Install: `npm install -g @hanzo/mcp`
2. Configure in Claude Desktop settings
3. Tools automatically available in Claude

### VS Code Extension
1. Use local file:// URLs
2. VSCode URLs for direct opening: `vscode://file/path:line:col`

## Architecture Decisions

### Why Strategy Pattern?
- Extensibility: Easy to add new search types
- Performance: Parallel execution of strategies
- Maintainability: Each strategy isolated
- Flexibility: Strategies can be enabled/disabled

### Why Ngrok Integration?
- Security: Only enabled with explicit credentials
- Simplicity: No complex firewall configuration
- Reliability: Established tunneling solution
- Features: Built-in HTTPS, regions, analytics

### Why Multi-Auth Support?
- Flexibility: Different auth for different clients
- Security: Multiple layers of protection
- Compatibility: Works with various AI tools
- Migration: Easy to switch auth methods

## GitHub UI Component Integration

### Overview
The MCP includes a comprehensive GitHub API integration for fetching UI components from multiple framework repositories. This enables AI assistants to access and use UI components from popular frameworks.

### Supported Frameworks

| Framework | Repository | Owner | Components Path |
|-----------|------------|-------|-----------------|
| **Hanzo** (default) | hanzoai/ui | hanzoai | packages/ui/src/components |
| **React** | shadcn/ui | shadcn-ui | apps/v4/registry/new-york-v4/ui |
| **Svelte** | shadcn-svelte | huntabyte | apps/www/src/lib/registry/new-york/ui |
| **Vue** | shadcn-vue | unovue | apps/www/src/lib/registry/new-york/ui |
| **React Native** | react-native-reusables | founded-labs | packages/reusables/src |

### Features

#### Core Capabilities
- **Multi-framework support**: Fetch components from 5 different UI frameworks
- **Component fetching**: Get source code for any component
- **Demo retrieval**: Access component demos and examples
- **Block fetching**: Get complete UI blocks/sections
- **Metadata access**: Retrieve component metadata
- **Directory browsing**: Explore repository structure

#### Production Features
- **Rate limit handling**: Tracks and respects GitHub API limits
- **Authentication**: Supports GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN
- **Caching**: 15-minute TTL cache for repeated requests
- **Circuit breaker**: Automatic failure recovery pattern
- **Error handling**: Graceful degradation and clear error messages

### Configuration

#### Environment Variables
```bash
# GitHub Authentication (optional but recommended)
GITHUB_TOKEN=your-github-token
# or
GITHUB_PERSONAL_ACCESS_TOKEN=your-personal-access-token
```

### Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `ui_fetch_component` | Fetch component source code | name, framework |
| `ui_fetch_demo` | Get component demo/example | name, framework |
| `ui_fetch_block` | Fetch UI block/section | name, framework |
| `ui_get_block` | Get UI block with multi-file support | name, framework, includeFiles |
| `ui_list_github_components` | List available components | framework |
| `ui_list_github_blocks` | List available blocks (basic) | framework |
| `ui_list_blocks` | List blocks with categories | framework, category |
| `ui_component_metadata` | Get component metadata | name, framework |
| `ui_get_component_demo` | Get component demo code | name, framework |
| `ui_get_component_metadata` | Get registry info | name, framework |
| `ui_directory_structure` | Browse repository structure (basic) | path, framework |
| `ui_get_directory_structure` | Browse with tree view | path, framework, depth |
| `ui_github_rate_limit` | Check API rate limit status | - |

### Usage Examples

#### Fetching a Component
```typescript
// Fetch button component from Hanzo UI (default)
await githubClient.fetchComponent('button');

// Fetch from specific framework
await githubClient.fetchComponent('dialog', 'react');
await githubClient.fetchComponent('card', 'svelte');
```

#### Listing Components
```typescript
// List all components from a framework
const components = await githubClient.listComponents('vue');
console.log(components); // ['button', 'card', 'dialog', ...]
```

#### Getting Component Demo
```typescript
// Fetch demo for a component
const demo = await githubClient.fetchComponentDemo('carousel', 'react');
```

#### Working with UI Blocks
```typescript
// Get a simple block
const block = await githubClient.fetchBlock('dashboard-01', 'react');

// Get a block with all its files (for complex multi-file blocks)
const blockWithFiles = await getBlockTool.handler({
  name: 'authentication-01',
  framework: 'react',
  includeFiles: true
});

// List blocks with categories
const categorizedBlocks = await listBlocksTool2.handler({
  framework: 'react',
  category: 'dashboard'  // Optional filter
});
```

#### Browsing Repository Structure
```typescript
// Basic directory listing
const structure = await githubClient.getDirectoryStructure(
  'apps/www/src/lib/registry/new-york/ui',
  'react'
);

// Enhanced tree view with depth control
const treeView = await getDirectoryStructureTool2.handler({
  path: 'packages/ui/src/components',
  framework: 'hanzo',
  depth: 2  // Traverse 2 levels deep
});
```

### Implementation Details

#### Caching Strategy
- Cache key: URL-based
- TTL: 15 minutes
- Automatic cleanup on expiry
- Manual cache clearing available

#### Circuit Breaker Pattern
- Threshold: 5 failures
- Timeout: 60 seconds
- States: closed, open, half-open
- Automatic recovery

#### Rate Limiting
- Tracks X-RateLimit headers
- Prevents requests when limit exceeded
- Provides reset time information
- Graceful degradation

### Integration with MCP Tools

The GitHub UI tools are automatically included in the MCP tool registry and can be:
- Used by AI assistants through MCP protocol
- Accessed via CLI commands
- Integrated into development workflows
- Combined with other MCP search tools

## Future Enhancements

### Planned Features
- [ ] GraphQL search API
- [ ] WebSocket real-time search
- [ ] Search result caching layer
- [ ] Full-text search with Elasticsearch
- [ ] AI-powered query understanding
- [ ] Search history and analytics
- [ ] Extended UI framework support (Angular, Solid, etc.)
- [ ] Component dependency resolution
- [ ] Automated component installation

### Security Roadmap
- [ ] Hardware security module (HSM) support
- [ ] Multi-factor authentication (MFA)
- [ ] Full post-quantum cryptography
- [ ] Advanced threat detection
- [ ] SIEM integration for audit logs

## Key Files Reference

| File | Purpose |
|------|---------|
| `/src/search/index.ts` | Main entry point, tool definitions |
| `/src/search/search-engine.ts` | Search orchestrator |
| `/src/search/types.ts` | TypeScript interfaces |
| `/src/search/secure-tunnel.ts` | Ngrok and security |
| `/src/search/file-server.ts` | HTTP file serving |
| `/src/search/url-helper.ts` | URL generation |
| `/src/search/strategies/*.ts` | Search implementations |
| `/docs/SECURITY.md` | Security documentation |

## Contact & Support

- Repository: https://github.com/hanzoai/mcp
- Issues: https://github.com/hanzoai/mcp/issues
- Security: security@hanzo.ai

---

*Last updated: 2024 - MCP v2.0.0*