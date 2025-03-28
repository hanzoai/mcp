"""External MCP server manager for Hanzo MCP.

This module provides functionality to discover and manage external MCP servers.
It allows Hanzo MCP to proxy requests to other MCP servers.
"""

import json
import os
import logging
import subprocess
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Any, final

from hanzo_mcp.external.config_manager import MCPServerConfig

logger = logging.getLogger(__name__)

@final
class ExternalMCPServer:
    """Represents an external MCP server."""

    def __init__(
        self,
        name: str,
        command: str,
        args: List[str] = None,
        enabled: bool = True,
        description: str = "",
    ):
        """Initialize an external MCP server.

        Args:
            name: The name of the server
            command: The command to run the server
            args: The arguments to pass to the command
            enabled: Whether the server is enabled
            description: A description of the server
        """
        self.name = name
        self.command = command
        self.args = args or []
        self.enabled = enabled
        self.description = description
        self._process = None

    def start(self) -> bool:
        """Start the external MCP server.

        Returns:
            True if the server was started successfully, False otherwise
        """
        if not self.enabled:
            logger.info(f"Server {self.name} is disabled")
            return False

        if self._process is not None:
            logger.warning(f"Server {self.name} is already running")
            return True

        try:
            cmd = [self.command] + self.args
            logger.info(f"Starting external MCP server {self.name}: {' '.join(cmd)}")
            
            # Start the process
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            
            return True
        except Exception as e:
            logger.error(f"Failed to start server {self.name}: {str(e)}")
            return False

    def stop(self) -> bool:
        """Stop the external MCP server.

        Returns:
            True if the server was stopped successfully, False otherwise
        """
        if self._process is None:
            logger.warning(f"Server {self.name} is not running")
            return True

        try:
            logger.info(f"Stopping external MCP server {self.name}")
            self._process.terminate()
            self._process.wait(timeout=5)
            self._process = None
            return True
        except Exception as e:
            logger.error(f"Failed to stop server {self.name}: {str(e)}")
            try:
                self._process.kill()
                self._process = None
            except:
                pass
            return False

    def is_running(self) -> bool:
        """Check if the server is running.

        Returns:
            True if the server is running, False otherwise
        """
        if self._process is None:
            return False
        
        return self._process.poll() is None

    def send_request(self, request: str) -> Optional[str]:
        """Send a request to the server.

        Args:
            request: The request to send

        Returns:
            The response from the server, or None if the server is not running
        """
        if not self.is_running():
            if not self.start():
                return None

        try:
            logger.debug(f"Sending request to {self.name}: {request}")
            self._process.stdin.write(request + "\n")
            self._process.stdin.flush()
            
            response = self._process.stdout.readline()
            logger.debug(f"Received response from {self.name}: {response}")
            
            return response
        except Exception as e:
            logger.error(f"Error communicating with server {self.name}: {str(e)}")
            self.stop()
            return None


@final
class ExternalMCPServerManager:
    """Manages external MCP servers."""

    def __init__(self):
        """Initialize the external MCP server manager."""
        # Load configuration
        self.config = MCPServerConfig()
        
        # Initialize servers dictionary
        self.servers: Dict[str, ExternalMCPServer] = {}
        
        # Load servers from configuration
        self._load_servers()

    def _load_servers(self) -> None:
        """Load external MCP servers from configuration."""
        # Load from configuration file
        config_servers = self.config.get_all_servers()
        for server_name, server_config in config_servers.items():
            if not server_config.get("enabled", True):
                logger.info(f"Server {server_name} is disabled in configuration")
                continue
                
            command = server_config.get("command")
            if not command:
                logger.warning(f"No command specified for server {server_name}")
                continue
                
            # Check if command exists
            if not shutil.which(command):
                logger.warning(f"Command {command} for server {server_name} not found")
                continue
                
            server = ExternalMCPServer(
                name=server_name,
                command=command,
                args=server_config.get("args", []),
                enabled=server_config.get("enabled", True),
                description=server_config.get("description", ""),
            )
            
            self.servers[server_name] = server
            logger.info(f"Loaded external MCP server from config: {server_name}")
        
        # Auto-detect servers if enabled
        if self.config.get_auto_detect():
            self._add_builtin_servers()

    def _add_builtin_servers(self) -> None:
        """Add built-in servers if they're not already configured."""
        # Add iTerm2 MCP server if available
        if "iterm2" not in self.servers:
            iterm2_path = shutil.which("iterm2-mcp")
            if iterm2_path:
                self.servers["iterm2"] = ExternalMCPServer(
                    name="iterm2",
                    command=iterm2_path,
                    enabled=True,
                    description="iTerm2 MCP server for terminal integration",
                )
                
                # Add to configuration if not already there
                if "iterm2" not in self.config.get_all_servers():
                    self.config.set_server_config("iterm2", {
                        "command": iterm2_path,
                        "enabled": True,
                        "description": "iTerm2 MCP server for terminal integration"
                    })
                    self.config.save_config()
                    
                logger.info("Added built-in iTerm2 MCP server")
                
        # Add Neovim MCP server if available
        if "neovim" not in self.servers:
            nvim_path = shutil.which("nvim-mcp")
            if nvim_path:
                self.servers["neovim"] = ExternalMCPServer(
                    name="neovim",
                    command=nvim_path,
                    enabled=True,
                    description="Neovim MCP server for editor integration",
                )
                
                # Add to configuration if not already there
                if "neovim" not in self.config.get_all_servers():
                    self.config.set_server_config("neovim", {
                        "command": nvim_path,
                        "enabled": True,
                        "description": "Neovim MCP server for editor integration"
                    })
                    self.config.save_config()
                    
                logger.info("Added built-in Neovim MCP server")

    def get_server(self, name: str) -> Optional[ExternalMCPServer]:
        """Get an external MCP server by name.

        Args:
            name: The name of the server

        Returns:
            The server if it exists and is enabled, None otherwise
        """
        server = self.servers.get(name)
        if server and server.enabled:
            return server
        return None

    def get_enabled_servers(self) -> List[ExternalMCPServer]:
        """Get all enabled external MCP servers.

        Returns:
            A list of enabled servers
        """
        return [server for server in self.servers.values() if server.enabled]

    def start_all(self) -> None:
        """Start all enabled external MCP servers."""
        for server in self.get_enabled_servers():
            server.start()

    def stop_all(self) -> None:
        """Stop all running external MCP servers."""
        for server in self.servers.values():
            if server.is_running():
                server.stop()

    def handle_request(self, server_name: str, request: str) -> Optional[str]:
        """Handle a request for an external MCP server.

        Args:
            server_name: The name of the server to handle the request
            request: The request to send to the server

        Returns:
            The response from the server, or None if the server is not available
        """
        server = self.get_server(server_name)
        if not server:
            logger.warning(f"Server {server_name} not found or disabled")
            return None
            
        return server.send_request(request)
