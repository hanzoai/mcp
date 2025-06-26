"""Shell tools package for Hanzo MCP.

This package provides tools for executing shell commands and scripts.
"""

from mcp.server import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.common.permissions import PermissionManager

# Import unified tools
from hanzo_mcp.tools.shell.bash_unified import bash_tool
from hanzo_mcp.tools.shell.npx_unified import npx_tool
from hanzo_mcp.tools.shell.uvx_unified import uvx_tool
from hanzo_mcp.tools.shell.process_unified import process_tool
from hanzo_mcp.tools.shell.open import open_tool

# Export all tool classes
__all__ = [
    "get_shell_tools",
    "register_shell_tools",
]


def get_shell_tools(
    permission_manager: PermissionManager,
) -> list[BaseTool]:
    """Create instances of all shell tools.

    Args:
        permission_manager: Permission manager for access control

    Returns:
        List of shell tool instances
    """
    # Set permission manager for tools that need it
    bash_tool.permission_manager = permission_manager
    npx_tool.permission_manager = permission_manager
    uvx_tool.permission_manager = permission_manager
    
    return [
        bash_tool,
        npx_tool,
        uvx_tool,
        process_tool,
        open_tool,
    ]


def register_shell_tools(
    mcp_server: FastMCP,
    permission_manager: PermissionManager,
) -> list[BaseTool]:
    """Register all shell tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        permission_manager: Permission manager for access control

    Returns:
        List of registered tools
    """
    tools = get_shell_tools(permission_manager)
    ToolRegistry.register_tools(mcp_server, tools)
    return tools