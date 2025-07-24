"""Unified MCP tool for managing MCP servers."""

from typing import Annotated, TypedDict, Unpack, final, override, Optional, Dict, Any, List
from pathlib import Path
import json
import subprocess
import os
import signal

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action to perform: list, add, remove, enable, disable, restart, config",
        default="list",
    ),
]

Name = Annotated[
    Optional[str],
    Field(
        description="MCP server name",
        default=None,
    ),
]

Command = Annotated[
    Optional[str],
    Field(
        description="Command to run the MCP server",
        default=None,
    ),
]

Args = Annotated[
    Optional[List[str]],
    Field(
        description="Arguments for the MCP server command",
        default=None,
    ),
]

Env = Annotated[
    Optional[Dict[str, str]],
    Field(
        description="Environment variables for the MCP server",
        default=None,
    ),
]

ConfigKey = Annotated[
    Optional[str],
    Field(
        description="Configuration key to get/set",
        default=None,
    ),
]

ConfigValue = Annotated[
    Optional[Any],
    Field(
        description="Configuration value to set",
        default=None,
    ),
]

AutoStart = Annotated[
    bool,
    Field(
        description="Auto-start server when Hanzo AI starts",
        default=True,
    ),
]


class MCPParams(TypedDict, total=False):
    """Parameters for MCP tool."""
    action: str
    name: Optional[str]
    command: Optional[str]
    args: Optional[List[str]]
    env: Optional[Dict[str, str]]
    config_key: Optional[str]
    config_value: Optional[Any]
    auto_start: bool


