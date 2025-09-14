# Adding New MCP Implementations

This guide shows how to add support for testing new MCP implementations in different programming languages.

## Step 1: Create Implementation Configuration

Add your implementation to `configs/implementations.ts`:

```typescript
{
  id: 'rust',
  name: 'Hanzo MCP Rust Implementation',
  language: 'rust',
  command: 'cargo',
  args: ['run', '--bin', 'mcp-server', '--', 'serve'],
  cwd: '../mcp-rust',
  env: {
    RUST_LOG: 'error',
    RUST_BACKTRACE: '1'
  },
  startupTimeout: 20000, // Rust might take longer to compile
  enabled: true,
  expectedCategories: ['files', 'search', 'shell', 'edit'],
  expectedToolCount: 20
}
```

## Step 2: Implementation Requirements

Your MCP implementation must:

### 1. Support MCP Protocol
- JSON-RPC 2.0 over stdio
- Handle `initialize` handshake
- Respond to `tools/list` and `tools/call`
- Send proper error responses

### 2. Implement Core Tools
At minimum, implement these core tools:
- `read_file` - Read file contents
- `write_file` - Write to files
- `list_files` - List directory contents
- `bash` - Execute shell commands
- `grep` - Search file contents

### 3. Follow Response Format
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Tool response content"
      }
    ]
  }
}
```

## Step 3: Test Your Implementation

### Basic Validation
```bash
# Validate server starts and responds
npx ts-node src/cli.ts validate rust

# List available tools
npx ts-node src/cli.ts list-implementations --enabled-only
```

### Run Core Tests
```bash
# Test only core functionality
npx ts-node src/cli.ts test --implementations rust --categories files shell

# Full test with verbose output
npx ts-node src/cli.ts test --implementations rust --verbose
```

## Language-Specific Examples

### Rust Implementation

`Cargo.toml`:
```toml
[package]
name = "hanzo-mcp-rust"
version = "0.1.0"

[[bin]]
name = "mcp-server"
path = "src/main.rs"

[dependencies]
serde_json = "1.0"
tokio = { version = "1.0", features = ["full"] }
```

`src/main.rs`:
```rust
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut stdin = AsyncBufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    
    loop {
        let mut line = String::new();
        if stdin.read_line(&mut line).await? == 0 {
            break;
        }
        
        let request: Value = serde_json::from_str(&line)?;
        let response = handle_request(request).await?;
        
        let response_line = format!("{}\n", serde_json::to_string(&response)?);
        stdout.write_all(response_line.as_bytes()).await?;
        stdout.flush().await?;
    }
    
    Ok(())
}

async fn handle_request(request: Value) -> Result<Value, Box<dyn std::error::Error>> {
    match request["method"].as_str() {
        Some("initialize") => handle_initialize(request),
        Some("tools/list") => handle_list_tools(request),
        Some("tools/call") => handle_call_tool(request).await,
        _ => Ok(json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {
                "code": -32601,
                "message": "Method not found"
            }
        }))
    }
}
```

### Python Implementation

`hanzo_mcp/server.py`:
```python
import json
import sys
import asyncio
from typing import Dict, Any

class MCPServer:
    def __init__(self):
        self.tools = [
            {
                "name": "read_file",
                "description": "Read file contents",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"}
                    },
                    "required": ["path"]
                }
            }
        ]
    
    async def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        method = request.get("method")
        
        if method == "initialize":
            return self.handle_initialize(request)
        elif method == "tools/list":
            return self.handle_list_tools(request)
        elif method == "tools/call":
            return await self.handle_call_tool(request)
        else:
            return {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {
                    "code": -32601,
                    "message": "Method not found"
                }
            }
    
    async def run(self):
        for line in sys.stdin:
            request = json.loads(line)
            response = await self.handle_request(request)
            print(json.dumps(response))
            sys.stdout.flush()

