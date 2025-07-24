"""Mode system for organizing development tools based on programmer personalities."""

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Set

from hanzo_mcp.tools.common.personality import (
    ToolPersonality,
    register_default_personalities,
    ensure_agent_enabled,
    personalities
)


@dataclass
class Mode(ToolPersonality):
    """Development mode combining tool preferences and environment settings."""
    # Inherits all fields from ToolPersonality
    # Adds mode-specific functionality
    
    @property
    def is_active(self) -> bool:
        """Check if this mode is currently active."""
        return ModeRegistry.get_active() == self


class ModeRegistry:
    """Registry for development modes."""
    
    _modes: Dict[str, Mode] = {}
    _active_mode: Optional[str] = None
    
    @classmethod
    def register(cls, mode: Mode) -> None:
        """Register a development mode."""
        # Ensure agent is enabled if API keys present
        mode = ensure_agent_enabled(mode)
        cls._modes[mode.name] = mode
    
    @classmethod
    def get(cls, name: str) -> Optional[Mode]:
        """Get a mode by name."""
        return cls._modes.get(name)
    
    @classmethod
    def list(cls) -> List[Mode]:
        """List all registered modes."""
        return list(cls._modes.values())
    
    @classmethod
    def set_active(cls, name: str) -> None:
        """Set the active mode."""
        if name not in cls._modes:
            raise ValueError(f"Mode '{name}' not found")
        cls._active_mode = name
        
        # Apply environment variables from the mode
        mode = cls._modes[name]
        if mode.environment:
            for key, value in mode.environment.items():
                os.environ[key] = value
    
    @classmethod
    def get_active(cls) -> Optional[Mode]:
        """Get the active mode."""
        if cls._active_mode:
            return cls._modes.get(cls._active_mode)
        return None
    
    @classmethod
    def get_active_tools(cls) -> Set[str]:
        """Get the set of tools from the active mode."""
        mode = cls.get_active()
        if mode:
            return set(mode.tools)
        return set()


def register_default_modes():
    """Register all default development modes."""
    # Convert personalities to modes
    for personality in personalities:
        mode = Mode(
            name=personality.name,
            programmer=personality.programmer,
            description=personality.description,
            tools=personality.tools,
            environment=personality.environment,
            philosophy=personality.philosophy,
        )
        ModeRegistry.register(mode)


def get_mode_from_env() -> Optional[str]:
    """Get mode name from environment variables."""
    # Check for HANZO_MODE, PERSONALITY, or MODE env vars
    return (
        os.environ.get("HANZO_MODE") or
        os.environ.get("PERSONALITY") or
        os.environ.get("MODE")
    )


def activate_mode_from_env():
    """Activate mode based on environment variables."""
    mode_name = get_mode_from_env()
    if mode_name:
        try:
            ModeRegistry.set_active(mode_name)
            return True
        except ValueError:
            # Mode not found, ignore
            pass
    return False


