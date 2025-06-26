"""Enable tools dynamically."""

import json
from typing import Annotated, TypedDict, Unpack, final, override
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context


ToolName = Annotated[
    str,
    Field(
        description="Name of the tool to enable (e.g., 'grep', 'vector_search')",
        min_length=1,
    ),
]

Persist = Annotated[
    bool,
    Field(
        description="Persist the change to config file",
        default=True,
    ),
]


class ToolEnableParams(TypedDict, total=False):
    """Parameters for tool enable."""

    tool: str
    persist: bool


@final
class ToolEnableTool(BaseTool):
    """Tool for enabling other tools dynamically."""
    
    # Class variable to track enabled/disabled tools
    _tool_states = {}
    _config_file = Path.home() / ".hanzo" / "mcp" / "tool_states.json"
    _initialized = False

    def __init__(self):
        """Initialize the tool enable tool."""
        if not ToolEnableTool._initialized:
            self._load_states()
            ToolEnableTool._initialized = True

    @classmethod
    def _load_states(cls):
        """Load tool states from config file."""
        if cls._config_file.exists():
            try:
                with open(cls._config_file, 'r') as f:
                    cls._tool_states = json.load(f)
            except Exception:
                cls._tool_states = {}
        else:
            # Default all tools to enabled
            cls._tool_states = {}

    @classmethod
    def _save_states(cls):
        """Save tool states to config file."""
        cls._config_file.parent.mkdir(parents=True, exist_ok=True)
        with open(cls._config_file, 'w') as f:
            json.dump(cls._tool_states, f, indent=2)

    @classmethod
    def is_tool_enabled(cls, tool_name: str) -> bool:
        """Check if a tool is enabled.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            True if enabled (default), False if explicitly disabled
        """
        # Load states if not initialized
        if not cls._initialized:
            cls._load_states()
            cls._initialized = True
        
        # Default to enabled if not in states
        return cls._tool_states.get(tool_name, True)

    @classmethod
    def get_all_states(cls) -> dict:
        """Get all tool states."""
        if not cls._initialized:
            cls._load_states()
            cls._initialized = True
        return cls._tool_states.copy()

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "tool_enable"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Enable tools that have been disabled.

This allows you to re-enable tools that were previously disabled.
Changes are persisted by default.

Examples:
- tool_enable --tool grep
- tool_enable --tool vector_search
- tool_enable --tool uvx_background --no-persist

Use 'tool_list' to see all available tools and their status.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ToolEnableParams],
    ) -> str:
        """Enable a tool.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of enabling the tool
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        tool_name = params.get("tool")
        if not tool_name:
            return "Error: tool name is required"

        persist = params.get("persist", True)

        # Check current state
        was_enabled = self.is_tool_enabled(tool_name)
        
        if was_enabled:
            return f"Tool '{tool_name}' is already enabled."

        # Enable the tool
        self._tool_states[tool_name] = True
        
        # Persist if requested
        if persist:
            self._save_states()
            await tool_ctx.info(f"Enabled tool '{tool_name}' (persisted)")
        else:
            await tool_ctx.info(f"Enabled tool '{tool_name}' (temporary)")

        output = [
            f"Successfully enabled tool '{tool_name}'",
            "",
            "The tool is now available for use.",
        ]
        
        if not persist:
            output.append("Note: This change is temporary and will be lost on restart.")
        
        # Count enabled/disabled tools
        disabled_count = sum(1 for enabled in self._tool_states.values() if not enabled)
        if disabled_count > 0:
            output.append(f"\nCurrently disabled tools: {disabled_count}")
            output.append("Use 'tool_list --disabled' to see them.")
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
