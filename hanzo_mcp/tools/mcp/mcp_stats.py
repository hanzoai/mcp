"""MCP server statistics."""

import json
from typing import TypedDict, Unpack, final, override
from datetime import datetime

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.mcp.mcp_add import McpAddTool


class McpStatsParams(TypedDict, total=False):
    """Parameters for MCP stats tool."""
    pass


@final
class McpStatsTool(BaseTool):
    """Tool for showing MCP server statistics."""

    def __init__(self):
        """Initialize the MCP stats tool."""
        pass

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "mcp_stats"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Show statistics about added MCP servers.

Displays:
- Total number of servers
- Server types (Python, Node.js)
- Server status (running, stopped, error)
- Available tools from each server
- Resource usage per server

Example:
- mcp_stats
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[McpStatsParams],
    ) -> str:
        """Get MCP server statistics.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            MCP server statistics
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Get all servers
        servers = McpAddTool.get_servers()
        
        if not servers:
            return "No MCP servers have been added yet.\n\nUse 'mcp_add' to add servers."

        output = []
        output.append("=== MCP Server Statistics ===")
        output.append(f"Total Servers: {len(servers)}")
        output.append("")
        
        # Count by type
        type_counts = {}
        status_counts = {}
        total_tools = 0
        total_resources = 0
        
        for server in servers.values():
            # Count types
            server_type = server.get("type", "unknown")
            type_counts[server_type] = type_counts.get(server_type, 0) + 1
            
            # Count status
            status = server.get("status", "unknown")
            status_counts[status] = status_counts.get(status, 0) + 1
            
            # Count tools and resources
            total_tools += len(server.get("tools", []))
            total_resources += len(server.get("resources", []))
        
        # Server types
        output.append("Server Types:")
        for stype, count in sorted(type_counts.items()):
            output.append(f"  {stype}: {count}")
        output.append("")
        
        # Server status
        output.append("Server Status:")
        for status, count in sorted(status_counts.items()):
            output.append(f"  {status}: {count}")
        output.append("")
        
        # Tools and resources
        output.append(f"Total Tools Available: {total_tools}")
        output.append(f"Total Resources Available: {total_resources}")
        output.append("")
        
        # Individual server details
        output.append("=== Server Details ===")
        
        for name, server in sorted(servers.items()):
            output.append(f"\n{name}:")
            output.append(f"  Type: {server.get('type', 'unknown')}")
            output.append(f"  Status: {server.get('status', 'unknown')}")
            output.append(f"  Command: {' '.join(server.get('command', []))}")
            
            if server.get("process_id"):
                output.append(f"  Process ID: {server['process_id']}")
            
            if server.get("error"):
                output.append(f"  Error: {server['error']}")
            
            tools = server.get("tools", [])
            if tools:
                output.append(f"  Tools ({len(tools)}):")
                for tool in tools[:5]:  # Show first 5
                    output.append(f"    - {tool}")
                if len(tools) > 5:
                    output.append(f"    ... and {len(tools) - 5} more")
            
            resources = server.get("resources", [])
            if resources:
                output.append(f"  Resources ({len(resources)}):")
                for resource in resources[:5]:  # Show first 5
                    output.append(f"    - {resource}")
                if len(resources) > 5:
                    output.append(f"    ... and {len(resources) - 5} more")
            
            if server.get("env"):
                output.append(f"  Environment vars: {list(server['env'].keys())}")
        
        # Common MCP servers hint
        output.append("\n=== Available MCP Servers ===")
        output.append("Common servers you can add:")
        output.append("  - @modelcontextprotocol/server-filesystem")
        output.append("  - @modelcontextprotocol/server-github")
        output.append("  - mcp-server-git")
        output.append("  - @modelcontextprotocol/server-postgres")
        output.append("  - @modelcontextprotocol/server-browser-use")
        output.append("  - @modelcontextprotocol/server-iterm2")
        output.append("  - @modelcontextprotocol/server-linear")
        output.append("  - @modelcontextprotocol/server-slack")
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
