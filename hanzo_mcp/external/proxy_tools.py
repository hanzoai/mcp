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
            
        # Register Neovim specific tools if available
        neovim_server = self.server_manager.get_server("neovim")
        if neovim_server:
            self._register_neovim_tools(mcp_server)
            
        # Register MCP server management tools
        self._register_server_management_tools(mcp_server)

    def _register_server_management_tools(self, mcp_server: FastMCP) -> None:
        """Register MCP server management tools with the MCP server.

        Args:
            mcp_server: The MCP server to register the tools with
        """
        @mcp_server.tool()
        async def enable_external_server(name: str, ctx: MCPContext) -> str:
            """Enable an external MCP server.

            Args:
                name: The name of the server to enable

            Returns:
                The result of the operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("enable_external_server")

            await tool_ctx.info(f"Enabling external MCP server: {name}")

            # Access the configuration directly through server_manager
            if self.server_manager.config.enable_server(name):
                await tool_ctx.info(f"Server {name} enabled in configuration")
                
                # Reload servers to apply the change
                self.server_manager._load_servers()
                
                return f"Server '{name}' has been enabled. It will be available for use in new sessions."
            else:
                await tool_ctx.error(f"Failed to enable server {name}")
                return f"Error: Failed to enable server '{name}'"

        @mcp_server.tool()
        async def disable_external_server(name: str, ctx: MCPContext) -> str:
            """Disable an external MCP server.

            Args:
                name: The name of the server to disable

            Returns:
                The result of the operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("disable_external_server")

            await tool_ctx.info(f"Disabling external MCP server: {name}")

            # Check if the server exists
            server = self.server_manager.get_server(name)
            if not server:
                await tool_ctx.error(f"Server {name} not found")
                return f"Error: Server '{name}' not found"

            # Access the configuration directly through server_manager
            if self.server_manager.config.disable_server(name):
                await tool_ctx.info(f"Server {name} disabled in configuration")
                
                # Stop the server if it's running
                if server.is_running():
                    server.stop()
                
                # Remove from the servers dictionary
                if name in self.server_manager.servers:
                    del self.server_manager.servers[name]
                
                return f"Server '{name}' has been disabled and will not be available in future sessions."
            else:
                await tool_ctx.error(f"Failed to disable server {name}")
                return f"Error: Failed to disable server '{name}'"

        @mcp_server.tool()
        async def set_auto_detect(enabled: bool, ctx: MCPContext) -> str:
            """Set whether to auto-detect external MCP servers.

            Args:
                enabled: Whether to enable auto-detection

            Returns:
                The result of the operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("set_auto_detect")

            await tool_ctx.info(f"Setting auto-detect to {enabled}")

            # Access the configuration directly through server_manager
            if self.server_manager.config.set_auto_detect(enabled):
                await tool_ctx.info(f"Auto-detect set to {enabled}")
                return f"Auto-detection of external MCP servers has been {'enabled' if enabled else 'disabled'}."
            else:
                await tool_ctx.error(f"Failed to set auto-detect to {enabled}")
                return f"Error: Failed to set auto-detect to {enabled}"

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

    def _register_neovim_tools(self, mcp_server: FastMCP) -> None:
        """Register Neovim specific tools with the MCP server.

        Args:
            mcp_server: The MCP server to register the tools with
        """
        @mcp_server.tool()
        async def nvim_open_file(filepath: str, ctx: MCPContext) -> str:
            """Open a file in Neovim.

            Args:
                filepath: Path to the file to open

            Returns:
                The result of the operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("nvim_open_file")

            await tool_ctx.info(f"Opening file in Neovim: {filepath}")

            server = self.server_manager.get_server("neovim")
            if not server:
                await tool_ctx.error("Neovim MCP server is not available")
                return "Error: Neovim MCP server is not available"

            # Format the request as a tool invocation
            request = json.dumps({
                "type": "function",
                "name": "open_file",
                "arguments": {
                    "filepath": filepath
                }
            })

            response = server.send_request(request)
            if not response:
                await tool_ctx.error("Failed to communicate with Neovim MCP server")
                return "Error: Failed to communicate with Neovim MCP server"

            try:
                response_data = json.loads(response)
                return response_data.get("result", "File opened successfully in Neovim")
            except Exception as e:
                await tool_ctx.error(f"Failed to parse response from Neovim MCP server: {str(e)}")
                return f"Error: Failed to parse response from Neovim MCP server: {str(e)}"

        @mcp_server.tool()
        async def nvim_execute_command(command: str, ctx: MCPContext) -> str:
            """Execute a command in Neovim.

            Args:
                command: The Vim command to execute (e.g., "w", "q", "wq")

            Returns:
                The result of the operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("nvim_execute_command")

            await tool_ctx.info(f"Executing command in Neovim: {command}")

            server = self.server_manager.get_server("neovim")
            if not server:
                await tool_ctx.error("Neovim MCP server is not available")
                return "Error: Neovim MCP server is not available"

            # Format the request as a tool invocation
            request = json.dumps({
                "type": "function",
                "name": "execute_command",
                "arguments": {
                    "command": command
                }
            })

            response = server.send_request(request)
            if not response:
                await tool_ctx.error("Failed to communicate with Neovim MCP server")
                return "Error: Failed to communicate with Neovim MCP server"

            try:
                response_data = json.loads(response)
                return response_data.get("result", f"Command '{command}' executed successfully in Neovim")
            except Exception as e:
                await tool_ctx.error(f"Failed to parse response from Neovim MCP server: {str(e)}")
                return f"Error: Failed to parse response from Neovim MCP server: {str(e)}"
