"""Shell tools package for Hanzo MCP.

This package provides tools for executing shell commands and scripts.
"""

import shutil

from fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.shell.bash_session_executor import BashSessionExecutor
from hanzo_mcp.tools.shell.command_executor import CommandExecutor

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
    # Detect tmux availability and choose appropriate implementation
    if shutil.which("tmux") is not None:
        # Use tmux-based implementation for interactive sessions
        from hanzo_mcp.tools.shell.run_command import RunCommandTool

        command_executor = BashSessionExecutor(permission_manager)
        return [
            RunCommandTool(permission_manager, command_executor),
        ]
    else:
        # Use Windows-compatible implementation
        from hanzo_mcp.tools.shell.run_command_windows import RunCommandTool

        command_executor = CommandExecutor(permission_manager)
        return [
            RunCommandTool(permission_manager, command_executor),
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
