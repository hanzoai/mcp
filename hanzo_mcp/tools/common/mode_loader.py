"""Tool mode loader for dynamic tool configuration."""

import os
from typing import Dict, List, Optional, Set

from hanzo_mcp.tools.common.mode import ModeRegistry, register_default_modes, activate_mode_from_env


class ModeLoader:
    """Loads and manages tool modes for dynamic configuration."""
    
    @staticmethod
    def initialize_modes() -> None:
        """Initialize the mode system with defaults."""
        # Initialize modes
        register_default_modes()
        
        # Check for mode from environment
        activate_mode_from_env()
        
        # If no mode set, use default
        if not ModeRegistry.get_active():
            default_mode = os.environ.get("HANZO_DEFAULT_MODE", "hanzo")
            if ModeRegistry.get(default_mode):
                ModeRegistry.set_active(default_mode)
    
    @staticmethod
    def get_enabled_tools_from_mode(
        base_enabled_tools: Optional[Dict[str, bool]] = None,
        force_mode: Optional[str] = None
    ) -> Dict[str, bool]:
        """Get enabled tools configuration from active mode.
        
        Args:
            base_enabled_tools: Base configuration to merge with
            force_mode: Force a specific mode (overrides active)
            
        Returns:
            Dictionary of tool enable states
        """
        # Initialize if needed
        if not ModeRegistry.list():
            ModeLoader.initialize_modes()
        
        # Get mode to use
        tools_list = None
        
        if force_mode:
            # Set and get mode
            if ModeRegistry.get(force_mode):
                ModeRegistry.set_active(force_mode)
                mode = ModeRegistry.get_active()
                tools_list = mode.tools if mode else None
        else:
            # Check active mode
            mode = ModeRegistry.get_active()
            if mode:
                tools_list = mode.tools
        
        if not tools_list:
            # No active mode, return base config
            return base_enabled_tools or {}
        
        # Start with base configuration
        result = base_enabled_tools.copy() if base_enabled_tools else {}
        
        # Get all possible tools from registry
        from hanzo_mcp.config.tool_config import TOOL_REGISTRY
        all_possible_tools = set(TOOL_REGISTRY.keys())
        
        # Disable all tools first (clean slate for mode)
        for tool in all_possible_tools:
            result[tool] = False
        
        # Enable tools from mode
        for tool in tools_list:
            result[tool] = True
        
        # Always enable mode tool (meta)
        result["mode"] = True
        
        return result
    
    @staticmethod
    def get_environment_from_mode() -> Dict[str, str]:
        """Get environment variables from active mode.
        
        Returns:
            Dictionary of environment variables
        """
        # Check mode
        mode = ModeRegistry.get_active()
        if mode and mode.environment:
            return mode.environment.copy()
        
        return {}
    
    @staticmethod
    def apply_environment_from_mode() -> None:
        """Apply environment variables from active mode."""
        env_vars = ModeLoader.get_environment_from_mode()
        for key, value in env_vars.items():
            os.environ[key] = value


