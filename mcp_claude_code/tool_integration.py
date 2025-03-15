"""MCP server integration for enhanced command execution tools.

This module is a legacy compatibility layer for supporting the old tool registration
approach. New code should use the tools package directly.
"""

from mcp.server.fastmcp import Context, FastMCP

from mcp_claude_code.enhanced_commands import CommandResult, EnhancedCommandExecutor
from mcp_claude_code.tools.shell.command_execution import CommandExecution


def register_command_tools(mcp_server: FastMCP, command_executor: EnhancedCommandExecutor):
    """Register command execution tools with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
        command_executor: The enhanced command executor instance
    """
    # Create a command execution instance
    cmd_exec = CommandExecution(
        command_executor=command_executor,
        script_executor=None,  # Not needed for backward compatibility
        permission_manager=command_executor.permission_manager
    )
    
    # Register tools
    cmd_exec.register_tools(mcp_server)
