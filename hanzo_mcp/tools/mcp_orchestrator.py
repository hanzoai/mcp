"""MCP Orchestrator for Hanzo MCP.

This module provides functionality for orchestrating multiple MCP servers,
forwarding requests to the appropriate server, and combining tools from all servers.
"""

import os
import json
import asyncio
import tempfile
import logging
import time
import uuid
from typing import Dict, List, Optional, Any, Set, Tuple

# Optional import for HTTP client
try:
    import aiohttp
    has_aiohttp = True
except ImportError:
    has_aiohttp = False

from mcp.server.fastmcp import FastMCP
from hanzo_mcp.tools.common.context import ToolContext, create_tool_context
from hanzo_mcp.tools.mcp_manager import MCPServerManager, MCPServer

# Configure logging
logger = logging.getLogger(__name__)

class MCPOrchestrator:
    """Orchestrates multiple MCP servers."""
    
    def __init__(self, main_mcp: FastMCP = None):
        """Initialize the MCP orchestrator.
        
        Args:
            main_mcp: The main MCP server instance
        """
        self.main_mcp = main_mcp
        self.manager = MCPServerManager()
        self.proxy_tools: Dict[str, Dict[str, Any]] = {}
        
    def initialize(self):
        """Initialize the orchestrator."""
        # Start all configured servers
        self.manager.start_all_servers()
        
        # Register proxy tools if main MCP is provided
        if self.main_mcp:
            self._register_proxy_tools()
    
    def _register_proxy_tools(self):
        """Register proxy tools for all sub-MCP servers."""
        # Create a parent tool for MCP operations
        @self.main_mcp.tool()
        async def run_mcp(
            ctx: Any,
            operation: str,
            server: str = None,
            **kwargs
        ) -> str:
            """Run operations on MCP servers.
            
            Args:
                operation: The operation to perform (list, start, stop, info, restart)
                server: The server to operate on (optional, for specific server operations)
                **kwargs: Additional arguments for the operation
                
            Returns:
                Operation result
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("run_mcp")
            
            # List of valid operations
            valid_operations = [
                "list", "start", "stop", "restart", "info", "add", "remove"
            ]
            
            if operation not in valid_operations:
                return await tool_ctx.error(
                    f"Invalid operation: {operation}. "
                    f"Valid operations: {', '.join(valid_operations)}"
                )
            
            # Handle each operation
            if operation == "list":
                return await self._handle_list_operation(tool_ctx)
            elif operation == "info":
                return await self._handle_info_operation(tool_ctx, server)
            elif operation == "start":
                return await self._handle_start_operation(tool_ctx, server)
            elif operation == "stop":
                return await self._handle_stop_operation(tool_ctx, server)
            elif operation == "restart":
                return await self._handle_restart_operation(tool_ctx, server)
            elif operation == "add":
                return await self._handle_add_operation(tool_ctx, **kwargs)
            elif operation == "remove":
                return await self._handle_remove_operation(tool_ctx, server)
            
            return await tool_ctx.error(f"Unhandled operation: {operation}")
    
    async def _handle_list_operation(self, tool_ctx: ToolContext) -> str:
        """Handle the list operation.
        
        Args:
            tool_ctx: Tool context
            
        Returns:
            Operation result
        """
        servers_info = self.manager.get_all_server_info()
        
        return await tool_ctx.success(
            f"Found {len(servers_info)} MCP servers",
            {
                "servers": servers_info,
                "running": sum(1 for s in servers_info.values() if s.get("running", False)),
                "total_tools": sum(s.get("tool_count", 0) for s in servers_info.values())
            }
        )
    
    async def _handle_info_operation(
        self, 
        tool_ctx: ToolContext, 
        server: Optional[str]
    ) -> str:
        """Handle the info operation.
        
        Args:
            tool_ctx: Tool context
            server: Server name
            
        Returns:
            Operation result
        """
        if not server:
            return await tool_ctx.error("Server name is required for info operation")
            
        server_info = self.manager.get_server_info(server)
        
        if "error" in server_info:
            return await tool_ctx.error(server_info["error"])
            
        return await tool_ctx.success(
            f"Server information for: {server}",
            server_info
        )
    
    async def _handle_start_operation(
        self, 
        tool_ctx: ToolContext, 
        server: Optional[str]
    ) -> str:
        """Handle the start operation.
        
        Args:
            tool_ctx: Tool context
            server: Server name
            
        Returns:
            Operation result
        """
        if not server:
            # Start all servers
            results = self.manager.start_all_servers()
            
            success_count = sum(1 for r in results.values() if r.get("success", False))
            
            return await tool_ctx.success(
                f"Started {success_count}/{len(results)} MCP servers",
                {"results": results}
            )
        else:
            # Start specific server
            result = self.manager.start_server(server)
            
            if not result.get("success", False):
                return await tool_ctx.error(result.get("error", f"Error starting server: {server}"))
                
            return await tool_ctx.success(
                result.get("message", f"Started server: {server}"),
                result
            )
    
    async def _handle_stop_operation(
        self, 
        tool_ctx: ToolContext, 
        server: Optional[str]
    ) -> str:
        """Handle the stop operation.
        
        Args:
            tool_ctx: Tool context
            server: Server name
            
        Returns:
            Operation result
        """
        if not server:
            # Stop all servers
            results = self.manager.stop_all_servers()
            
            success_count = sum(1 for r in results.values() if r.get("success", False))
            
            return await tool_ctx.success(
                f"Stopped {success_count}/{len(results)} MCP servers",
                {"results": results}
            )
        else:
            # Stop specific server
            result = self.manager.stop_server(server)
            
            if not result.get("success", False):
                return await tool_ctx.error(result.get("error", f"Error stopping server: {server}"))
                
            return await tool_ctx.success(
                result.get("message", f"Stopped server: {server}"),
                result
            )
    
    async def _handle_restart_operation(
        self, 
        tool_ctx: ToolContext, 
        server: Optional[str]
    ) -> str:
        """Handle the restart operation.
        
        Args:
            tool_ctx: Tool context
            server: Server name
            
        Returns:
            Operation result
        """
        if not server:
            # Stop all servers
            stop_results = self.manager.stop_all_servers()
            
            # Wait a moment for servers to fully stop
            await asyncio.sleep(1)
            
            # Start all servers
            start_results = self.manager.start_all_servers()
            
            success_count = sum(1 for r in start_results.values() if r.get("success", False))
            
            return await tool_ctx.success(
                f"Restarted {success_count}/{len(start_results)} MCP servers",
                {
                    "stop_results": stop_results,
                    "start_results": start_results
                }
            )
        else:
            # Stop specific server
            stop_result = self.manager.stop_server(server)
            
            if not stop_result.get("success", False):
                return await tool_ctx.error(
                    stop_result.get("error", f"Error stopping server: {server}")
                )
                
            # Wait a moment for server to fully stop
            await asyncio.sleep(1)
            
            # Start server
            start_result = self.manager.start_server(server)
            
            if not start_result.get("success", False):
                return await tool_ctx.error(
                    start_result.get("error", f"Error starting server: {server}")
                )
                
            return await tool_ctx.success(
                f"Restarted server: {server}",
                {
                    "stop_result": stop_result,
                    "start_result": start_result
                }
            )
    
    async def _handle_add_operation(
        self, 
        tool_ctx: ToolContext, 
        name: str = None, 
        command: str = None, 
        args: List[str] = None, 
        env: Dict[str, str] = None, 
        description: str = None
    ) -> str:
        """Handle the add operation.
        
        Args:
            tool_ctx: Tool context
            name: Server name
            command: Command to run the server
            args: Arguments for the command
            env: Environment variables
            description: Server description
            
        Returns:
            Operation result
        """
        if not name:
            return await tool_ctx.error("Server name is required")
            
        if not command:
            return await tool_ctx.error("Command is required")
            
        # Add the server
        result = self.manager.add_server(
            name=name,
            command=command,
            args=args or [],
            env=env or {},
            description=description or f"MCP server: {name}",
            save=True
        )
        
        if not result:
            return await tool_ctx.error(f"Failed to add server: {name}")
            
        return await tool_ctx.success(
            f"Added server: {name}",
            {
                "name": name,
                "command": command,
                "args": args or [],
                "description": description or f"MCP server: {name}"
            }
        )
    
    async def _handle_remove_operation(
        self, 
        tool_ctx: ToolContext, 
        server: Optional[str]
    ) -> str:
        """Handle the remove operation.
        
        Args:
            tool_ctx: Tool context
            server: Server name
            
        Returns:
            Operation result
        """
        if not server:
            return await tool_ctx.error("Server name is required for remove operation")
            
        # Remove the server
        result = self.manager.remove_server(server, save=True)
        
        if not result:
            return await tool_ctx.error(f"Failed to remove server: {server}")
            
        return await tool_ctx.success(f"Removed server: {server}")
    
    def register_all_servers(self, main_mcp: FastMCP):
        """Register all servers with the main MCP server.
        
        Args:
            main_mcp: The main MCP server instance
        """
        self.main_mcp = main_mcp
        self._register_proxy_tools()
    
    def cleanup(self):
        """Clean up resources."""
        # Stop all servers
        self.manager.stop_all_servers()
