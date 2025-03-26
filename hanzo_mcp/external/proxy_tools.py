"""Proxy tools for external MCP servers.

This module provides tools for proxying requests to external MCP servers.
"""

import json
import logging
from typing import Any, Dict, List, Optional, final

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.external.mcp_manager import ExternalMCPServerManager
from hanzo_mcp.tools.common.context import create_tool_context

logger = logging.getLogger(__name__)


@final
class ProxyTools:
    """Proxy tools for external MCP servers."""

    def __init__(self) -> None:
        """Initialize proxy tools."""
        self.server_manager = ExternalMCPServerManager()

    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register proxy tools with the MCP server.

        Args:
            mcp_server: The MCP server to register the tools with
        """
        # Register tool to list available external MCP servers
        @mcp_server.tool()
        async def list_external_servers(ctx: MCPContext) -> str:
            """List available external MCP servers.

            Returns:
                A list of available external MCP servers
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("list_external_servers")

            await tool_ctx.info("Listing external MCP servers")

            enabled_servers = self.server_manager.get_enabled_servers()
            if not enabled_servers:
                return "No external MCP servers are available."

            result = "Available external MCP servers:\n\n"
            for server in enabled_servers:
                status = "running" if server.is_running() else "stopped"
                result += f"- {server.name}: {status} - {server.description}\n"

            return result

        # Register iTerm2 specific tools if available
        iterm2_server = self.server_manager.get_server("iterm2")
        if iterm2_server:
            self._register_iterm2_tools(mcp_server)

    def _register_iterm2_tools(self, mcp_server: FastMCP) -> None:
        """Register iTerm2 specific tools with the MCP server.

        Args:
            mcp_server: The MCP server to register the tools with
        """
        @mcp_server.tool()
        async def iterm2_run_command(command: str, ctx: MCPContext) -> str:
            """Run a command in iTerm2.

            Args:
                command: The command to run

            Returns:
                The result of the command
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("iterm2_run_command")

            await tool_ctx.info(f"Running command in iTerm2: {command}")

            server = self.server_manager.get_server("iterm2")
            if not server:
                await tool_ctx.error("iTerm2 MCP server is not available")
                return "Error: iTerm2 MCP server is not available"

            # Format the request as a tool invocation
            request = json.dumps({
                "type": "function",
                "name": "run_command",
                "arguments": {
                    "command": command
                }
            })

            response = server.send_request(request)
            if not response:
                await tool_ctx.error("Failed to communicate with iTerm2 MCP server")
                return "Error: Failed to communicate with iTerm2 MCP server"

            try:
                response_data = json.loads(response)
                return response_data.get("result", "No result returned from iTerm2")
            except Exception as e:
                await tool_ctx.error(f"Failed to parse response from iTerm2 MCP server: {str(e)}")
                return f"Error: Failed to parse response from iTerm2 MCP server: {str(e)}"

        @mcp_server.tool()
        async def iterm2_split_pane(
            ctx: MCPContext,
            horizontal: bool = True,
            profile: str = None,
            command: str = None,
        ) -> str:
            """Split the current iTerm2 pane.

            Args:
                horizontal: Whether to split horizontally (default: True)
                profile: The profile to use for the new pane (default: current)
                command: Command to run in the new pane (default: None)

            Returns:
                The result of the operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("iterm2_split_pane")

            await tool_ctx.info(f"Splitting iTerm2 pane (horizontal={horizontal})")

            server = self.server_manager.get_server("iterm2")
            if not server:
                await tool_ctx.error("iTerm2 MCP server is not available")
                return "Error: iTerm2 MCP server is not available"

            # Format the request as a tool invocation
            request = json.dumps({
                "type": "function",
                "name": "split_pane",
                "arguments": {
                    "horizontal": horizontal,
                    "profile": profile,
                    "command": command,
                }
            })

            response = server.send_request(request)
            if not response:
                await tool_ctx.error("Failed to communicate with iTerm2 MCP server")
                return "Error: Failed to communicate with iTerm2 MCP server"

            try:
                response_data = json.loads(response)
                return response_data.get("result", "Pane split successfully")
            except Exception as e:
                await tool_ctx.error(f"Failed to parse response from iTerm2 MCP server: {str(e)}")
                return f"Error: Failed to parse response from iTerm2 MCP server: {str(e)}"
