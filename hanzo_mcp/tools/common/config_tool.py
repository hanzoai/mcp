"""Configuration management tool for dynamic settings updates."""

from typing import Dict, List, Optional, TypedDict, Unpack, Any, final
import json
from pathlib import Path

from fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.config.settings import (
    HanzoMCPSettings, 
    MCPServerConfig, 
    ProjectConfig, 
    load_settings, 
    save_settings,
    detect_project_from_path,
    ensure_project_hanzo_dir
)


class ConfigToolParams(TypedDict, total=False):
    """Parameters for configuration management operations."""
    
    action: str  # get, set, add_server, remove_server, add_project, etc.
    scope: Optional[str]  # global, project, current
    setting_path: Optional[str]  # dot-notation path like "agent.enabled" 
    value: Optional[Any]  # new value to set
    server_name: Optional[str]  # for MCP server operations
    server_config: Optional[Dict[str, Any]]  # for adding servers
    project_name: Optional[str]  # for project operations
    project_path: Optional[str]  # for project path detection


@final
class ConfigTool(BaseTool):
    """Tool for managing Hanzo MCP configuration dynamically."""
    
    def __init__(self, permission_manager: PermissionManager):
        """Initialize the configuration tool.
        
        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager
    
    @property
    def name(self) -> str:
        """Get the tool name."""
        return "config"
    
    @property
    def description(self) -> str:
        """Get the tool description."""
        return """Dynamically manage Hanzo MCP configuration settings through conversation.

Can get/set global settings, project-specific settings, manage MCP servers, configure tools,
and handle project workflows. Supports dot-notation for nested settings like 'agent.enabled'.

Perfect for AI-driven configuration where users can say things like:
- "Enable the agent tool for this project"  
- "Add a new MCP server for file operations"
- "Disable write tools globally but enable them for the current project"
- "Show me the current project configuration"

