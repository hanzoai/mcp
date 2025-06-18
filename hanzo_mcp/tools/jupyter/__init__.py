"""Jupyter notebook tools package for Hanzo MCP.

This package provides tools for working with Jupyter notebooks (.ipynb files),
including reading and editing notebook cells.
"""

from fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.jupyter.notebook_edit import NoteBookEditTool
from hanzo_mcp.tools.jupyter.notebook_read import NotebookReadTool

# Export all tool classes
__all__ = [
    "NotebookReadTool",
    "NoteBookEditTool",
    "get_jupyter_tools",
    "register_jupyter_tools",
]


def get_read_only_jupyter_tools(
    permission_manager: PermissionManager,
) -> list[BaseTool]:
    """Create instances of read only Jupyter notebook tools.

    Args:
        permission_manager: Permission manager for access control

    Returns:
        List of Jupyter notebook tool instances
    """
    return [
        NotebookReadTool(permission_manager),
    ]


def get_jupyter_tools(permission_manager: PermissionManager) -> list[BaseTool]:
    """Create instances of all Jupyter notebook tools.

    Args:
        permission_manager: Permission manager for access control

    Returns:
        List of Jupyter notebook tool instances
    """
    return [
        NotebookReadTool(permission_manager),
        NoteBookEditTool(permission_manager),
    ]


def register_jupyter_tools(
    mcp_server: FastMCP,
    permission_manager: PermissionManager,
    enabled_tools: dict[str, bool] | None = None,
) -> list[BaseTool]:
    """Register Jupyter notebook tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        permission_manager: Permission manager for access control
        enabled_tools: Dictionary of individual tool enable states (default: None)

    Returns:
        List of registered tools
    """
    # Define tool mapping
    tool_classes = {
        "notebook_read": NotebookReadTool,
        "notebook_edit": NoteBookEditTool,
    }
    
    tools = []
    
    if enabled_tools:
        # Use individual tool configuration
        for tool_name, enabled in enabled_tools.items():
            if enabled and tool_name in tool_classes:
                tool_class = tool_classes[tool_name]
                tools.append(tool_class(permission_manager))
    else:
        # Use all tools (backward compatibility)
        tools = get_jupyter_tools(permission_manager)
    
    ToolRegistry.register_tools(mcp_server, tools)
    return tools
