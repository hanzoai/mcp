# Hanzo MCP Integration with LibreChat

This guide explains how to integrate the Hanzo MCP server with LibreChat, including configuring the port settings for SSE transport.

## Updates Overview

The Hanzo MCP server has been updated to support the following features:

1. Configurable port for SSE transport via the `--port` parameter
2. Configurable host via the `--host` parameter
3. Better handling of port conflicts
4. Improved integration with LibreChat

## Installation

1. First, make sure the updated Hanzo MCP package is installed:

```bash
cd /Users/z/work/hanzo/mcp
./update_cli.sh
```

2. Then, update the LibreChat configuration:

```bash
cd /Users/z/work/hanzo/chat
./update_mcp.sh
```

## Manual Configuration

If you want to manually configure the integration, follow these steps:

### 1. LibreChat YAML Configuration

Update your `librechat.yaml` file to use the SSE transport:

```yaml
mcpServers:
  hanzo-mcp:
    type: sse
    url: http://localhost:3001/sse
    timeout: 60000
    initTimeout: 15000
```

Or if you prefer stdio transport:

```yaml
mcpServers:
  hanzo-mcp:
    type: stdio
    command: python3
    args:
      - -m
      - hanzo_mcp.cli
      - --port
      - "3001"
    timeout: 60000
    initTimeout: 15000
```

### 2. Starting the MCP Server

For SSE transport:

```bash
python3 -m hanzo_mcp.cli --transport sse --port 3001
```

For stdio transport, LibreChat will start the server automatically.

## Troubleshooting

### Port Conflicts

If you see errors about port 3001 being in use, you can:

1. Kill the process using the port:
   ```bash
   lsof -i :3001  # Find the process
   kill <PID>     # Kill it
   ```

2. Or use a different port:
   ```bash
   # In your command:
   python3 -m hanzo_mcp.cli --transport sse --port 3002
   
   # And update librechat.yaml to use port 3002
   ```

### Connection Issues

If LibreChat can't connect to the MCP server:

1. Ensure the server is running:
   ```bash
   ps aux | grep hanzo_mcp
   ```

2. Check the URL in the LibreChat configuration matches the port the server is running on

3. Try using `localhost` instead of `127.0.0.1` or vice versa

4. If using Docker, you might need to use `host.docker.internal` instead of `localhost`

## Advanced Usage

### Environment Variables

The MCP server also respects these environment variables:

- `FASTMCP_PORT`: Port to use for SSE transport
- `FASTMCP_HOST`: Host to bind to for SSE transport

Example:
```bash
FASTMCP_PORT=3002 FASTMCP_HOST=0.0.0.0 python3 -m hanzo_mcp.cli --transport sse
```

### Command Line Options

The CLI now supports these options:

```
--transport {stdio,sse}  Transport protocol to use (default: stdio)
--port PORT              Port to use for SSE transport (default: 3001)
--host HOST              Host to bind to for SSE transport (default: 0.0.0.0)
--name NAME             Name of the MCP server (default: claude-code)
--allow-path ALLOWED_PATHS  Add an allowed path (can be specified multiple times)
```

## Key Files

- `/Users/z/work/hanzo/mcp/hanzo_mcp/cli.py`: Main CLI entry point
- `/Users/z/work/hanzo/mcp/hanzo_mcp/server.py`: Server implementation
- `/Users/z/work/hanzo/chat/librechat.yaml`: LibreChat configuration
- `/Users/z/work/hanzo/chat/run_mcp_server.py`: Helper script to run MCP server
