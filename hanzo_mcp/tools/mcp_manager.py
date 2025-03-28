"""MCP Server Manager for Hanzo MCP.

This module provides functionality for managing and integrating with external MCP servers,
allowing the main Hanzo MCP server to act as a hub for specialized capabilities.
"""

import os
import json
import asyncio
import subprocess
import threading
import logging
import tempfile
import time
import signal
import platform
from pathlib import Path
from typing import Dict, List, Optional, Any, Set, Tuple

# Configure logging
logger = logging.getLogger(__name__)

# Default MCP servers configuration
DEFAULT_MCP_SERVERS = {
    "browser-use": {
        "enabled": "auto",  # auto, true, false
        "command": "uvx",
        "args": ["mcp-server-browser-use"],
        "description": "Automates browser interactions",
        "env": {
            "OPENROUTER_API_KEY": "",
            "OPENROUTER_ENDPOINT": "https://openrouter.ai/api/v1",
            "OPENAI_ENDPOINT": "https://api.openai.com/v1",
            "OPENAI_API_KEY": "",
            "ANTHROPIC_ENDPOINT": "https://api.anthropic.com",
            "ANTHROPIC_API_KEY": "",
            "GOOGLE_API_KEY": "",
            "AZURE_OPENAI_ENDPOINT": "",
            "AZURE_OPENAI_API_KEY": "",
            "DEEPSEEK_ENDPOINT": "https://api.deepseek.com",
            "DEEPSEEK_API_KEY": "",
            "MISTRAL_API_KEY": "",
            "MISTRAL_ENDPOINT": "https://api.mistral.ai/v1",
            "OLLAMA_ENDPOINT": "http://localhost:11434",
            "ANONYMIZED_TELEMETRY": "true",
            "BROWSER_USE_LOGGING_LEVEL": "info",
            "CHROME_PATH": "",
            "CHROME_USER_DATA": "",
            "CHROME_DEBUGGING_PORT": "9222",
            "CHROME_DEBUGGING_HOST": "localhost",
            "CHROME_PERSISTENT_SESSION": "false",
            "BROWSER_HEADLESS": "false",
            "BROWSER_DISABLE_SECURITY": "false",
            "BROWSER_WINDOW_WIDTH": "1280",
            "BROWSER_WINDOW_HEIGHT": "720",
            "BROWSER_TRACE_PATH": "trace.json",
            "BROWSER_RECORDING_PATH": "recording.mp4",
            "RESOLUTION": "1920x1080x24",
            "RESOLUTION_WIDTH": "1920",
            "RESOLUTION_HEIGHT": "1080",
            "VNC_PASSWORD": "youvncpassword",
            "MCP_MODEL_PROVIDER": "anthropic",
            "MCP_MODEL_NAME": "claude-3-5-sonnet-20241022",
            "MCP_TEMPERATURE": "0.3",
            "MCP_MAX_STEPS": "30",
            "MCP_USE_VISION": "true",
            "MCP_MAX_ACTIONS_PER_STEP": "5",
            "MCP_TOOL_CALL_IN_CONTENT": "true"
        }
    },
    "computer-use": {
        "enabled": "false",  # Disabled by default for security
        "command": "uvx",
        "args": ["mcp-server-computer-use"],
        "description": "Provides full computer access (use with caution)",
        "env": {}
    },
    "slack": {
        "enabled": "auto",  # Will only enable if API key is set
        "command": "uvx",
        "args": ["mcp-server-slack"],
        "description": "Integrates with Slack for messaging and channel management",
        "env": {
            "SLACK_API_TOKEN": ""
        },
        "auto_enable_env": "SLACK_API_TOKEN"  # Auto-enable if this env var is set
    },
    "github": {
        "enabled": "auto",
        "command": "uvx",
        "args": ["mcp-server-github"],
        "description": "Enables GitHub repository and issue management",
        "env": {
            "GITHUB_TOKEN": ""
        },
        "auto_enable_env": "GITHUB_TOKEN"
    },
    "linear": {
        "enabled": "auto",
        "command": "uvx",
        "args": ["mcp-server-linear"],
        "description": "Integrates with Linear for issue tracking and project management",
        "env": {
            "LINEAR_API_KEY": ""
        },
        "auto_enable_env": "LINEAR_API_KEY"
    }
}