@final
class MCPTool(BaseTool):
    """Tool for managing MCP servers."""
    
    # Config file
    CONFIG_FILE = Path.home() / ".hanzo" / "mcp" / "servers.json"
    
    # Running servers tracking
    _running_servers: Dict[str, subprocess.Popen] = {}
    
    def __init__(self):
        """Initialize the MCP management tool."""
        self.config = self._load_config()
        
        # Auto-start servers if configured
        self._auto_start_servers()
    
    def _load_config(self) -> Dict[str, Any]:
        """Load MCP server configuration."""
        if self.CONFIG_FILE.exists():
            try:
                with open(self.CONFIG_FILE, 'r') as f:
                    return json.load(f)
            except:
                pass
        
        # Default configuration with some examples
        return {
            "servers": {
                # Example configurations (disabled by default)
                "filesystem": {
                    "command": "npx",
                    "args": ["@modelcontextprotocol/server-filesystem", "/tmp"],
                    "env": {},
                    "enabled": False,
                    "auto_start": False,
                    "description": "MCP filesystem server for /tmp access"
                },
                "github": {
                    "command": "npx", 
                    "args": ["@modelcontextprotocol/server-github"],
                    "env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"},
                    "enabled": False,
                    "auto_start": False,
                    "description": "GitHub API access via MCP"
                },
                "postgres": {
                    "command": "npx",
                    "args": ["@modelcontextprotocol/server-postgres", "postgresql://localhost/db"],
                    "env": {},
                    "enabled": False,
                    "auto_start": False,
                    "description": "PostgreSQL database access"
                }
            },
            "global_env": {},
            "log_dir": str(Path.home() / ".hanzo" / "mcp" / "logs")
        }
    
    def _save_config(self):
        """Save configuration."""
        self.CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(self.CONFIG_FILE, 'w') as f:
            json.dump(self.config, f, indent=2)
    
    def _auto_start_servers(self):
        """Auto-start servers configured for auto-start."""
        for name, server_config in self.config.get("servers", {}).items():
            if server_config.get("enabled", False) and server_config.get("auto_start", False):
                self._start_server(name, server_config)
    
    def _start_server(self, name: str, config: Dict[str, Any]) -> bool:
        """Start an MCP server."""
        if name in self._running_servers:
            return False  # Already running
        
        try:
            # Prepare environment
            env = os.environ.copy()
            env.update(self.config.get("global_env", {}))
            
            # Process server-specific env vars
            server_env = config.get("env", {})
            for key, value in server_env.items():
                # Replace ${VAR} with actual environment variable
                if value.startswith("${") and value.endswith("}"):
                    var_name = value[2:-1]
                    if var_name in os.environ:
                        value = os.environ[var_name]
                env[key] = value
            
            # Prepare command
            cmd = [config["command"]] + config.get("args", [])
            
            # Create log directory
            log_dir = Path(self.config.get("log_dir", str(Path.home() / ".hanzo" / "mcp" / "logs")))
            log_dir.mkdir(parents=True, exist_ok=True)
            
            # Start process
            log_file = log_dir / f"{name}.log"
            with open(log_file, 'a') as log:
                process = subprocess.Popen(
                    cmd,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    preexec_fn=os.setsid if os.name != 'nt' else None
                )
            
            self._running_servers[name] = process
            return True
            
        except Exception as e:
            return False
    
    def _stop_server(self, name: str) -> bool:
        """Stop an MCP server."""
        if name not in self._running_servers:
            return False
        
        process = self._running_servers[name]
        try:
            if os.name == 'nt':
                process.terminate()
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            
            process.wait(timeout=5)
        except:
            # Force kill if needed
            try:
                if os.name == 'nt':
                    process.kill()
                else:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except:
                pass
        
        del self._running_servers[name]
        return True

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "mcp"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        servers = self.config.get("servers", {})
        enabled = sum(1 for s in servers.values() if s.get("enabled", False))
        running = len(self._running_servers)
        
        return f"""Manage MCP servers. Actions: list (default), add, remove, enable, disable, restart, config.

Usage:
mcp
mcp --action add --name github --command npx --args '["@modelcontextprotocol/server-github"]'
mcp --action enable --name github

Status: {enabled} enabled, {running} running"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[MCPParams],
    ) -> str:
        """Execute MCP management action."""
        # Create tool context only if we have a proper MCP context
        tool_ctx = None
        try:
            if hasattr(ctx, 'client') and ctx.client and hasattr(ctx.client, 'server'):
                tool_ctx = create_tool_context(ctx)
                if tool_ctx:
                    await tool_ctx.set_tool_info(self.name)
        except:
            pass
        
        # Extract action
        action = params.get("action", "list")
        
        # Route to appropriate handler
        if action == "list":
            return self._handle_list()
        elif action == "add":
            return self._handle_add(params)
        elif action == "remove":
            return self._handle_remove(params.get("name"))
        elif action == "enable":
            return self._handle_enable(params.get("name"))
        elif action == "disable":
            return self._handle_disable(params.get("name"))
        elif action == "restart":
            return self._handle_restart(params.get("name"))
        elif action == "config":
            return self._handle_config(params.get("config_key"), params.get("config_value"))
        else:
            return f"Error: Unknown action '{action}'. Valid actions: list, add, remove, enable, disable, restart, config"

    def _handle_list(self) -> str:
        """List all MCP servers."""
        servers = self.config.get("servers", {})
        
        if not servers:
            return "No MCP servers configured. Use 'mcp --action add' to add one."
        
        output = ["=== MCP Servers ==="]
        output.append(f"Total: {len(servers)} | Enabled: {sum(1 for s in servers.values() if s.get('enabled', False))} | Running: {len(self._running_servers)}")
        output.append("")
        
        for name, config in sorted(servers.items()):
            status_parts = []
            
            # Check if enabled
            if config.get("enabled", False):
                status_parts.append("✅ Enabled")
            else:
                status_parts.append("❌ Disabled")
            
            # Check if running
            if name in self._running_servers:
                process = self._running_servers[name]
                if process.poll() is None:
                    status_parts.append("🟢 Running")
                else:
                    status_parts.append("🔴 Stopped")
                    del self._running_servers[name]
            else:
                status_parts.append("⚫ Not running")
            
            # Auto-start status
            if config.get("auto_start", False):
                status_parts.append("🚀 Auto-start")
            
            status = " | ".join(status_parts)
            
            output.append(f"{name}: {status}")
            if config.get("description"):
                output.append(f"  Description: {config['description']}")
            output.append(f"  Command: {config['command']} {' '.join(config.get('args', []))}")
            
            if config.get("env"):
                env_str = ", ".join([f"{k}={v}" for k, v in config['env'].items()])
                output.append(f"  Environment: {env_str}")
        
        output.append("\nUse 'mcp --action enable --name <server>' to enable a server")
        output.append("Use 'mcp --action add' to add a new server")
        
        return "\n".join(output)

    def _handle_add(self, params: Dict[str, Any]) -> str:
        """Add a new MCP server."""
        name = params.get("name")
        command = params.get("command")
        
        if not name:
            return "Error: name is required for add action"
        if not command:
            return "Error: command is required for add action"
        
        servers = self.config.get("servers", {})
        if name in servers:
            return f"Error: Server '{name}' already exists. Use a different name or remove it first."
        
        # Create server config
        server_config = {
            "command": command,
            "args": params.get("args", []),
            "env": params.get("env", {}),
            "enabled": False,
            "auto_start": params.get("auto_start", True),
            "description": params.get("description", "")
        }
        
        servers[name] = server_config
        self.config["servers"] = servers
        self._save_config()
        
        return f"Successfully added MCP server '{name}'. Use 'mcp --action enable --name {name}' to enable it."

    def _handle_remove(self, name: Optional[str]) -> str:
        """Remove an MCP server."""
        if not name:
            return "Error: name is required for remove action"
        
        servers = self.config.get("servers", {})
        if name not in servers:
            return f"Error: Server '{name}' not found"
        
        # Stop if running
        if name in self._running_servers:
            self._stop_server(name)
        
        del servers[name]
        self.config["servers"] = servers
        self._save_config()
        
        return f"Successfully removed MCP server '{name}'"

    def _handle_enable(self, name: Optional[str]) -> str:
        """Enable an MCP server."""
        if not name:
            return "Error: name is required for enable action"
        
        servers = self.config.get("servers", {})
        if name not in servers:
            return f"Error: Server '{name}' not found"
        
        servers[name]["enabled"] = True
        self.config["servers"] = servers
        self._save_config()
        
        # Start if auto-start is enabled
        if servers[name].get("auto_start", False):
            if self._start_server(name, servers[name]):
                return f"Successfully enabled and started MCP server '{name}'"
            else:
                return f"Enabled MCP server '{name}' but failed to start it. Check the configuration."
        
        return f"Successfully enabled MCP server '{name}'"

    def _handle_disable(self, name: Optional[str]) -> str:
        """Disable an MCP server."""
        if not name:
            return "Error: name is required for disable action"
        
        servers = self.config.get("servers", {})
        if name not in servers:
            return f"Error: Server '{name}' not found"
        
        # Stop if running
        if name in self._running_servers:
            self._stop_server(name)
        
        servers[name]["enabled"] = False
        self.config["servers"] = servers
        self._save_config()
        
        return f"Successfully disabled MCP server '{name}'"

    def _handle_restart(self, name: Optional[str]) -> str:
        """Restart an MCP server."""
        if not name:
            return "Error: name is required for restart action"
        
        servers = self.config.get("servers", {})
        if name not in servers:
            return f"Error: Server '{name}' not found"
        
        if not servers[name].get("enabled", False):
            return f"Error: Server '{name}' is not enabled"
        
        # Stop if running
        if name in self._running_servers:
            self._stop_server(name)
        
        # Start again
        if self._start_server(name, servers[name]):
            return f"Successfully restarted MCP server '{name}'"
        else:
            return f"Failed to restart MCP server '{name}'. Check the configuration."

    def _handle_config(self, key: Optional[str], value: Optional[Any]) -> str:
        """Get or set configuration values."""
        if not key:
            # Show all config
            return json.dumps(self.config, indent=2)
        
        # Parse nested keys (e.g., "servers.github.auto_start")
        keys = key.split('.')
        
        if value is None:
            # Get value
            current = self.config
            for k in keys:
                if isinstance(current, dict) and k in current:
                    current = current[k]
                else:
                    return f"Configuration key '{key}' not found"
            
            return json.dumps(current, indent=2) if isinstance(current, (dict, list)) else str(current)
        else:
            # Set value
            # Navigate to parent
            current = self.config
            for k in keys[:-1]:
                if k not in current:
                    current[k] = {}
                current = current[k]
            
            # Parse value if it looks like JSON
            if isinstance(value, str) and value.startswith('{') or value.startswith('['):
                try:
                    value = json.loads(value)
                except:
                    pass
            
            # Set the value
            current[keys[-1]] = value
            self._save_config()
            
            return f"Successfully set {key} = {json.dumps(value) if isinstance(value, (dict, list)) else value}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass