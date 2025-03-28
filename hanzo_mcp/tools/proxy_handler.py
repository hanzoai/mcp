"""Proxy Handler for MCP Servers.

This module provides functionality for proxying requests to MCP servers
and dynamically creating proxy tools for all tools exposed by the servers.
"""

import os
import json
import asyncio
import logging
import subprocess
import re
from typing import Dict, List, Optional, Any, Set, Tuple

# Optional import for HTTP client
try:
    import aiohttp
    has_aiohttp = True
except ImportError:
    has_aiohttp = False

from mcp.server.fastmcp import FastMCP
from hanzo_mcp.tools.common.context import ToolContext, create_tool_context

# Configure logging
logger = logging.getLogger(__name__)

class ProxyHandler:
    """Handles proxying requests to MCP servers and creating proxy tools."""
    
    def __init__(self, main_mcp: FastMCP = None):
        """Initialize the proxy handler.
        
        Args:
            main_mcp: The main MCP server instance
        """
        self.main_mcp = main_mcp
        self.proxied_tools: Dict[str, Dict[str, Any]] = {}
        self.server_connections: Dict[str, Any] = {}
    
    async def discover_server_tools(self, name: str, connection_info: Dict[str, Any]) -> Dict[str, Any]:
        """Discover tools exposed by an MCP server.
        
        Args:
            name: Server name
            connection_info: Server connection information
            
        Returns:
            Dictionary mapping tool names to tool information
        """
        # Currently, this is a placeholder - in a real implementation, 
        # we would connect to the server and retrieve its tools.
        # For demonstration purposes, we'll return empty dict
        return {}
    
    async def register_proxy_tools(
        self, 
        server_name: str, 
        tools: Dict[str, Any]
    ) -> bool:
        """Register proxy tools for a server.
        
        Args:
            server_name: Server name
            tools: Dictionary mapping tool names to tool information
            
        Returns:
            True if successful, False otherwise
        """
        if not self.main_mcp:
            return False
            
        for tool_name, tool_info in tools.items():
            # Create a unique name for the proxied tool
            proxy_name = f"{server_name}_{tool_name}"
            
            # Store the tool information
            self.proxied_tools[proxy_name] = {
                "server": server_name,
                "name": tool_name,
                "info": tool_info
            }
            
            # Register a proxy tool
            self._register_proxy_tool(proxy_name, server_name, tool_name, tool_info)
            
        return True
    
    def _register_proxy_tool(
        self, 
        proxy_name: str, 
        server_name: str, 
        tool_name: str, 
        tool_info: Dict[str, Any]
    ):
        """Register a proxy tool with the main MCP server.
        
        Args:
            proxy_name: Unique name for the proxy tool
            server_name: Server name
            tool_name: Original tool name
            tool_info: Tool information
        """
        if not self.main_mcp:
            return
            
        # Define a generic proxy function
        @self.main_mcp.tool(name=proxy_name, register=True)
        async def proxy_tool(ctx: Any, **kwargs: Any) -> Any:
            """Proxy tool for {tool_name} on {server_name}.

            Args:
                **kwargs: Tool arguments
                
            Returns:
                Tool result
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info(f"{server_name}.{tool_name}")
            
            try:
                # In a real implementation, we would forward the request to the server
                # For demonstration purposes, we'll return a dummy result
                return await tool_ctx.success(
                    f"Executed {tool_name} on {server_name}",
                    {
                        "server": server_name,
                        "tool": tool_name,
                        "args": kwargs
                    }
                )
            except Exception as e:
                return await tool_ctx.error(f"Error executing tool: {str(e)}")
    
    def get_proxied_tools(self) -> Dict[str, Dict[str, Any]]:
        """Get all proxied tools.
        
        Returns:
            Dictionary mapping proxy names to tool information
        """
        return self.proxied_tools