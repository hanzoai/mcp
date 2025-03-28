"""Meta MCP Server for Hanzo MCP.

This module provides a comprehensive MetaMCPServer that manages both a main MCP server
and multiple sub-MCP servers, allowing for a unified interface to a wide range of
capabilities from AI assistants.
"""

import os
import json
import asyncio
import logging
import signal
from typing import Dict, List, Optional, Any, Set, Tuple, Union
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.server import HanzoMCPServer
from hanzo_mcp.tools.mcp_manager import MCPServerManager, MCPServer
from hanzo_mcp.tools.mcp_orchestrator import MCPOrchestrator
from hanzo_mcp.tools.common.context import DocumentContext, ToolContext

# Configure logging
logger = logging.getLogger(__name__)


class MetaMCPServer:
    """Meta MCP Server that manages main and sub-MCP servers.
    
    This class provides a unified interface for managing a main MCP server
    and multiple sub-MCP servers, allowing AI assistants to access a wide
    range of capabilities through a single interface.
    """
    
    def __init__(
        self,
        name: str = "hanzo-meta",
        allowed_paths: Optional[List[str]] = None,
        mcp_config: Optional[Dict[str, Any]] = None,
        sub_mcps_config: Optional[Dict[str, Dict[str, Any]]] = None,
        enable_proxy_tools: bool = True,
        auto_start_sub_mcps: bool = True,
    ):
        """Initialize the Meta MCP Server.
        
        Args:
            name: Name of the main MCP server
            allowed_paths: List of paths that the server is allowed to access
            mcp_config: Configuration for the main MCP server
            sub_mcps_config: Configuration for sub-MCP servers
            enable_proxy_tools: Whether to enable proxy tools for sub-MCP servers
            auto_start_sub_mcps: Whether to automatically start sub-MCP servers on initialization
        """
        self.name = name
        self.allowed_paths = allowed_paths or []
        self.mcp_config = mcp_config or {}
        self.sub_mcps_config = sub_mcps_config or {}
        self.enable_proxy_tools = enable_proxy_tools
        self.auto_start_sub_mcps = auto_start_sub_mcps
        
        # Initialize main MCP server
        self.main_server = self._init_main_server()
        
        # Get MCP orchestrator from main server
        self.orchestrator = self.main_server.mcp_orchestrator
        
        # Initialize server manager for sub-MCP servers
        self.server_manager = MCPServerManager()
        
        # Apply custom sub-MCP configurations if provided
        if self.sub_mcps_config:
            self._apply_sub_mcp_configs()
        
        # Auto-start sub-MCP servers if enabled
        if self.auto_start_sub_mcps:
            # Use asyncio.create_task to start servers asynchronously
            self._start_sub_mcps_task = asyncio.create_task(self._start_sub_mcps())
    
    def _init_main_server(self) -> HanzoMCPServer:
        """Initialize the main MCP server.
        
        Returns:
            The initialized HanzoMCPServer instance
        """
        # Create the main MCP server
        server = HanzoMCPServer(
            name=self.name,
            allowed_paths=self.allowed_paths,
            enable_external_servers=self.enable_proxy_tools
        )
        
        return server
    
    def _apply_sub_mcp_configs(self):
        """Apply custom sub-MCP server configurations."""
        for name, config in self.sub_mcps_config.items():
            # Check if this server already exists
            server = self.server_manager.get_server(name)
            
            if server:
                # Update existing server configuration
                server.command = config.get("command", server.command)
                server.args = config.get("args", server.args)
                server.env = config.get("env", server.env)
                server.description = config.get("description", server.description)
            else:
                # Add new server
                self.server_manager.add_server(
                    name=name,
                    command=config.get("command", ""),
                    args=config.get("args", []),
                    env=config.get("env", {}),
                    description=config.get("description", f"MCP Server: {name}"),
                    save=True
                )
    
    async def _start_sub_mcps(self):
        """Start all configured sub-MCP servers."""
        # Get all servers
        servers = self.server_manager.get_servers()
        
        # Start servers in parallel
        start_tasks = []
        for name, server in servers.items():
            # Check if server is enabled
            # If enabled is "auto", check if the required environment variable is set
            enabled = self._is_server_enabled(server)
            
            if enabled:
                # Start the server
                logger.info(f"Starting sub-MCP server: {name}")
                result = self.server_manager.start_server(name)
                
                if not result.get("success", False):
                    logger.error(f"Failed to start sub-MCP server {name}: {result.get('error', 'Unknown error')}")
    
    def _is_server_enabled(self, server: MCPServer) -> bool:
        """Check if a server is enabled.
        
        Args:
            server: The server to check
            
        Returns:
            True if the server is enabled, False otherwise
        """
        # Check if the server has a custom configuration
        if server.name in self.sub_mcps_config:
            # Use the enabled value from the custom configuration
            enabled = self.sub_mcps_config[server.name].get("enabled", "false").lower()
        else:
            # Use the default enabled value
            enabled = "false"
        
        # Check if the server is explicitly enabled
        if enabled == "true":
            return True
        elif enabled == "false":
            return False
        elif enabled == "auto":
            # Check if the auto_enable_env is set
            auto_enable_env = self.sub_mcps_config.get(server.name, {}).get("auto_enable_env")
            if auto_enable_env and auto_enable_env in os.environ and os.environ[auto_enable_env]:
                return True
            
            # Check if the environment variable is in the server's env
            for key, value in server.env.items():
                if value:  # If the value is set
                    return True
        
        return False
    
    async def start(self):
        """Start the Meta MCP Server and its sub-MCP servers."""
        logger.info(f"Starting Meta MCP Server: {self.name}")
        
        # Start sub-MCP servers if not already started
        if not hasattr(self, "_start_sub_mcps_task"):
            self._start_sub_mcps_task = asyncio.create_task(self._start_sub_mcps())
        
        # Wait for sub-MCP servers to start
        await self._start_sub_mcps_task
    
    def run(self, transport: str = "stdio", allowed_paths: Optional[List[str]] = None):
        """Run the Meta MCP Server.
        
        This method runs the main MCP server, which will handle all requests
        and forward them to sub-MCP servers as needed.
        
        Args:
            transport: The transport mechanism to use (stdio or sse)
            allowed_paths: Additional allowed paths
        """
        # Add additional allowed paths if provided
        if allowed_paths:
            for path in allowed_paths:
                if path not in self.allowed_paths:
                    self.allowed_paths.append(path)
                    self.main_server.permission_manager.add_allowed_path(path)
                    self.main_server.document_context.add_allowed_path(path)
        
        # Start the main MCP server
        try:
            self.main_server.run(transport=transport, allowed_paths=self.allowed_paths)
        except KeyboardInterrupt:
            logger.info("Received keyboard interrupt, stopping servers...")
            self.cleanup()
        finally:
            self.cleanup()
    
    def cleanup(self):
        """Clean up resources before shutdown."""
        logger.info("Cleaning up resources...")
        
        # Clean up main server
        if hasattr(self, "main_server"):
            self.main_server.cleanup()
        
        # Clean up sub-MCP servers
        if hasattr(self, "server_manager"):
            self.server_manager.stop_all_servers()
    
    def get_server_status(self) -> Dict[str, Any]:
        """Get the status of all MCP servers.
        
        Returns:
            Dictionary with server status information
        """
        # Get main server status
        status = {
            "main_server": {
                "name": self.name,
                "allowed_paths": self.allowed_paths,
                "running": True,
            }
        }
        
        # Get sub-MCP servers status
        status["sub_mcps"] = self.server_manager.get_all_server_info()
        
        return status
    
    async def restart_server(self, name: str) -> Dict[str, Any]:
        """Restart a sub-MCP server.
        
        Args:
            name: Name of the server to restart
            
        Returns:
            Dictionary with restart status information
        """
        # Check if server exists
        server = self.server_manager.get_server(name)
        if not server:
            return {
                "success": False,
                "error": f"Server not found: {name}"
            }
        
        # Stop the server
        stop_result = self.server_manager.stop_server(name)
        
        # Wait a moment for the server to fully stop
        await asyncio.sleep(1)
        
        # Start the server
        start_result = self.server_manager.start_server(name)
        
        return {
            "success": start_result.get("success", False),
            "stop_result": stop_result,
            "start_result": start_result
        }
    
    def get_available_tools(self) -> Dict[str, Dict[str, Any]]:
        """Get all available tools from main and sub-MCP servers.
        
        Returns:
            Dictionary mapping tool names to tool information
        """
        # Get tools from main server
        tools = {}
        
        # Get tools from sub-MCP servers
        if hasattr(self, "orchestrator"):
            sub_mcp_tools = self.orchestrator.get_available_tools()
            tools.update(sub_mcp_tools)
        
        return tools


