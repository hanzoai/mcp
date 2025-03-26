"""Project analysis tools package for MCP Claude Code.

This package provides tools for analyzing project structure and dependencies.
"""

from mcp.server.fastmcp import FastMCP

from mcp_claude_code.tools.common.base import BaseTool, ToolRegistry
from mcp_claude_code.tools.common.context import DocumentContext
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.project.analysis import ProjectAnalyzer, ProjectManager
from mcp_claude_code.tools.project.project_analyze import ProjectAnalyzeTool
from mcp_claude_code.tools.shell.command_executor import CommandExecutor

# Export all tool classes
__all__ = [
    "ProjectAnalyzer",
    "ProjectManager",
    "ProjectAnalyzeTool",
    "get_project_tools",
    "register_project_tools",
]


def get_project_tools(
    document_context: DocumentContext,
    permission_manager: PermissionManager,
    command_executor: CommandExecutor,
) -> list[BaseTool]:
    """Create instances of all project tools.
    
    Args:
        permission_manager: Permission manager for access control
        document_context: Document context for tracking file contents
        command_executor: Command executor for running analysis scripts
        
    Returns:
        List of project tool instances
    """
    # Initialize project analyzer and manager
    project_analyzer = ProjectAnalyzer(command_executor)
    project_manager = ProjectManager(document_context, permission_manager, project_analyzer)
    
    return [
        ProjectAnalyzeTool(permission_manager, project_manager, project_analyzer),
    ]


def register_project_tools(
    mcp_server: FastMCP,
    permission_manager: PermissionManager,
    document_context: DocumentContext,
    command_executor: CommandExecutor,
) -> None:
    """Register all project tools with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
        permission_manager: Permission manager for access control
        document_context: Document context for tracking file contents
        command_executor: Command executor for running analysis scripts
    """
    tools = get_project_tools(document_context, permission_manager, command_executor)
    ToolRegistry.register_tools(mcp_server, tools)
