"""Todo tools package for Hanzo MCP.

This package provides tools for managing todo lists across different Claude Desktop sessions,
using in-memory storage to maintain separate task lists for each conversation.
"""

from fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.todo.todo_read import TodoReadTool
from hanzo_mcp.tools.todo.todo_write import TodoWriteTool

# Export all tool classes
__all__ = [
    "TodoReadTool",
    "TodoWriteTool",
    "get_todo_tools",
    "register_todo_tools",
]


def get_todo_tools() -> list[BaseTool]:
    """Create instances of all todo tools.

    Returns:
        List of todo tool instances
    """
    return [
        TodoReadTool(),
        TodoWriteTool(),
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
    # Define tool mapping
    tool_classes = {
        "todo_read": TodoReadTool,
        "todo_write": TodoWriteTool,
    }
    
    tools = []
    
    if enabled_tools:
        # Use individual tool configuration
        for tool_name, enabled in enabled_tools.items():
            if enabled and tool_name in tool_classes:
                tool_class = tool_classes[tool_name]
                tools.append(tool_class())
    else:
        # Use all tools (backward compatibility)
        tools = get_todo_tools()
    
    ToolRegistry.register_tools(mcp_server, tools)
    return tools