Automatically detects projects based on LLM.md files and manages .hanzo/ directories."""
    
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ConfigToolParams],
    ) -> str:
        """Manage configuration settings.
        
        Args:
            ctx: MCP context
            **params: Tool parameters
            
        Returns:
            Configuration operation result
        """
        action = params.get("action", "get")
        scope = params.get("scope", "global")
        setting_path = params.get("setting_path")
        value = params.get("value")
        server_name = params.get("server_name")
        server_config = params.get("server_config")
        project_name = params.get("project_name")
        project_path = params.get("project_path")
        
        try:
            if action == "get":
                return await self._get_config(scope, setting_path, project_name, project_path)
            elif action == "set":
                return await self._set_config(scope, setting_path, value, project_name, project_path)
            elif action == "add_server":
                return await self._add_mcp_server(server_name, server_config, scope, project_name)
            elif action == "remove_server":
                return await self._remove_mcp_server(server_name, scope, project_name)
            elif action == "enable_server":
                return await self._enable_mcp_server(server_name, scope, project_name)
            elif action == "disable_server":
                return await self._disable_mcp_server(server_name, scope, project_name)
            elif action == "trust_server":
                return await self._trust_mcp_server(server_name)
            elif action == "add_project":
                return await self._add_project(project_name, project_path)
            elif action == "set_current_project":
                return await self._set_current_project(project_name, project_path)
            elif action == "list_servers":
                return await self._list_mcp_servers(scope, project_name)
            elif action == "list_projects":
                return await self._list_projects()
            elif action == "detect_project":
                return await self._detect_project(project_path)
            else:
                return f"Error: Unknown action '{action}'. Available actions: get, set, add_server, remove_server, enable_server, disable_server, trust_server, add_project, set_current_project, list_servers, list_projects, detect_project"
                
        except Exception as e:
            return f"Error managing configuration: {str(e)}"
    
    async def _get_config(self, scope: str, setting_path: Optional[str], project_name: Optional[str], project_path: Optional[str]) -> str:
        """Get configuration value(s)."""
        # Load appropriate settings
        if scope == "project" or project_name or project_path:
            if project_path:
                project_info = detect_project_from_path(project_path)
                if project_info:
                    settings = load_settings(project_info["root_path"])
                else:
                    return f"No project detected at path: {project_path}"
            else:
                settings = load_settings()
        else:
            settings = load_settings()
        
        if not setting_path:
            # Return full config summary
            if scope == "project" and settings.current_project:
                project = settings.get_current_project()
                if project:
                    return f"Current Project Configuration ({project.name}):\\n{json.dumps(project.__dict__, indent=2)}"
            
            # Return global config summary
            summary = {
                "server": settings.server.__dict__,
                "enabled_tools": settings.get_enabled_tools(),
                "disabled_tools": settings.get_disabled_tools(),
                "agent": settings.agent.__dict__,
                "vector_store": settings.vector_store.__dict__,
                "hub_enabled": settings.hub_enabled,
                "mcp_servers": {name: server.__dict__ for name, server in settings.mcp_servers.items()},
                "current_project": settings.current_project,
                "projects": list(settings.projects.keys()),
            }
            return f"Configuration Summary:\\n{json.dumps(summary, indent=2)}"
        
        # Get specific setting
        value = self._get_nested_value(settings.__dict__, setting_path)
        if value is not None:
            return f"{setting_path}: {json.dumps(value, indent=2)}"
        else:
            return f"Setting '{setting_path}' not found"
    
    async def _set_config(self, scope: str, setting_path: Optional[str], value: Any, project_name: Optional[str], project_path: Optional[str]) -> str:
        """Set configuration value."""
        if not setting_path:
            return "Error: setting_path is required for set action"
        
        # Load settings
        project_dir = None
        if scope == "project" or project_name or project_path:
            if project_path:
                project_info = detect_project_from_path(project_path)
                if project_info:
                    project_dir = project_info["root_path"]
                else:
                    return f"No project detected at path: {project_path}"
        
        settings = load_settings(project_dir)
        
        # Set the value
        if self._set_nested_value(settings.__dict__, setting_path, value):
            # Save settings
            if scope == "project" or project_dir:
                save_settings(settings, global_config=False)
            else:
                save_settings(settings, global_config=True)
            return f"Successfully set {setting_path} = {json.dumps(value)}"
        else:
            return f"Error: Could not set '{setting_path}'"
    
    async def _add_mcp_server(self, server_name: Optional[str], server_config: Optional[Dict[str, Any]], scope: str, project_name: Optional[str]) -> str:
        """Add a new MCP server."""
        if not server_name or not server_config:
            return "Error: server_name and server_config are required"
        
        settings = load_settings()
        
        # Create server config
        mcp_server = MCPServerConfig(
            name=server_name,
            command=server_config.get("command", ""),
            args=server_config.get("args", []),
            enabled=server_config.get("enabled", True),
            trusted=server_config.get("trusted", False),
            description=server_config.get("description", ""),
            capabilities=server_config.get("capabilities", []),
        )
        
        if settings.add_mcp_server(mcp_server):
            save_settings(settings)
            return f"Successfully added MCP server '{server_name}'"
        else:
            return f"Error: MCP server '{server_name}' already exists"
    
    async def _remove_mcp_server(self, server_name: Optional[str], scope: str, project_name: Optional[str]) -> str:
        """Remove an MCP server."""
        if not server_name:
            return "Error: server_name is required"
        
        settings = load_settings()
        
        if settings.remove_mcp_server(server_name):
            save_settings(settings)
            return f"Successfully removed MCP server '{server_name}'"
        else:
            return f"Error: MCP server '{server_name}' not found"
    
    async def _enable_mcp_server(self, server_name: Optional[str], scope: str, project_name: Optional[str]) -> str:
        """Enable an MCP server."""
        if not server_name:
            return "Error: server_name is required"
        
        settings = load_settings()
        
        if settings.enable_mcp_server(server_name):
            save_settings(settings)
            return f"Successfully enabled MCP server '{server_name}'"
        else:
            return f"Error: MCP server '{server_name}' not found"
    
    async def _disable_mcp_server(self, server_name: Optional[str], scope: str, project_name: Optional[str]) -> str:
        """Disable an MCP server."""
        if not server_name:
            return "Error: server_name is required"
        
        settings = load_settings()
        
        if settings.disable_mcp_server(server_name):
            save_settings(settings)
            return f"Successfully disabled MCP server '{server_name}'"
        else:
            return f"Error: MCP server '{server_name}' not found"
    
    async def _trust_mcp_server(self, server_name: Optional[str]) -> str:
        """Trust an MCP server."""
        if not server_name:
            return "Error: server_name is required"
        
        settings = load_settings()
        
        if settings.trust_mcp_server(server_name):
            save_settings(settings)
            return f"Successfully trusted MCP server '{server_name}'"
        else:
            return f"Error: MCP server '{server_name}' not found"
    
    async def _add_project(self, project_name: Optional[str], project_path: Optional[str]) -> str:
        """Add a project configuration."""
        if not project_path:
            return "Error: project_path is required"
        
        # Detect or create project
        project_info = detect_project_from_path(project_path)
        if not project_info:
            return f"No LLM.md found in project path: {project_path}"
        
        if not project_name:
            project_name = project_info["name"]
        
        settings = load_settings()
        
        project_config = ProjectConfig(
            name=project_name,
            root_path=project_info["root_path"],
        )
        
        if settings.add_project(project_config):
            save_settings(settings)
            return f"Successfully added project '{project_name}' at {project_info['root_path']}"
        else:
            return f"Error: Project '{project_name}' already exists"
    
    async def _set_current_project(self, project_name: Optional[str], project_path: Optional[str]) -> str:
        """Set the current active project."""
        settings = load_settings()
        
        if project_path:
            project_info = detect_project_from_path(project_path)
            if project_info:
                project_name = project_info["name"]
                # Auto-add project if not exists
                if project_name not in settings.projects:
                    await self._add_project(project_name, project_path)
                    settings = load_settings()  # Reload after adding
        
        if not project_name:
            return "Error: project_name or project_path is required"
        
        if settings.set_current_project(project_name):
            save_settings(settings)
            return f"Successfully set current project to '{project_name}'"
        else:
            return f"Error: Project '{project_name}' not found"
    
    async def _list_mcp_servers(self, scope: str, project_name: Optional[str]) -> str:
        """List MCP servers."""
        settings = load_settings()
        
        if not settings.mcp_servers:
            return "No MCP servers configured"
        
        servers_info = []
        for name, server in settings.mcp_servers.items():
            status = "enabled" if server.enabled else "disabled"
            trust = "trusted" if server.trusted else "untrusted"
            servers_info.append(f"- {name}: {server.command} ({status}, {trust})")
        
        return f"MCP Servers:\\n" + "\\n".join(servers_info)
    
    async def _list_projects(self) -> str:
        """List projects."""
        settings = load_settings()
        
        if not settings.projects:
            return "No projects configured"
        
        projects_info = []
        for name, project in settings.projects.items():
            current = " (current)" if name == settings.current_project else ""
            projects_info.append(f"- {name}: {project.root_path}{current}")
        
        return f"Projects:\\n" + "\\n".join(projects_info)
    
    async def _detect_project(self, project_path: Optional[str]) -> str:
        """Detect project from path."""
        if not project_path:
            import os
            project_path = os.getcwd()
        
        project_info = detect_project_from_path(project_path)
        if project_info:
            return f"Project detected:\\n{json.dumps(project_info, indent=2)}"
        else:
            return f"No project detected at path: {project_path}"
    
    def _get_nested_value(self, obj: Dict[str, Any], path: str) -> Any:
        """Get nested value using dot notation."""
        keys = path.split(".")
        current = obj
        
        for key in keys:
            if isinstance(current, dict) and key in current:
                current = current[key]
            elif hasattr(current, key):
                current = getattr(current, key)
            else:
                return None
        
        return current
    
    def _set_nested_value(self, obj: Dict[str, Any], path: str, value: Any) -> bool:
        """Set nested value using dot notation."""
        keys = path.split(".")
        current = obj
        
        # Navigate to parent
        for key in keys[:-1]:
            if isinstance(current, dict) and key in current:
                current = current[key]
            elif hasattr(current, key):
                current = getattr(current, key)
            else:
                return False
        
        # Set final value
        final_key = keys[-1]
        if isinstance(current, dict):
            current[final_key] = value
            return True
        elif hasattr(current, final_key):
            setattr(current, final_key, value)
            return True
        
        return False