class MCPServer:
    """Represents a running MCP server."""
    
    def __init__(
        self,
        name: str,
        command: str,
        args: List[str],
        env: Dict[str, str] = None,
        description: str = ""
    ):
        """Initialize an MCP server.
        
        Args:
            name: Name of the MCP server
            command: Command to run the server
            args: Arguments for the command
            env: Environment variables for the server
            description: Description of the server's capabilities
        """
        self.name = name
        self.command = command
        self.args = args
        self.env = env or {}
        self.description = description
        self.process = None
        self.running = False
        self.tools = {}
        self.socket_path = None
        self.pid = None
        self.start_time = None
        self.last_error = None
        
    def get_full_command(self) -> List[str]:
        """Get the full command to start the server.
        
        Returns:
            List of command parts
        """
        return [self.command] + self.args
    
    def get_env(self) -> Dict[str, str]:
        """Get the environment variables for the server.
        
        Returns:
            Dictionary of environment variables
        """
        # Start with current environment
        env = os.environ.copy()
        
        # Update with server-specific environment
        for key, value in self.env.items():
            if value:  # Only set if value is not empty
                env[key] = value
        
        return env
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert server to a dictionary.
        
        Returns:
            Dictionary representation of the server
        """
        return {
            "name": self.name,
            "description": self.description,
            "command": self.command,
            "args": self.args,
            "running": self.running,
            "pid": self.pid,
            "start_time": self.start_time,
            "tool_count": len(self.tools),
            "tools": list(self.tools.keys()) if self.tools else []
        }

class MCPServerManager:
    """Manages MCP servers for the Hanzo MCP server."""
    
    def __init__(self):
        """Initialize the MCP server manager."""
        self.servers: Dict[str, MCPServer] = {}
        self.config_path = os.path.join(
            os.path.expanduser("~"), ".config", "hanzo", "mcp_servers.json"
        )
        self._load_config()
        
    def _load_config(self):
        """Load the MCP servers configuration."""
        # Create default config if it doesn't exist
        config_dir = os.path.dirname(self.config_path)
        os.makedirs(config_dir, exist_ok=True)
        
        if not os.path.exists(self.config_path):
            with open(self.config_path, "w") as f:
                json.dump(DEFAULT_MCP_SERVERS, f, indent=2)
                
        # Load configuration
        try:
            with open(self.config_path, "r") as f:
                config = json.load(f)
                
            # Initialize servers from config
            for name, server_config in config.items():
                # Check if server should be enabled
                enabled = server_config.get("enabled", "false").lower()
                
                # If auto-enable, check environment variable
                if enabled == "auto" and "auto_enable_env" in server_config:
                    env_var = server_config["auto_enable_env"]
                    if env_var in os.environ and os.environ[env_var]:
                        enabled = "true"
                    else:
                        enabled = "false"
                
                # Skip if not enabled
                if enabled != "true":
                    continue
                
                # Create server
                server = MCPServer(
                    name=name,
                    command=server_config.get("command", ""),
                    args=server_config.get("args", []),
                    env=server_config.get("env", {}),
                    description=server_config.get("description", "")
                )
                
                self.servers[name] = server
                
        except Exception as e:
            logger.error(f"Error loading MCP servers config: {str(e)}")
            # Fall back to default configuration
            for name, server_config in DEFAULT_MCP_SERVERS.items():
                # Only add servers that are explicitly enabled
                if server_config.get("enabled", "false").lower() == "true":
                    server = MCPServer(
                        name=name,
                        command=server_config.get("command", ""),
                        args=server_config.get("args", []),
                        env=server_config.get("env", {}),
                        description=server_config.get("description", "")
                    )
                    self.servers[name] = server
    
    def save_config(self):
        """Save the current MCP servers configuration."""
        config = {}
        
        # Create config from default and current servers
        for name, default_config in DEFAULT_MCP_SERVERS.items():
            if name in self.servers:
                server = self.servers[name]
                config[name] = {
                    "enabled": "true",
                    "command": server.command,
                    "args": server.args,
                    "description": server.description,
                    "env": server.env
                }
            else:
                config[name] = default_config
                
        # Save configuration
        try:
            with open(self.config_path, "w") as f:
                json.dump(config, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving MCP servers config: {str(e)}")
    
    def get_server(self, name: str) -> Optional[MCPServer]:
        """Get an MCP server by name.
        
        Args:
            name: Name of the server
            
        Returns:
            The server if found, None otherwise
        """
        return self.servers.get(name)
    
    def get_servers(self) -> Dict[str, MCPServer]:
        """Get all MCP servers.
        
        Returns:
            Dictionary mapping server names to server objects
        """
        return self.servers
    
    def get_server_info(self, name: str) -> Dict[str, Any]:
        """Get information about an MCP server.
        
        Args:
            name: Name of the server
            
        Returns:
            Dictionary with server information
        """
        server = self.get_server(name)
        
        if not server:
            return {"error": f"Server not found: {name}"}
            
        return server.to_dict()
    
    def get_all_server_info(self) -> Dict[str, Dict[str, Any]]:
        """Get information about all MCP servers.
        
        Returns:
            Dictionary mapping server names to server information
        """
        return {name: server.to_dict() for name, server in self.servers.items()}
    
    def add_server(
        self,
        name: str,
        command: str,
        args: List[str],
        env: Dict[str, str] = None,
        description: str = "",
        save: bool = True
    ) -> bool:
        """Add a new MCP server.
        
        Args:
            name: Name of the server
            command: Command to run the server
            args: Arguments for the command
            env: Environment variables for the server
            description: Description of the server's capabilities
            save: Whether to save the configuration
            
        Returns:
            True if successful, False otherwise
        """
        if name in self.servers:
            return False
            
        server = MCPServer(
            name=name,
            command=command,
            args=args,
            env=env or {},
            description=description
        )
        
        self.servers[name] = server
        
        if save:
            self.save_config()
            
        return True
    
    def remove_server(self, name: str, save: bool = True) -> bool:
        """Remove an MCP server.
        
        Args:
            name: Name of the server
            save: Whether to save the configuration
            
        Returns:
            True if successful, False otherwise
        """
        if name not in self.servers:
            return False
            
        # Stop the server if it's running
        if self.servers[name].running:
            self.stop_server(name)
            
        # Remove the server
        del self.servers[name]
        
        if save:
            self.save_config()
            
        return True
    
    def is_server_running(self, name: str) -> bool:
        """Check if an MCP server is running.
        
        Args:
            name: Name of the server
            
        Returns:
            True if the server is running, False otherwise
        """
        server = self.get_server(name)
        
        if not server:
            return False
            
        return server.running
    
    def start_server(self, name: str) -> Dict[str, Any]:
        """Start an MCP server.
        
        Args:
            name: Name of the server
            
        Returns:
            Dictionary with result information
        """
        server = self.get_server(name)
        
        if not server:
            return {"success": False, "error": f"Server not found: {name}"}
            
        if server.running:
            return {"success": True, "message": f"Server already running: {name}"}
            
        try:
            # Prepare command
            command = server.get_full_command()
            env = server.get_env()
            
            # Start the server
            process = subprocess.Popen(
                command,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                universal_newlines=True
            )
            
            # Update server state
            server.process = process
            server.running = True
            server.pid = process.pid
            server.start_time = time.time()
            
            return {
                "success": True,
                "message": f"Started server: {name}",
                "pid": process.pid
            }
            
        except Exception as e:
            server.last_error = str(e)
            return {"success": False, "error": f"Error starting server: {str(e)}"}
    
    def stop_server(self, name: str) -> Dict[str, Any]:
        """Stop an MCP server.
        
        Args:
            name: Name of the server
            
        Returns:
            Dictionary with result information
        """
        server = self.get_server(name)
        
        if not server:
            return {"success": False, "error": f"Server not found: {name}"}
            
        if not server.running:
            return {"success": True, "message": f"Server not running: {name}"}
            
        try:
            # Stop the server
            if server.process:
                if platform.system() == "Windows":
                    # Windows doesn't support sending SIGTERM directly
                    subprocess.run(["taskkill", "/F", "/PID", str(server.pid)])
                else:
                    # Send SIGTERM to the process
                    os.kill(server.pid, signal.SIGTERM)
                
                # Wait for the process to terminate
                try:
                    server.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    # Force kill if timeout
                    if platform.system() == "Windows":
                        subprocess.run(["taskkill", "/F", "/T", "/PID", str(server.pid)])
                    else:
                        os.kill(server.pid, signal.SIGKILL)
                    server.process.wait(timeout=1)
                
            # Update server state
            server.process = None
            server.running = False
            server.pid = None
            server.tools = {}
            
            return {
                "success": True,
                "message": f"Stopped server: {name}"
            }
            
        except Exception as e:
            server.last_error = str(e)
            return {"success": False, "error": f"Error stopping server: {str(e)}"}
    
    def start_all_servers(self) -> Dict[str, Dict[str, Any]]:
        """Start all configured MCP servers.
        
        Returns:
            Dictionary mapping server names to start results
        """
        results = {}
        
        for name in self.servers:
            results[name] = self.start_server(name)
            
        return results
    
    def stop_all_servers(self) -> Dict[str, Dict[str, Any]]:
        """Stop all running MCP servers.
        
        Returns:
            Dictionary mapping server names to stop results
        """
        results = {}
        
        for name, server in self.servers.items():
            if server.running:
                results[name] = self.stop_server(name)
                
        return results
    
    def get_available_tools(self) -> Dict[str, Dict[str, Any]]:
        """Get all available tools from running MCP servers.
        
        Returns:
            Dictionary mapping tool names to tool definitions
        """
        tools = {}
        
        for name, server in self.servers.items():
            if server.running and server.tools:
                for tool_name, tool_def in server.tools.items():
                    tools[f"{name}.{tool_name}"] = {
                        "name": tool_name,
                        "server": name,
                        "definition": tool_def
                    }
                    
        return tools

    def register_server_tools(
        self, 
        server_name: str, 
        tools: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Register tools for a server.
        
        Args:
            server_name: Name of the server
            tools: Dictionary mapping tool names to tool definitions
            
        Returns:
            Result information
        """
        server = self.get_server(server_name)
        
        if not server:
            return {"success": False, "error": f"Server not found: {server_name}"}
            
        # Update server tools
        server.tools = tools
        
        return {
            "success": True, 
            "message": f"Registered {len(tools)} tools for server: {server_name}",
            "tool_count": len(tools)
        }
