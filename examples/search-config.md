# MCP Search Configuration Examples

## URL Configuration for Different Scenarios

### 1. Local Development (Default)
When running locally, files are referenced with `file://` URLs:
```javascript
// No configuration needed - this is the default
// Results will have URLs like:
// file:///Users/z/work/project/src/index.ts
// vscode://file//Users/z/work/project/src/index.ts:42:1 (with line numbers)
```

### 2. Remote Access via Ngrok
When exposing your MCP server via ngrok:
```javascript
import { configureUrlHelper, startFileServer } from '@hanzo/mcp/search';

// Configure URL helper for ngrok
configureUrlHelper({
  baseUrl: 'https://abc123.ngrok.io',  // Your ngrok URL
  servePath: '/files',
  enableFileServing: true,
  workspaceRoot: process.cwd()
});

// Start the file server on port 8080
await startFileServer({
  port: 8080,
  host: '0.0.0.0',  // Listen on all interfaces
  enableCors: true   // Enable CORS for remote access
});

// Now search results will have URLs like:
// https://abc123.ngrok.io/files/src/index.ts#L42
```

### 3. Environment Variable Configuration
Set these environment variables to automatically configure URLs:
```bash
# Configure for remote access
export MCP_BASE_URL="https://your-domain.com"
export MCP_SERVE_PATH="/files"
export MCP_ENABLE_FILE_SERVING="true"
export MCP_WORKSPACE_ROOT="/path/to/workspace"

# Start your MCP server
hanzo-mcp serve
```

## File Server Features

### HTML Preview with Line Highlighting
Access files with syntax highlighting and line numbers:
```
https://your-domain.com/files/src/index.ts#L42?preview=true
```

### Direct File Access
Get raw file content:
```
https://your-domain.com/files/src/index.ts
```

### Security Features
- Only serves allowed file extensions (configurable)
- Prevents directory traversal attacks
- File size limits (default 10MB)
- CORS support for cross-origin access

## Custom Search Strategies

### Adding a Custom Search Strategy
```typescript
import { SearchStrategy, SearchType } from '@hanzo/mcp/search';

class CustomSearchStrategy implements SearchStrategy {
  readonly name = 'custom' as SearchType;
  
  shouldApply(query: string): boolean {
    // Your logic to determine when to use this strategy
    return query.startsWith('custom:');
  }
  
  getPriority(): number {
    return 25; // Priority for ranking results
  }
  
  async search(query: string, options?: SearchOptions): Promise<InternalSearchResult[]> {
    // Your search implementation
    return [];
  }
}

// Add to search engine
import { SearchEngine } from '@hanzo/mcp/search';

const searchEngine = new SearchEngine({
  strategies: [
    new CustomSearchStrategy(),
    // ... other strategies
  ]
});
```

## Integration with ChatGPT

When using with ChatGPT or other AI services that need to access files:

1. **Start MCP server with file serving:**
```javascript
import { startFileServer } from '@hanzo/mcp/search';

// Start file server before MCP server
await startFileServer({
  port: 8080,
  enableCors: true
});
```

2. **Expose via ngrok:**
```bash
# Expose file server
ngrok http 8080

# Configure MCP with ngrok URL
export MCP_BASE_URL="https://your-ngrok-url.ngrok.io"
```

3. **Search results will include accessible URLs:**
```json
{
  "results": [
    {
      "id": "src/utils/helper.ts:42:function",
      "title": "helper.ts:42",
      "url": "https://your-ngrok-url.ngrok.io/files/src/utils/helper.ts#L42"
    }
  ]
}
```

4. **Fetch will return full content with metadata:**
```json
{
  "id": "src/utils/helper.ts:42",
  "title": "helper.ts",
  "text": "// File content here...",
  "url": "https://your-ngrok-url.ngrok.io/files/src/utils/helper.ts#L42",
  "metadata": {
    "type": "file",
    "language": "typescript",
    "lines": 150,
    "excerpt": true,
    "startLine": 1,
    "endLine": 100
  }
}
```

## VSCode Integration

For local development with VSCode:
```javascript
// URLs will automatically use vscode:// protocol
// vscode://file//path/to/file.ts:line:column
// This allows clicking to open directly in VSCode
```

## Security Considerations

1. **File Access Control:**
   - Configure `allowedExtensions` to limit file types
   - Set `maxFileSize` to prevent large file transfers
   - Use `basePath` to restrict access to specific directories

2. **Remote Access:**
   - Enable CORS only when needed
   - Consider authentication middleware for production
   - Use HTTPS (ngrok provides this automatically)

3. **Environment Variables:**
   - Never commit `MCP_BASE_URL` with production URLs
   - Use `.env` files for local configuration
   - Rotate ngrok URLs regularly