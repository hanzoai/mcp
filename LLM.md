# MCP Search Implementation - AI Assistant Guide

## Overview
This document provides comprehensive context for AI assistants working with the Hanzo MCP (Model Context Protocol) search implementation. The system provides unified, multi-modal search capabilities with secure remote access for AI tools like ChatGPT.

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

## Future Enhancements

### Planned Features
- [ ] GraphQL search API
- [ ] WebSocket real-time search
- [ ] Search result caching layer
- [ ] Full-text search with Elasticsearch
- [ ] AI-powered query understanding
- [ ] Search history and analytics

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