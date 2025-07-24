"""Todo tools package for Hanzo AI.

This package provides a unified todo management tool for organizing tasks
within Claude Desktop sessions.
"""

from mcp.server import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.todo.todo import TodoTool

# Export all tool classes
__all__ = [
    "TodoTool",
    "get_todo_tools",
    "register_todo_tools",
]


def get_todo_tools() -> list[BaseTool]:
    """Create instances of all todo tools.

    Returns:
        List of todo tool instances
    """
    return [
        TodoTool(),
    ]


def register_todo_tools(
    mcp_server: FastMCP,
    enabled_tools: dict[str, bool] | None = None,
) -> list[BaseTool]:
    """Register todo tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        enabled_tools: Dictionary of individual tool enable states (default: None)

    Returns:
        List of registered tools
    """
    # Define tool mapping - single unified todo tool
    tool_classes = {
        "todo": TodoTool,
    }

    tools = []

    if enabled_tools:
        # Use individual tool configuration
        # Support both old names and new name for backward compatibility
        if enabled_tools.get("todo", True) or enabled_tools.get("todo_read", True) or enabled_tools.get("todo_write", True):
            tools.append(TodoTool())
    else:
        # Use all tools (backward compatibility)
        tools = get_todo_tools()

    ToolRegistry.register_tools(mcp_server, tools)
    return tools
