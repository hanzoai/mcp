"""Configuration tool for Hanzo AI.

Git-style config tool for managing settings.
"""

from typing import Annotated, TypedDict, Unpack, final, override, Optional, Dict, Any
from pathlib import Path
import json

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.config.index_config import IndexConfig, IndexScope


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action: get (default), set, list, toggle",
        default="get",
    ),
]

Key = Annotated[
    Optional[str],
    Field(
        description="Configuration key (e.g., index.scope, vector.enabled)",
        default=None,
    ),
]

Value = Annotated[
    Optional[str],
    Field(
        description="Configuration value",
        default=None,
    ),
]

Scope = Annotated[
    str,
    Field(
        description="Config scope: local (project) or global",
        default="local",
    ),
]

ConfigPath = Annotated[
    Optional[str],
    Field(
        description="Path for project-specific config",
        default=None,
    ),
]


class ConfigParams(TypedDict, total=False):
    """Parameters for config tool."""
    action: str
    key: Optional[str]
    value: Optional[str]
    scope: str
    path: Optional[str]


@final
class ConfigTool(BaseTool):
    """Git-style configuration management tool."""
    
    def __init__(self, permission_manager: PermissionManager):
        """Initialize config tool."""
        super().__init__(permission_manager)
        self.index_config = IndexConfig()

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "config"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Git-style configuration. Actions: get (default), set, list, toggle.

Usage:
config index.scope
config --action set index.scope project
config --action list
config --action toggle index.scope --path ./project"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ConfigParams],
    ) -> str:
        """Execute config operation."""
        tool_ctx = self.create_tool_context(ctx)
        
        # Extract parameters
        action = params.get("action", "get")
        key = params.get("key")
        value = params.get("value")
        scope = params.get("scope", "local")
        path = params.get("path")
        
        # Route to handler
        if action == "get":
            return await self._handle_get(key, scope, path, tool_ctx)
        elif action == "set":
            return await self._handle_set(key, value, scope, path, tool_ctx)
        elif action == "list":
            return await self._handle_list(scope, path, tool_ctx)
        elif action == "toggle":
            return await self._handle_toggle(key, scope, path, tool_ctx)
        else:
            return f"Error: Unknown action '{action}'. Valid actions: get, set, list, toggle"

    async def _handle_get(self, key: Optional[str], scope: str, path: Optional[str], tool_ctx) -> str:
        """Get configuration value."""
        if not key:
            return "Error: key required for get action"
            
        # Handle index scope
        if key == "index.scope":
            current_scope = self.index_config.get_scope(path)
            return f"index.scope={current_scope.value}"
            
        # Handle tool-specific settings
        if "." in key:
            tool, setting = key.split(".", 1)
            if setting == "enabled":
                enabled = self.index_config.is_indexing_enabled(tool)
                return f"{key}={enabled}"
                
        return f"Unknown key: {key}"

    async def _handle_set(self, key: Optional[str], value: Optional[str], scope: str, path: Optional[str], tool_ctx) -> str:
        """Set configuration value."""
        if not key:
            return "Error: key required for set action"
        if not value:
            return "Error: value required for set action"
            
        # Handle index scope
        if key == "index.scope":
            try:
                new_scope = IndexScope(value)
                self.index_config.set_scope(new_scope, path if scope == "local" else None)
                return f"Set {key}={value} ({'project' if path else 'global'})"
            except ValueError:
                return f"Error: Invalid scope value '{value}'. Valid: project, global, auto"
                
        # Handle tool-specific settings
        if "." in key:
            tool, setting = key.split(".", 1)
            if setting == "enabled":
                enabled = value.lower() in ["true", "yes", "1", "on"]
                self.index_config.set_indexing_enabled(tool, enabled)
                return f"Set {key}={enabled}"
                
        return f"Unknown key: {key}"

    async def _handle_list(self, scope: str, path: Optional[str], tool_ctx) -> str:
        """List all configuration."""
        status = self.index_config.get_status()
        
        output = ["=== Configuration ==="]
        output.append(f"\nDefault scope: {status['default_scope']}")
        
        if path:
            current_scope = self.index_config.get_scope(path)
            output.append(f"Current path scope: {current_scope.value}")
            
        output.append(f"\nProjects with custom config: {status['project_count']}")
        
        output.append("\nTool settings:")
        for tool, settings in status["tools"].items():
            output.append(f"  {tool}:")
            output.append(f"    enabled: {settings['enabled']}")
            output.append(f"    per_project: {settings['per_project']}")
            
        return "\n".join(output)

    async def _handle_toggle(self, key: Optional[str], scope: str, path: Optional[str], tool_ctx) -> str:
        """Toggle configuration value."""
        if not key:
            return "Error: key required for toggle action"
            
        # Handle index scope toggle
        if key == "index.scope":
            new_scope = self.index_config.toggle_scope(path if scope == "local" else None)
            return f"Toggled index.scope to {new_scope.value}"
            
        # Handle tool enable/disable toggle
        if "." in key:
            tool, setting = key.split(".", 1)
            if setting == "enabled":
                current = self.index_config.is_indexing_enabled(tool)
                self.index_config.set_indexing_enabled(tool, not current)
                return f"Toggled {key} to {not current}"
                
        return f"Cannot toggle key: {key}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass