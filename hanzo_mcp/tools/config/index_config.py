"""Index configuration for per-project vs global indexing.

This module manages indexing configuration for different scopes.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional
from enum import Enum


class IndexScope(Enum):
    """Indexing scope options."""
    PROJECT = "project"  # Per-project indexing
    GLOBAL = "global"    # Global indexing
    AUTO = "auto"        # Auto-detect based on git root


class IndexConfig:
    """Manages indexing configuration."""
    
    def __init__(self, config_dir: Optional[Path] = None):
        """Initialize index configuration."""
        self.config_dir = config_dir or Path.home() / ".hanzo" / "mcp"
        self.config_file = self.config_dir / "index_config.json"
        self._config = self._load_config()
        
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from disk."""
        if self.config_file.exists():
            try:
                with open(self.config_file, "r") as f:
                    return json.load(f)
            except:
                pass
        
        # Default configuration
        return {
            "default_scope": IndexScope.AUTO.value,
            "project_configs": {},
            "global_index_paths": [],
            "index_settings": {
                "vector": {
                    "enabled": True,
                    "auto_index": True,
                    "include_git_history": True,
                },
                "symbols": {
                    "enabled": True,
                    "auto_index": False,
                },
                "sql": {
                    "enabled": True,
                    "per_project": True,
                },
                "graph": {
                    "enabled": True,
                    "per_project": True,
                }
            }
        }
    
    def save_config(self) -> None:
        """Save configuration to disk."""
        self.config_dir.mkdir(parents=True, exist_ok=True)
        with open(self.config_file, "w") as f:
            json.dump(self._config, f, indent=2)
    
    def get_scope(self, path: Optional[str] = None) -> IndexScope:
        """Get indexing scope for a path."""
        if not path:
            return IndexScope(self._config["default_scope"])
            
        # Check project-specific config
        project_root = self._find_project_root(path)
        if project_root:
            project_config = self._config["project_configs"].get(str(project_root))
            if project_config and "scope" in project_config:
                return IndexScope(project_config["scope"])
        
        # Use default
        scope = IndexScope(self._config["default_scope"])
        
        # Handle auto mode
        if scope == IndexScope.AUTO:
            if project_root:
                return IndexScope.PROJECT
            else:
                return IndexScope.GLOBAL
                
        return scope
    
    def set_scope(self, scope: IndexScope, path: Optional[str] = None) -> None:
        """Set indexing scope."""
        if path:
            # Set for specific project
            project_root = self._find_project_root(path)
            if project_root:
                if str(project_root) not in self._config["project_configs"]:
                    self._config["project_configs"][str(project_root)] = {}
                self._config["project_configs"][str(project_root)]["scope"] = scope.value
        else:
            # Set global default
            self._config["default_scope"] = scope.value
            
        self.save_config()
    
    def get_index_path(self, tool: str, path: Optional[str] = None) -> Path:
        """Get index path for a tool and location."""
        scope = self.get_scope(path)
        
        if scope == IndexScope.PROJECT and path:
            project_root = self._find_project_root(path)
            if project_root:
                return Path(project_root) / ".hanzo" / "index" / tool
        
        # Global index
        return self.config_dir / "index" / tool
    
    def is_indexing_enabled(self, tool: str) -> bool:
        """Check if indexing is enabled for a tool."""
        return self._config["index_settings"].get(tool, {}).get("enabled", True)
    
    def set_indexing_enabled(self, tool: str, enabled: bool) -> None:
        """Enable/disable indexing for a tool."""
        if tool not in self._config["index_settings"]:
            self._config["index_settings"][tool] = {}
        self._config["index_settings"][tool]["enabled"] = enabled
        self.save_config()
    
    def toggle_scope(self, path: Optional[str] = None) -> IndexScope:
        """Toggle between project and global scope."""
        current = self.get_scope(path)
        
        if current == IndexScope.PROJECT:
            new_scope = IndexScope.GLOBAL
        elif current == IndexScope.GLOBAL:
            new_scope = IndexScope.PROJECT
        else:  # AUTO
            # Determine what auto resolves to and toggle
            if path and self._find_project_root(path):
                new_scope = IndexScope.GLOBAL
            else:
                new_scope = IndexScope.PROJECT
        
        self.set_scope(new_scope, path)
        return new_scope
    
    def _find_project_root(self, path: str) -> Optional[Path]:
        """Find project root (git root or similar)."""
        current = Path(path).resolve()
        
        # Walk up looking for markers
        markers = [".git", ".hg", "pyproject.toml", "package.json", "Cargo.toml"]
        
        while current != current.parent:
            for marker in markers:
                if (current / marker).exists():
                    return current
            current = current.parent
            
        return None
    
    def get_status(self) -> Dict[str, Any]:
        """Get current configuration status."""
        return {
            "default_scope": self._config["default_scope"],
            "project_count": len(self._config["project_configs"]),
            "tools": {
                tool: {
                    "enabled": settings.get("enabled", True),
                    "per_project": settings.get("per_project", True),
                }
                for tool, settings in self._config["index_settings"].items()
            }
        }