def main():
    """Run the Meta MCP Server from the command line."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Meta MCP Server for Hanzo MCP"
    )
    
    parser.add_argument(
        "--name",
        default="hanzo-meta",
        help="Name of the Meta MCP Server (default: hanzo-meta)"
    )
    
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)"
    )
    
    parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)"
    )
    
    parser.add_argument(
        "--config",
        type=str,
        help="Path to Meta MCP Server configuration file (JSON)"
    )
    
    parser.add_argument(
        "--disable-proxy-tools",
        action="store_true",
        help="Disable proxy tools for sub-MCP servers"
    )
    
    parser.add_argument(
        "--disable-auto-start",
        action="store_true",
        help="Disable automatic starting of sub-MCP servers"
    )
    
    args = parser.parse_args()
    
    # Load configuration from file if provided
    mcp_config = {}
    sub_mcps_config = {}
    
    if args.config and os.path.exists(args.config):
        try:
            with open(args.config, "r") as f:
                config = json.load(f)
                mcp_config = config.get("mcp", {})
                sub_mcps_config = config.get("sub_mcps", {})
        except (json.JSONDecodeError, IOError) as e:
            print(f"Error loading configuration file: {e}")
            return
    
    # Create and run the Meta MCP Server
    meta_server = MetaMCPServer(
        name=args.name,
        allowed_paths=args.allowed_paths,
        mcp_config=mcp_config,
        sub_mcps_config=sub_mcps_config,
        enable_proxy_tools=not args.disable_proxy_tools,
        auto_start_sub_mcps=not args.disable_auto_start
    )
    
    # Register signal handlers for graceful shutdown
    def signal_handler(sig, frame):
        print("\nReceived signal to stop, shutting down...")
        meta_server.cleanup()
        import sys
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Run the server
    meta_server.run(
        transport=args.transport,
        allowed_paths=args.allowed_paths
    )


if __name__ == "__main__":
    main()