if __name__ == "__main__":
    server = MCPServer()
    asyncio.run(server.run())
```

### Go Implementation

`cmd/mcp-server/main.go`:
```go
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os"
)

type MCPRequest struct {
    JSONRPC string      `json:"jsonrpc"`
    ID      interface{} `json:"id"`
    Method  string      `json:"method"`
    Params  interface{} `json:"params,omitempty"`
}

type MCPResponse struct {
    JSONRPC string      `json:"jsonrpc"`
    ID      interface{} `json:"id"`
    Result  interface{} `json:"result,omitempty"`
    Error   interface{} `json:"error,omitempty"`
}

func main() {
    scanner := bufio.NewScanner(os.Stdin)
    
    for scanner.Scan() {
        var request MCPRequest
        if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
            continue
        }
        
        response := handleRequest(request)
        
        if responseBytes, err := json.Marshal(response); err == nil {
            fmt.Println(string(responseBytes))
        }
    }
}

func handleRequest(request MCPRequest) MCPResponse {
    switch request.Method {
    case "initialize":
        return handleInitialize(request)
    case "tools/list":
        return handleListTools(request)
    case "tools/call":
        return handleCallTool(request)
    default:
        return MCPResponse{
            JSONRPC: "2.0",
            ID:      request.ID,
            Error: map[string]interface{}{
                "code":    -32601,
                "message": "Method not found",
            },
        }
    }
}
```

## Step 4: Custom Tool Specifications

If your implementation has unique tools, add custom test specs:

```typescript
// specs/my-custom-tools.ts
export const myCustomToolSpecs: ToolTestSpec[] = [
  {
    name: 'my_special_tool',
    category: 'custom',
    description: 'Test my implementation-specific tool',
    testCases: [
      {
        name: 'basic functionality',
        input: { param: 'value' },
        expect: {
          success: true,
          content: [{
            type: 'text',
            textPattern: 'expected output'
          }]
        }
      }
    ]
  }
];
```

Then reference it in your test configuration:
```typescript
const config = {
  implementations: ['my-impl'],
  toolSpecs: [...allToolSpecs, ...myCustomToolSpecs]
};
```

## Step 5: Continuous Integration

Add CI configuration:

### GitHub Actions
```yaml
name: Test MCP Implementation
on: [push, pull_request]

jobs:
  test-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - name: Build Rust implementation
        working-directory: mcp-rust
        run: cargo build --bin mcp-server
      - name: Test MCP parity
        working-directory: test-suite
        run: |
          npm install
          npx ts-node src/cli.ts test --implementations rust
```

## Troubleshooting

### Common Issues

1. **Server Won't Start**
   - Check command and arguments
   - Verify working directory exists
   - Test command manually: `cargo run --bin mcp-server -- serve`

2. **Protocol Errors**
   - Validate JSON-RPC 2.0 format
   - Check required fields (jsonrpc, id, method)
   - Test with `npx ts-node src/cli.ts validate <impl-id> --verbose`

3. **Tool Validation Failures**
   - Ensure response format matches expectations
   - Check content type and structure
   - Use `--verbose` flag to see actual responses

### Debug Tips

```bash
# Test single tool
npx ts-node src/cli.ts test --implementations rust --tools read_file --verbose

# Generate implementation template
npx ts-node src/cli.ts dev generate-config rust rust

# Validate protocol compliance
npx ts-node src/cli.ts validate rust --verbose
```

## Best Practices

1. **Start Small**: Begin with core file operations
2. **Follow Specs**: Match exact response formats from TypeScript implementation
3. **Test Early**: Use validation command during development
4. **Error Handling**: Implement proper MCP error responses
5. **Documentation**: Document implementation-specific requirements
6. **Performance**: Consider startup time and response latency

## Getting Help

- Check existing implementations for reference patterns
- Use verbose mode for debugging test failures
- Review MCP protocol specification
- Open GitHub issues for test suite bugs or enhancement requests