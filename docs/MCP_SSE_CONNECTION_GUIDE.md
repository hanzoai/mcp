# MCP Server-Sent Events (SSE) Connection Guide

This document provides comprehensive instructions for connecting to a Hanzo MCP server using the Server-Sent Events (SSE) transport protocol. The guide is intended for developers building clients that need to interact with MCP servers.

## Table of Contents

1. [Overview](#overview)
2. [Server Configuration](#server-configuration)
3. [Connection Protocol](#connection-protocol)
4. [Message Format](#message-format)
5. [Available Endpoints](#available-endpoints)
6. [Tool Interactions](#tool-interactions)
7. [Authentication](#authentication)
8. [Error Handling](#error-handling)
9. [Complete Code Example](#complete-code-example)
10. [Troubleshooting](#troubleshooting)

## Overview

MCP (Machine Collaboration Protocol) provides a standardized way for language models to interact with external tools and resources. The SSE transport option allows web clients to establish a persistent connection with the MCP server for real-time bidirectional communication.

## Server Configuration

### Default Configuration

The MCP server uses the following default settings:

- **Host**: `0.0.0.0` (binds to all interfaces)
- **Port**: `8000`
- **SSE Endpoint**: `/sse`
- **Message Endpoint**: `/messages/`

### Customizing the Server

To start the server with custom settings:

```bash
# Using standard Python
python -m hanzo_mcp.cli --transport sse --host localhost --port 3001

# Using uvx
uvx hanzo-mcp --transport sse --host localhost --port 3001

# Environment variables can also be used to override settings
FASTMCP_PORT=3001 FASTMCP_HOST=localhost uvx hanzo-mcp --transport sse
```

**Important**: When configuring the server, make sure to set both command-line arguments and environment variables to ensure consistent behavior.

## Connection Protocol

### Step 1: Connect to the SSE Endpoint

The client first establishes a connection to the SSE endpoint:

```
GET http://<host>:<port>/sse
```

The server will keep this connection open for sending events to the client.

### Step 2: Receive the Message Endpoint

The server sends an `endpoint` event containing the URL where the client should POST messages:

```
event: endpoint
data: /messages/?session_id=<unique-session-id>
```

This URL includes a unique session ID that links messages to the SSE connection.

### Step 3: Send Messages to the Server

The client sends JSON-RPC messages to the provided endpoint:

```
POST http://<host>:<port>/messages/?session_id=<unique-session-id>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "method_name",
  "params": { ... },
  "id": "request-id"
}
```

### Step 4: Receive Responses

The server sends responses through the SSE connection:

```
event: message
data: {
  "jsonrpc": "2.0",
  "result": { ... },
  "id": "request-id"
}
```

## Message Format

MCP uses the JSON-RPC 2.0 protocol for message formatting:

### Request Format

```json
{
  "jsonrpc": "2.0",
  "method": "method_name",
  "params": {
    "param1": "value1",
    "param2": "value2"
  },
  "id": "unique-request-id"
}
```

### Response Format

```json
{
  "jsonrpc": "2.0",
  "result": {
    "key1": "value1",
    "key2": "value2"
  },
  "id": "unique-request-id"
}
```

### Error Response Format

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Error message",
    "data": { ... }
  },
  "id": "unique-request-id"
}
```

## Available Endpoints

### Standard Endpoint

```
POST http://<host>:<port>/messages/?session_id=<unique-session-id>
```

This is the default endpoint for all message types.

### Tools-Specific Endpoint

```
POST http://<host>:<port>/messages/?session_id=<unique-session-id>&type=tools
```

This specialized endpoint is specifically for tool-related operations. Use this endpoint when:

1. Requesting tool information (list_tools)
2. Invoking tools (run_command, read_files, etc.)
3. Managing tool permissions

### Prompts Endpoint

```
POST http://<host>:<port>/messages/?session_id=<unique-session-id>&type=prompts
```

This endpoint is for prompt-related operations, including listing available prompts and executing them.

## Tool Interactions

### Listing Available Tools

To get a list of available tools:

```json
{
  "jsonrpc": "2.0",
  "method": "list_tools",
  "params": {},
  "id": "tools-request-1"
}
```

The server responds with a list of tool definitions:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "tools": [
      {
        "name": "tool_name",
        "description": "Tool description",
        "parameters": { ... }
      },
      ...
    ]
  },
  "id": "tools-request-1"
}
```

### Invoking a Tool

To invoke a tool:

```json
{
  "jsonrpc": "2.0",
  "method": "run_tool",
  "params": {
    "tool": "tool_name",
    "params": {
      "param1": "value1",
      "param2": "value2"
    }
  },
  "id": "tool-run-1"
}
```

The server will respond with the tool's result:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "output": { ... }
  },
  "id": "tool-run-1"
}
```

## Authentication

The current implementation does not require authentication. Session IDs are used to maintain context but do not provide security.

For production use, implement proper authentication and authorization mechanisms appropriate for your deployment.

## Error Handling

Common error scenarios and how to handle them:

### Connection Errors

If the SSE connection fails, clients should implement an exponential backoff strategy for reconnection.

### Missing Session ID

If the session ID is not provided in requests to the message endpoint, the server will respond with a 400 Bad Request error.

### Invalid JSON-RPC Format

If the request doesn't follow the JSON-RPC 2.0 specification, the server will respond with a -32600 Invalid Request error.

### Method Not Found

If the requested method doesn't exist, the server will respond with a -32601 Method Not Found error.

### Invalid Parameters

If the parameters are invalid for the method, the server will respond with a -32602 Invalid Params error.

## Complete Code Example

See the `mcp_sse_client.py` script in this repository for a complete implementation of an MCP SSE client.

## Troubleshooting

### Server Not Responding on Expected Port

If the server appears to be running but is not responding on the expected port, check:

1. Environment variables (FASTMCP_PORT, FASTMCP_HOST)
2. Command-line arguments
3. Default FastMCP settings

Run `netstat -an | grep <port>` to check which ports are active.

### Connection Refused

If you get a "Connection Refused" error:

1. Verify the server is running
2. Check host and port settings
3. Ensure network/firewall allows connections

### No Response to Messages

If you can connect but don't receive responses:

1. Ensure you're sending proper JSON-RPC 2.0 format
2. Check that you're using the correct session ID
3. Verify the method name exists on the server

### Server Crashes or Errors

If the server crashes:

1. Check the server logs
2. Ensure all required dependencies are installed
3. Verify file permissions for any accessed paths
