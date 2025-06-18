"""Settings management for Hanzo MCP.

Handles loading and saving configuration from multiple sources:
1. Default settings
2. Global config file (~/.config/hanzo/mcp-settings.json)
3. Project-specific config file
4. Environment variables
5. CLI arguments (highest priority)
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from dataclasses import dataclass, asdict, field

from .tool_config import TOOL_REGISTRY, ToolCategory


@dataclass
class MCPServerConfig:
    """Configuration for an external MCP server."""
    name: str
    command: str
    args: List[str] = field(default_factory=list)
    enabled: bool = True
    trusted: bool = False  # Whether this server is trusted
    description: str = ""
    capabilities: List[str] = field(default_factory=list)  # tools, prompts, resources
    
    
@dataclass
class VectorStoreConfig:
    """Configuration for the vector store."""
    enabled: bool = False
    provider: str = "infinity"  # infinity, chroma, etc.
    data_path: Optional[str] = None  # Will default to ~/.config/hanzo/vector-store
    embedding_model: str = "text-embedding-3-small"
    chunk_size: int = 1000
    chunk_overlap: int = 200


@dataclass  
class ProjectConfig:
    """Configuration specific to a project."""
    name: str
    root_path: str
    rules: List[str] = field(default_factory=list)
    workflows: Dict[str, Any] = field(default_factory=dict)
    tasks: List[Dict[str, Any]] = field(default_factory=list)
    enabled_tools: Dict[str, bool] = field(default_factory=dict)
    disabled_tools: List[str] = field(default_factory=list)
    mcp_servers: List[str] = field(default_factory=list)  # Names of enabled MCP servers for this project


@dataclass
class AgentConfig:
    """Configuration for agent tools."""
    enabled: bool = False
    model: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    max_tokens: Optional[int] = None
    max_iterations: int = 10
    max_tool_uses: int = 30


@dataclass 
class ServerConfig:
    """Configuration for the MCP server."""
    name: str = "hanzo-mcp"
    host: str = "127.0.0.1"
    port: int = 3000
    transport: str = "stdio"  # stdio or sse
    log_level: str = "INFO"
    command_timeout: float = 120.0


@dataclass
class HanzoMCPSettings:
    """Complete configuration for Hanzo MCP."""
    # Server settings
    server: ServerConfig = field(default_factory=ServerConfig)
    
    # Paths and permissions
    allowed_paths: List[str] = field(default_factory=list)
    project_paths: List[str] = field(default_factory=list)
    project_dir: Optional[str] = None
    
    # Tool configuration
    enabled_tools: Dict[str, bool] = field(default_factory=dict)
    disabled_tools: List[str] = field(default_factory=list)
    
    # Agent configuration
    agent: AgentConfig = field(default_factory=AgentConfig)
    
    # Vector store configuration
    vector_store: VectorStoreConfig = field(default_factory=VectorStoreConfig)
    
    # MCP Hub configuration
    mcp_servers: Dict[str, MCPServerConfig] = field(default_factory=dict)
    hub_enabled: bool = False
    trusted_servers: List[str] = field(default_factory=list)  # Whitelist of trusted server names
    
    # Project-specific configurations
    projects: Dict[str, ProjectConfig] = field(default_factory=dict)
    current_project: Optional[str] = None
    
    def __post_init__(self):
        """Initialize default tool states if not specified."""
        if not self.enabled_tools:
            self.enabled_tools = {name: config.enabled for name, config in TOOL_REGISTRY.items()}
        
        # Apply disabled_tools list to enabled_tools dict
        for tool_name in self.disabled_tools:
            if tool_name in TOOL_REGISTRY:
                self.enabled_tools[tool_name] = False
    
    def is_tool_enabled(self, tool_name: str) -> bool:
        """Check if a specific tool is enabled."""
        # Check disabled_tools list first (highest priority)
        if tool_name in self.disabled_tools:
            return False
        return self.enabled_tools.get(tool_name, TOOL_REGISTRY.get(tool_name, type('obj', (object,), {'enabled': False})).enabled)
    
    def enable_tool(self, tool_name: str) -> bool:
        """Enable a specific tool."""
        if tool_name in TOOL_REGISTRY:
            self.enabled_tools[tool_name] = True
            # Remove from disabled list if present
            if tool_name in self.disabled_tools:
                self.disabled_tools.remove(tool_name)
            return True
        return False
    
    def disable_tool(self, tool_name: str) -> bool:
        """Disable a specific tool."""
        if tool_name in TOOL_REGISTRY:
            self.enabled_tools[tool_name] = False
            # Add to disabled list if not present
            if tool_name not in self.disabled_tools:
                self.disabled_tools.append(tool_name)
            return True
        return False
    
    def get_enabled_tools(self) -> List[str]:
        """Get list of enabled tool names."""
        return [name for name in TOOL_REGISTRY.keys() if self.is_tool_enabled(name)]
    
    def get_disabled_tools(self) -> List[str]:
        """Get list of disabled tool names."""
        return [name for name in TOOL_REGISTRY.keys() if not self.is_tool_enabled(name)]
    
    # MCP Server Management
    def add_mcp_server(self, server_config: MCPServerConfig) -> bool:
        """Add a new MCP server configuration."""
        if server_config.name in self.mcp_servers:
            return False  # Server already exists
        self.mcp_servers[server_config.name] = server_config
        return True
    
    def remove_mcp_server(self, server_name: str) -> bool:
        """Remove an MCP server configuration."""
        if server_name in self.mcp_servers:
            del self.mcp_servers[server_name]
            # Remove from trusted list if present
            if server_name in self.trusted_servers:
                self.trusted_servers.remove(server_name)
            return True
        return False
    
    def enable_mcp_server(self, server_name: str) -> bool:
        """Enable an MCP server."""
        if server_name in self.mcp_servers:
            self.mcp_servers[server_name].enabled = True
            return True
        return False
    
    def disable_mcp_server(self, server_name: str) -> bool:
        """Disable an MCP server."""
        if server_name in self.mcp_servers:
            self.mcp_servers[server_name].enabled = False
            return True
        return False
    
    def trust_mcp_server(self, server_name: str) -> bool:
        """Add server to trusted list."""
        if server_name in self.mcp_servers:
            if server_name not in self.trusted_servers:
                self.trusted_servers.append(server_name)
            self.mcp_servers[server_name].trusted = True
            return True
        return False
    
    def get_enabled_mcp_servers(self) -> List[MCPServerConfig]:
        """Get list of enabled MCP servers."""
        return [server for server in self.mcp_servers.values() if server.enabled]
    
    def get_trusted_mcp_servers(self) -> List[MCPServerConfig]:
        """Get list of trusted MCP servers."""
        return [server for server in self.mcp_servers.values() if server.trusted]
    
    # Project Management
    def add_project(self, project_config: ProjectConfig) -> bool:
        """Add a project configuration."""
        if project_config.name in self.projects:
            return False  # Project already exists
        self.projects[project_config.name] = project_config
        return True
    
    def remove_project(self, project_name: str) -> bool:
        """Remove a project configuration."""
        if project_name in self.projects:
            del self.projects[project_name]
            if self.current_project == project_name:
                self.current_project = None
            return True
        return False
    
    def set_current_project(self, project_name: str) -> bool:
        """Set the current active project."""
        if project_name in self.projects:
            self.current_project = project_name
            return True
        return False
    
    def get_current_project(self) -> Optional[ProjectConfig]:
        """Get the current project configuration."""
        if self.current_project:
            return self.projects.get(self.current_project)
        return None
    
    def get_project_tools(self, project_name: Optional[str] = None) -> Dict[str, bool]:
        """Get tool configuration for a specific project."""
        if not project_name:
            project_name = self.current_project
        
        if project_name and project_name in self.projects:
            project = self.projects[project_name]
            # Start with global tool settings
            tools = self.enabled_tools.copy()
            # Apply project-specific settings
            tools.update(project.enabled_tools)
            # Apply project-specific disabled tools
            for tool_name in project.disabled_tools:
                tools[tool_name] = False
            return tools
        
        return self.enabled_tools


def get_config_dir() -> Path:
    """Get the configuration directory for Hanzo MCP."""
    if os.name == "nt":  # Windows
        config_dir = Path(os.environ.get("APPDATA", "")) / "hanzo"
    else:  # Unix/macOS
        config_dir = Path.home() / ".config" / "hanzo"
    
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir


def get_global_config_path() -> Path:
    """Get the path to the global configuration file."""
    return get_config_dir() / "mcp-settings.json"


def get_project_config_path(project_dir: Optional[str] = None) -> Optional[Path]:
    """Get the path to the project-specific configuration file."""
    if project_dir:
        project_path = Path(project_dir)
        config_candidates = [
            project_path / ".hanzo" / "mcp-settings.json",
            project_path / "hanzo-mcp.json",
            project_path / ".hanzo-mcp.json",
        ]
        for config_path in config_candidates:
            if config_path.exists():
                return config_path
    return None


def ensure_project_hanzo_dir(project_dir: str) -> Path:
    """Ensure .hanzo directory exists in project and return its path."""
    project_path = Path(project_dir)
    hanzo_dir = project_path / ".hanzo"
    hanzo_dir.mkdir(exist_ok=True)
    
    # Create default structure
    (hanzo_dir / "db").mkdir(exist_ok=True)  # Vector database
    
    # Create default project config if it doesn't exist
    config_path = hanzo_dir / "mcp-settings.json"
    if not config_path.exists():
        default_project_config = {
            "name": project_path.name,
            "root_path": str(project_path),
            "rules": [
                "Follow project-specific coding standards",
                "Test all changes before committing",
                "Update documentation for new features"
            ],
            "workflows": {
                "development": {
                    "steps": ["edit", "test", "commit"],
                    "tools": ["read", "write", "edit", "run_command"]
                },
                "documentation": {
                    "steps": ["read", "analyze", "write"],
                    "tools": ["read", "write", "vector_search"]
                }
            },
            "tasks": [],
            "enabled_tools": {},
            "disabled_tools": [],
            "mcp_servers": []
        }
        
        with open(config_path, 'w') as f:
            json.dump(default_project_config, f, indent=2)
    
    return hanzo_dir


def detect_project_from_path(file_path: str) -> Optional[Dict[str, str]]:
    """Detect project information from a file path by looking for LLM.md."""
    path = Path(file_path).resolve()
    current_path = path.parent if path.is_file() else path
    
    while current_path != current_path.parent:  # Stop at filesystem root
        llm_md_path = current_path / "LLM.md"
        if llm_md_path.exists():
            return {
                "name": current_path.name,
                "root_path": str(current_path),
                "llm_md_path": str(llm_md_path),
                "hanzo_dir": str(ensure_project_hanzo_dir(str(current_path)))
            }
        current_path = current_path.parent
    
    return None


def load_settings(
    project_dir: Optional[str] = None,
    config_overrides: Optional[Dict[str, Any]] = None
) -> HanzoMCPSettings:
    """Load settings from all sources in priority order.
    
    Priority (highest to lowest):
    1. config_overrides (usually from CLI)
    2. Project-specific config file
    3. Global config file
    4. Defaults
    """
    # Start with defaults
    settings = HanzoMCPSettings()
    
    # Load global config
    global_config_path = get_global_config_path()
    if global_config_path.exists():
        try:
            with open(global_config_path) as f:
                global_config = json.load(f)
                settings = _merge_config(settings, global_config)
        except Exception as e:
            print(f"Warning: Failed to load global config: {e}")
    
    # Load project config
    project_config_path = get_project_config_path(project_dir)
    if project_config_path:
        try:
            with open(project_config_path) as f:
                project_config = json.load(f)
                settings = _merge_config(settings, project_config)
        except Exception as e:
            print(f"Warning: Failed to load project config: {e}")
    
    # Apply CLI overrides
    if config_overrides:
        settings = _merge_config(settings, config_overrides)
    
    return settings


def save_settings(settings: HanzoMCPSettings, global_config: bool = True) -> Path:
    """Save settings to configuration file.
    
    Args:
        settings: Settings to save
        global_config: If True, save to global config, otherwise save to project config
    
    Returns:
        Path where settings were saved
    """
    if global_config:
        config_path = get_global_config_path()
    else:
        # Save to current directory project config
        config_path = Path.cwd() / ".hanzo-mcp.json"
    
    config_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(config_path, 'w') as f:
        json.dump(asdict(settings), f, indent=2)
    
    return config_path


def _merge_config(base_settings: HanzoMCPSettings, config_dict: Dict[str, Any]) -> HanzoMCPSettings:
    """Merge configuration dictionary into settings object."""
    # Convert to dict, merge, then convert back
    base_dict = asdict(base_settings)
    
    def deep_merge(base: Dict[str, Any], update: Dict[str, Any]) -> Dict[str, Any]:
        """Deep merge two dictionaries."""
        for key, value in update.items():
            if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                base[key] = deep_merge(base[key], value)
            else:
                base[key] = value
        return base
    
    merged = deep_merge(base_dict, config_dict)
    
    # Reconstruct the settings object
    mcp_servers = {}
    for name, server_data in merged.get("mcp_servers", {}).items():
        mcp_servers[name] = MCPServerConfig(**server_data)
    
    projects = {}
    for name, project_data in merged.get("projects", {}).items():
        projects[name] = ProjectConfig(**project_data)
    
    return HanzoMCPSettings(
        server=ServerConfig(**merged.get("server", {})),
        allowed_paths=merged.get("allowed_paths", []),
        project_paths=merged.get("project_paths", []),
        project_dir=merged.get("project_dir"),
        enabled_tools=merged.get("enabled_tools", {}),
        disabled_tools=merged.get("disabled_tools", []),
        agent=AgentConfig(**merged.get("agent", {})),
        vector_store=VectorStoreConfig(**merged.get("vector_store", {})),
        mcp_servers=mcp_servers,
        hub_enabled=merged.get("hub_enabled", False),
        trusted_servers=merged.get("trusted_servers", []),
        projects=projects,
        current_project=merged.get("current_project"),
    )