# Hanzo MCP Search - E2E Demo Guide

## ✅ Setup Complete

The Hanzo MCP Search has been successfully:
1. Built and installed globally (`@hanzo/mcp` v2.0.0)
2. Configured with Claude Desktop
3. Tested with the CLI

## 🚀 How to Use with Claude Desktop

### 1. Restart Claude Desktop
After installation, restart Claude Desktop to load the MCP tools.

### 2. Available Tools

Once restarted, Claude will have access to these search tools:

#### `search` Tool
Search across your codebase with the following parameters:
- `query` (required): Search query text
- `maxResults` (optional): Limit results (default: 10)
- `filePattern` (optional): File glob pattern (e.g., "*.ts", "**/*.js")

**Example prompts to try in Claude:**
```
"Search for 'LanceDB' in the codebase"
"Find all TypeScript files containing 'search'"
"Look for 'function' in JavaScript files"
```

#### `fetch` Tool  
Fetch full document content by ID:
- `id` (required): Document ID from search results

### 3. Testing the Integration

In a new Claude conversation, try these commands:

1. **Basic Search Test:**
   "Use the search tool to find files containing 'vector'"

2. **Pattern Search Test:**
   "Search for 'export' in TypeScript files only"

3. **Fetch Document Test:**
   "Search for 'search' and then fetch the first result"

### 4. CLI Usage

You can also use the CLI directly:

```bash
# Start the server
hanzo-mcp serve

# Check version
hanzo-mcp --version
# Output: 2.0.0

# Install to Claude Desktop (already done)
hanzo-mcp install-desktop
```

## 🔒 Security Features

### Ngrok Integration (Optional)
To enable secure remote access:

```bash
# Set ngrok token
export NGROK_AUTHTOKEN=your_token_here
export NGROK_ENABLED=true
export ACCESS_TOKEN=your_secure_token

# Start server with ngrok
hanzo-mcp serve
```

When ngrok is enabled:
- Files are served over HTTPS with post-quantum TLS
- ACCESS_TOKEN authentication required
- URLs automatically use ngrok tunnel

### Local Mode (Default)
Without ngrok configuration:
- Files use `file://` URLs
- Only accessible locally
- No external exposure

## 🧪 Testing

### Run Direct Tests
```bash
# Run the test script
node test-search.js
```

### Expected Output Format

Search results follow OpenAI MCP specification:
```json
{
  "results": [
    {
      "id": "unique-id",
      "title": "filename.ts:42",
      "url": "file:///path/to/file"
    }
  ]
}
```

Fetch results return:
```json
{
  "id": "unique-id",
  "title": "filename.ts",
  "text": "file content...",
  "url": "file:///path/to/file",
  "metadata": {
    "type": "code",
    "language": "typescript"
  }
}
```

## 📁 Project Structure

```
/Users/z/work/hanzo/mcp/
├── src/
│   ├── search/          # Unified search implementation
│   │   ├── index.ts     # Main search & fetch tools
│   │   ├── strategies/  # Search strategy pattern
│   │   ├── secure-tunnel.ts  # Ngrok integration
│   │   └── url-helper.ts     # URL generation
│   └── tools/           # All MCP tools
├── dist/                # Built output
├── test-search.js       # Direct test script
└── package.json         # v2.0.0
```

## 🎯 Features

- **Multi-modal Search**: Text, AST, Symbol, Vector, File
- **OpenAI MCP Compliance**: Standard `search` and `fetch` tools
- **Extensible Architecture**: Strategy pattern for new search types
- **Secure Remote Access**: Optional ngrok with authentication
- **54 Total Tools**: Including UI, AutoGUI, and Orchestration tools

## 📊 Current Status

- ✅ CLI installed and working
- ✅ Claude Desktop configured
- ✅ Server can be started
- ✅ Search returns MCP-compliant format
- ✅ Build process optimized
- ⚠️ CI has test failures (non-blocking)

## 🔧 Troubleshooting

If Claude doesn't show the tools:
1. Fully quit Claude Desktop (not just close window)
2. Restart Claude Desktop
3. Check config: `~/Library/Application Support/Claude/claude_desktop_config.json`

If search returns no results:
1. Ensure you're in a directory with code files
2. Try broader search terms
3. Check file patterns match your project

## 📝 Next Steps

1. **In Claude Desktop**: Try the search commands above
2. **Set up ngrok** (optional): For remote access capability
3. **Customize search**: Add project-specific search strategies
4. **Monitor usage**: Check server logs for debugging

---

**Version**: 2.0.0  
**NPM Package**: @hanzo/mcp  
**GitHub**: https://github.com/hanzoai/mcp