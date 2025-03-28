"""Registry for MCP servers.

This module provides functionality to discover and manage MCP servers from a central registry.
"""

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Any, final
import httpx

from hanzo_mcp.external.config_manager import MCPServerConfig

logger = logging.getLogger(__name__)


@final
class MCPServerRegistry:
    """Registry for known MCP servers."""
    
    DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/hanzoai/mcp-registry/main/registry.json"
    CACHE_PATH = os.path.expanduser("~/.config/hanzo/registry_cache.json")
    
    def __init__(self, registry_url: Optional[str] = None):
        """Initialize the MCP server registry.
        
        Args:
            registry_url: Optional URL to the registry JSON file
        """
        self.registry_url = registry_url or self.DEFAULT_REGISTRY_URL
        self.servers_cache = {}
        self._load_cache()
    
    def _load_cache(self) -> None:
        """Load registry cache from disk."""
        cache_path = Path(self.CACHE_PATH)
        if cache_path.exists():
            try:
                with open(cache_path, "r") as f:
                    self.servers_cache = json.load(f)
                logger.info(f"Loaded registry cache from {cache_path}")
            except Exception as e:
                logger.error(f"Failed to load registry cache: {str(e)}")
                self.servers_cache = {"servers": {}}
        else:
            logger.info("No registry cache found")
            self.servers_cache = {"servers": {}}
    
    def _save_cache(self) -> None:
        """Save registry cache to disk."""
        cache_path = Path(self.CACHE_PATH)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        
        try:
            with open(cache_path, "w") as f:
                json.dump(self.servers_cache, f, indent=2)
            logger.info(f"Saved registry cache to {cache_path}")
        except Exception as e:
            logger.error(f"Failed to save registry cache: {str(e)}")
    
    async def fetch_registry(self) -> Dict:
        """Fetch the registry from the remote source.
        
        Returns:
            Dictionary with server registry data
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(self.registry_url, timeout=10.0)
                response.raise_for_status()
                self.servers_cache = response.json()
                self._save_cache()
                logger.info(f"Successfully fetched registry from {self.registry_url}")
                return self.servers_cache
        except Exception as e:
            logger.error(f"Failed to fetch registry: {str(e)}")
            return {"error": str(e), "servers": {}}
    
    def get_servers(self) -> Dict:
        """Get all known servers from the registry.
        
        Returns:
            Dictionary of server details
        """
        return self.servers_cache.get("servers", {})
    
    def search_servers(self, query: str) -> Dict:
        """Search for servers in the registry.
        
        Args:
            query: Search query string
            
        Returns:
            Dictionary of matching servers
        """
        if not query:
            return self.get_servers()
            
        results = {}
        servers = self.get_servers()
        
        query = query.lower()
        for server_id, info in servers.items():
            if (query in server_id.lower() or 
                query in info.get("name", "").lower() or 
                query in info.get("description", "").lower()):
                results[server_id] = info
                
        return results
    
    async def install_server(self, server_id: str, config_manager: MCPServerConfig) -> bool:
        """Install a server from the registry.
        
        Args:
            server_id: ID of the server to install
            config_manager: Configuration manager to save server config
            
        Returns:
            True if server was installed successfully, False otherwise
        """
        servers = self.get_servers()
        if server_id not in servers:
            logger.error(f"Server {server_id} not found in registry")
            return False
            
        server_info = servers[server_id]
        
        # Set up the configuration
        config_manager.set_server_config(server_id, {
            "command": server_info["command"],
            "args": server_info.get("args", []),
            "enabled": True,
            "description": server_info.get("description", "")
        })
        
        logger.info(f"Installed server {server_id} from registry")
        return config_manager.save_config()
