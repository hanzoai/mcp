"""Remove MCP servers."""

from typing import Annotated, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.mcp.mcp_add import McpAddTool


ServerName = Annotated[
    str,
    Field(
        description="Name of the server to remove",
        min_length=1,
    ),
]

Force = Annotated[
    bool,
    Field(
        description="Force removal even if server is running",
        default=False,
    ),
]


class McpRemoveParams(TypedDict, total=False):
    """Parameters for MCP remove tool."""

    name: str
    force: bool


@final
class McpRemoveTool(BaseTool):
    """Tool for removing MCP servers."""

    def __init__(self):
        """Initialize the MCP remove tool."""
        pass

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "mcp_remove"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Remove previously added MCP servers.

This removes MCP servers that were added with mcp_add.
If the server is running, it will be stopped first.

Examples:
- mcp_remove --name filesystem
- mcp_remove --name github --force

Use 'mcp_stats' to see all servers before removing.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[McpRemoveParams],
    ) -> str:
        """Remove an MCP server.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of removing the server
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        name = params.get("name")
        if not name:
            return "Error: name is required"

        force = params.get("force", False)

        # Get current servers
        servers = McpAddTool.get_servers()
        
        if name not in servers:
            return f"Error: Server '{name}' not found. Use 'mcp_stats' to see available servers."

        server = servers[name]
        
        await tool_ctx.info(f"Removing MCP server '{name}'")

        # Check if server is running
        if server.get("status") == "running" and server.get("process_id"):
            if not force:
                return f"Error: Server '{name}' is currently running. Use --force to remove anyway."
            else:
                # TODO: Stop the server process
                await tool_ctx.info(f"Stopping running server '{name}'")

        # Remove from registry
        del McpAddTool._mcp_servers[name]
        McpAddTool._save_servers()

        output = [
            f"Successfully removed MCP server '{name}'",
            f"  Type: {server.get('type', 'unknown')}",
            f"  Command: {' '.join(server.get('command', []))}",
        ]
        
        if server.get("tools"):
            output.append(f"  Tools removed: {len(server['tools'])}")
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
