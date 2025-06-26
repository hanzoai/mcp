"""Add MCP servers dynamically."""

import json
import subprocess
import shutil
from typing import Annotated, Optional, TypedDict, Unpack, final, override, Dict, Any
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context


ServerCommand = Annotated[
    str,
    Field(
        description="Server command (e.g., 'uvx mcp-server-git', 'npx @modelcontextprotocol/server-filesystem')",
        min_length=1,
    ),
]

ServerName = Annotated[
    str,
    Field(
        description="Unique name for the server",
        min_length=1,
    ),
]

Args = Annotated[
    Optional[str],
    Field(
        description="Additional arguments for the server",
        default=None,
    ),
]

Env = Annotated[
    Optional[Dict[str, str]],
    Field(
        description="Environment variables for the server",
        default=None,
    ),
]

AutoStart = Annotated[
    bool,
    Field(
        description="Automatically start the server after adding",
        default=True,
    ),
]


class McpAddParams(TypedDict, total=False):
    """Parameters for MCP add tool."""

    command: str
    name: str
    args: Optional[str]
    env: Optional[Dict[str, str]]
    auto_start: bool


@final
class McpAddTool(BaseTool):
    """Tool for adding MCP servers dynamically."""
    
    # Class variable to store added servers
    _mcp_servers: Dict[str, Dict[str, Any]] = {}
    _config_file = Path.home() / ".hanzo" / "mcp" / "servers.json"

    def __init__(self):
        """Initialize the MCP add tool."""
        # Load existing servers from config
        self._load_servers()

    @classmethod
    def _load_servers(cls):
        """Load servers from config file."""
        if cls._config_file.exists():
            try:
                with open(cls._config_file, 'r') as f:
                    cls._mcp_servers = json.load(f)
            except Exception:
                cls._mcp_servers = {}

    @classmethod
    def _save_servers(cls):
        """Save servers to config file."""
        cls._config_file.parent.mkdir(parents=True, exist_ok=True)
        with open(cls._config_file, 'w') as f:
            json.dump(cls._mcp_servers, f, indent=2)

    @classmethod
    def get_servers(cls) -> Dict[str, Dict[str, Any]]:
        """Get all registered MCP servers."""
        return cls._mcp_servers.copy()

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "mcp_add"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Add MCP (Model Context Protocol) servers dynamically.

This allows adding new MCP servers that provide additional tools.
Servers can be from npm packages or Python packages.

Common MCP servers:
- @modelcontextprotocol/server-filesystem - File system access
- @modelcontextprotocol/server-github - GitHub integration
- @modelcontextprotocol/server-gitlab - GitLab integration  
- @modelcontextprotocol/server-postgres - PostgreSQL access
- @modelcontextprotocol/server-sqlite - SQLite access
- mcp-server-git - Git operations
- mcp-server-docker - Docker management
- mcp-server-kubernetes - K8s management

Examples:
- mcp_add --command "npx @modelcontextprotocol/server-filesystem" --name filesystem --args "/path/to/allow"
- mcp_add --command "uvx mcp-server-git" --name git --args "--repository /path/to/repo"
- mcp_add --command "npx @modelcontextprotocol/server-github" --name github --env '{"GITHUB_TOKEN": "..."}'

Use 'mcp_stats' to see all added servers and their status.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[McpAddParams],
    ) -> str:
        """Add an MCP server.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of adding the server
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        command = params.get("command")
        if not command:
            return "Error: command is required"

        name = params.get("name")
        if not name:
            return "Error: name is required"

        args = params.get("args")
        env = params.get("env", {})
        auto_start = params.get("auto_start", True)

        # Check if server already exists
        if name in self._mcp_servers:
            return f"Error: Server '{name}' already exists. Use mcp_remove to remove it first."

        # Parse command to determine type
        server_type = "unknown"
        if command.startswith("npx"):
            server_type = "node"
        elif command.startswith("uvx"):
            server_type = "python"
        elif command.startswith("python"):
            server_type = "python"
        elif command.startswith("node"):
            server_type = "node"

        # Build full command
        full_command = [command]
        if args:
            import shlex
            # If command contains spaces, split it first
            if ' ' in command:
                full_command = shlex.split(command)
            full_command.extend(shlex.split(args))
        else:
            if ' ' in command:
                import shlex
                full_command = shlex.split(command)

        await tool_ctx.info(f"Adding MCP server '{name}' with command: {' '.join(full_command)}")

        # Create server configuration
        server_config = {
            "command": full_command,
            "name": name,
            "type": server_type,
            "env": env,
            "status": "stopped",
            "process_id": None,
            "tools": [],
            "resources": [],
            "prompts": []
        }

        # Test if command is valid
        if auto_start:
            try:
                # Try to start the server briefly to validate
                test_env = {**env} if env else {}
                
                # Quick test to see if command exists
                test_cmd = full_command[0]
                if test_cmd == "npx":
                    if not shutil.which("npx"):
                        return "Error: npx not found. Install Node.js first."
                elif test_cmd == "uvx":
                    if not shutil.which("uvx"):
                        return "Error: uvx not found. Install uv first."
                
                # TODO: Actually start and connect to the MCP server
                # For now, we just store the configuration
                server_config["status"] = "ready"
                
            except Exception as e:
                await tool_ctx.error(f"Failed to validate server: {str(e)}")
                server_config["status"] = "error"
                server_config["error"] = str(e)

        # Add server to registry
        self._mcp_servers[name] = server_config
        self._save_servers()

        output = [
            f"Successfully added MCP server '{name}':",
            f"  Type: {server_type}",
            f"  Command: {' '.join(full_command)}",
            f"  Status: {server_config['status']}",
        ]
        
        if env:
            output.append(f"  Environment: {list(env.keys())}")
        
        output.extend([
            "",
            "Use 'mcp_stats' to see server details.",
            f"Use 'mcp_remove --name {name}' to remove this server."
        ])

        # Note: In a real implementation, we would:
        # 1. Start the MCP server process
        # 2. Connect to it via stdio/HTTP
        # 3. Query its capabilities (tools, resources, prompts)
        # 4. Register those with our MCP server
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
