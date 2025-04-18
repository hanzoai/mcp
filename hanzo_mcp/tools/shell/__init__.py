"""Shell tools package for Hanzo MCP.

This package provides tools for executing shell commands and scripts.
"""

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.shell.command_executor import CommandExecutor
from hanzo_mcp.tools.shell.run_command import RunCommandTool
from hanzo_mcp.tools.shell.run_script import RunScriptTool
from hanzo_mcp.tools.shell.script_tool import ScriptTool

# Export all tool classes
__all__ = [
    "RunCommandTool",
    "RunScriptTool",
    "ScriptTool",
    "CommandExecutor",
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
    # Initialize the command executor
    command_executor = CommandExecutor(permission_manager)
    
    return [
        RunCommandTool(permission_manager, command_executor),
        RunScriptTool(permission_manager, command_executor),
        ScriptTool(permission_manager, command_executor),
    ]


def register_shell_tools(
    mcp_server: FastMCP,
    permission_manager: PermissionManager,
) -> None:
    """Register all shell tools with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
        permission_manager: Permission manager for access control
    """
    tools = get_shell_tools(permission_manager)
    ToolRegistry.register_tools(mcp_server, tools)
