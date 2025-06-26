"""Tool palette loader for dynamic tool configuration."""

import os
from typing import Dict, List, Optional, Set

from hanzo_mcp.tools.common.palette import PaletteRegistry, register_default_palettes


class PaletteLoader:
    """Loads and manages tool palettes for dynamic configuration."""
    
    @staticmethod
    def initialize_palettes() -> None:
        """Initialize the palette system with defaults."""
        register_default_palettes()
        
        # Check for environment variable to set default palette
        default_palette = os.environ.get("HANZO_MCP_PALETTE", "python")
        if PaletteRegistry.get(default_palette):
            PaletteRegistry.set_active(default_palette)
    
    @staticmethod
    def get_enabled_tools_from_palette(
        base_enabled_tools: Optional[Dict[str, bool]] = None,
        force_palette: Optional[str] = None
    ) -> Dict[str, bool]:
        """Get enabled tools configuration from active palette.
        
        Args:
            base_enabled_tools: Base configuration to merge with
            force_palette: Force a specific palette (overrides active)
            
        Returns:
            Dictionary of tool enable states
        """
        # Initialize if needed
        if not PaletteRegistry.list():
            PaletteLoader.initialize_palettes()
        
        # Get palette to use
        if force_palette:
            PaletteRegistry.set_active(force_palette)
        
        palette = PaletteRegistry.get_active()
        if not palette:
            # No active palette, return base config
            return base_enabled_tools or {}
        
        # Start with base configuration
        result = base_enabled_tools.copy() if base_enabled_tools else {}
        
        # Get all possible tools (this is a superset for safety)
        all_possible_tools = {
            # Filesystem tools
            "read", "write", "edit", "multi_edit", "grep", "tree", "find",
            "symbols", "git_search", "content_replace", "batch_search",
            "find_files", "unified_search", "watch",
            # Shell tools
            "bash", "npx", "uvx", "process", "open",
            # Database tools
            "sql", "graph",
            # Config tools
            "config", "palette",
            # LLM tools
            "llm", "agent", "thinking",
            # MCP tools
            "mcp",
            # Todo tools
            "todo",
            # Jupyter tools
            "jupyter",
            # Editor tools
            "vim",
            # Stats/system tools
            "stats", "tool_enable", "tool_disable", "tool_list",
        }
        
        # Disable all tools first (clean slate for palette)
        for tool in all_possible_tools:
            result[tool] = False
        
        # Enable tools from palette
        for tool in palette.tools:
            result[tool] = True
        
        # Always enable palette tool itself (meta)
        result["palette"] = True
        
        return result
    
    @staticmethod
    def get_environment_from_palette() -> Dict[str, str]:
        """Get environment variables from active palette.
        
        Returns:
            Dictionary of environment variables
        """
        palette = PaletteRegistry.get_active()
        if palette and palette.environment:
            return palette.environment.copy()
        return {}
    
    @staticmethod
    def apply_palette_environment() -> None:
        """Apply environment variables from active palette to process."""
        env_vars = PaletteLoader.get_environment_from_palette()
        for key, value in env_vars.items():
            os.environ[key] = value