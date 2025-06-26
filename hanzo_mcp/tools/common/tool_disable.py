"""Disable tools dynamically."""

from typing import Annotated, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.tool_enable import ToolEnableTool


ToolName = Annotated[
    str,
    Field(
        description="Name of the tool to disable (e.g., 'grep', 'vector_search')",
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


class ToolDisableParams(TypedDict, total=False):
    """Parameters for tool disable."""

    tool: str
    persist: bool


@final
class ToolDisableTool(BaseTool):
    """Tool for disabling other tools dynamically."""

    def __init__(self):
        """Initialize the tool disable tool."""
        # Ensure states are loaded
        if not ToolEnableTool._initialized:
            ToolEnableTool._load_states()
            ToolEnableTool._initialized = True

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "tool_disable"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Disable tools to prevent their use.

This allows you to temporarily or permanently disable tools.
Useful for testing or when a tool is misbehaving.
Changes are persisted by default.

Critical tools (tool_enable, tool_disable, tool_list) cannot be disabled.

Examples:
- tool_disable --tool vector_search
- tool_disable --tool uvx_background
- tool_disable --tool grep --no-persist

Use 'tool_list' to see all available tools and their status.
Use 'tool_enable' to re-enable disabled tools.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ToolDisableParams],
    ) -> str:
        """Disable a tool.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of disabling the tool
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        tool_name = params.get("tool")
        if not tool_name:
            return "Error: tool name is required"

        persist = params.get("persist", True)

        # Prevent disabling critical tools
        critical_tools = {"tool_enable", "tool_disable", "tool_list", "stats"}
        if tool_name in critical_tools:
            return f"Error: Cannot disable critical tool '{tool_name}'. These tools are required for system management."

        # Check current state
        was_enabled = ToolEnableTool.is_tool_enabled(tool_name)
        
        if not was_enabled:
            return f"Tool '{tool_name}' is already disabled."

        # Disable the tool
        ToolEnableTool._tool_states[tool_name] = False
        
        # Persist if requested
        if persist:
            ToolEnableTool._save_states()
            await tool_ctx.info(f"Disabled tool '{tool_name}' (persisted)")
        else:
            await tool_ctx.info(f"Disabled tool '{tool_name}' (temporary)")

        output = [
            f"Successfully disabled tool '{tool_name}'",
            "",
            "The tool is now unavailable for use.",
            f"Use 'tool_enable --tool {tool_name}' to re-enable it.",
        ]
        
        if not persist:
            output.append("\nNote: This change is temporary and will be lost on restart.")
        
        # Warn about commonly used tools
        common_tools = {"grep", "read", "write", "bash", "edit"}
        if tool_name in common_tools:
            output.append(f"\n⚠️  Warning: '{tool_name}' is a commonly used tool. Disabling it may affect normal operations.")
        
        # Count disabled tools
        disabled_count = sum(1 for enabled in ToolEnableTool._tool_states.values() if not enabled)
        output.append(f"\nTotal disabled tools: {disabled_count}")
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
