"""Configuration manager for external MCP servers.

This module provides functionality to manage and persist configuration for external MCP servers.
"""

import json
import os
import logging
from pathlib import Path
from typing import Dict, List, Optional, Any, final

logger = logging.getLogger(__name__)

@final
class MCPServerConfig:
    """Configuration for Hanzo MCP external servers."""

    DEFAULT_CONFIG_DIR = "~/.config/hanzo"
    DEFAULT_CONFIG_FILE = "external-servers.json"

    def __init__(self, config_dir: Optional[str] = None):
        """Initialize the MCP server configuration.

        Args:
            config_dir: Optional custom configuration directory
        """
        # Initialize configuration directory
        self.config_dir = Path(os.path.expanduser(config_dir or self.DEFAULT_CONFIG_DIR))
        self.config_file = self.config_dir / self.DEFAULT_CONFIG_FILE
        self.servers_config: Dict[str, Dict[str, Any]] = {}
        
        # Create config directory if it doesn't exist
        self._ensure_config_dir()
        
        # Load configuration
        self._load_config()

    def _ensure_config_dir(self) -> None:
        """Ensure the configuration directory exists."""
        try:
            self.config_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"Configuration directory: {self.config_dir}")
        except Exception as e:
            logger.error(f"Failed to create configuration directory: {str(e)}")

    def _load_config(self) -> None:
        """Load configuration from file."""
        if not self.config_file.exists():
            logger.info(f"Configuration file does not exist, creating default: {self.config_file}")
            self._create_default_config()
            return

        try:
            with open(self.config_file, "r") as f:
                self.servers_config = json.load(f)
            logger.info(f"Loaded configuration from {self.config_file}")
        except Exception as e:
            logger.error(f"Failed to load configuration: {str(e)}")
            self._create_default_config()

    def _create_default_config(self) -> None:
        """Create default configuration file."""
        # Default configuration with auto-detection
        self.servers_config = {
            "auto_detect": True,
            "servers": {}
        }
        
        # Save default configuration
        self.save_config()

    def save_config(self) -> bool:
        """Save configuration to file.

        Returns:
            True if configuration was saved successfully, False otherwise
        """
        try:
            with open(self.config_file, "w") as f:
                json.dump(self.servers_config, f, indent=2)
            logger.info(f"Saved configuration to {self.config_file}")
            return True
        except Exception as e:
            logger.error(f"Failed to save configuration: {str(e)}")
            return False

    def get_server_config(self, server_name: str) -> Dict[str, Any]:
        """Get configuration for a specific server.

        Args:
            server_name: The name of the server

        Returns:
            Configuration for the server
        """
        return self.servers_config.get("servers", {}).get(server_name, {})

    def set_server_config(self, server_name: str, config: Dict[str, Any]) -> None:
        """Set configuration for a specific server.

        Args:
            server_name: The name of the server
            config: Configuration for the server
        """
        if "servers" not in self.servers_config:
            self.servers_config["servers"] = {}
        
        self.servers_config["servers"][server_name] = config

    def is_server_enabled(self, server_name: str) -> bool:
        """Check if a server is enabled.

        Args:
            server_name: The name of the server

        Returns:
            True if the server is enabled, False otherwise
        """
        server_config = self.get_server_config(server_name)
        return server_config.get("enabled", True)

    def enable_server(self, server_name: str) -> bool:
        """Enable a server.

        Args:
            server_name: The name of the server

        Returns:
            True if the server was enabled, False otherwise
        """
        server_config = self.get_server_config(server_name)
        if not server_config:
            server_config = {"enabled": True}
        else:
            server_config["enabled"] = True
        
        self.set_server_config(server_name, server_config)
        return self.save_config()

    def disable_server(self, server_name: str) -> bool:
        """Disable a server.

        Args:
            server_name: The name of the server

        Returns:
            True if the server was disabled, False otherwise
        """
        server_config = self.get_server_config(server_name)
        if not server_config:
            server_config = {"enabled": False}
        else:
            server_config["enabled"] = False
        
        self.set_server_config(server_name, server_config)
        return self.save_config()

    def get_auto_detect(self) -> bool:
        """Get auto-detect setting.

        Returns:
            True if auto-detect is enabled, False otherwise
        """
        return self.servers_config.get("auto_detect", True)

    def set_auto_detect(self, enabled: bool) -> bool:
        """Set auto-detect setting.

        Args:
            enabled: Whether to enable auto-detect

        Returns:
            True if the setting was saved successfully, False otherwise
        """
        self.servers_config["auto_detect"] = enabled
        return self.save_config()

    def get_all_servers(self) -> Dict[str, Dict[str, Any]]:
        """Get all server configurations.

        Returns:
            All server configurations
        """
        return self.servers_config.get("servers", {})
