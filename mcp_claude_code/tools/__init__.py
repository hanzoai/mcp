"""Tools package for MCP Claude Code.

This package contains all the tools for the MCP Claude Code server.
It provides a unified interface for registering all tools with an MCP server.
"""

from mcp.server.fastmcp import FastMCP

from mcp_claude_code.context import DocumentContext
from mcp_claude_code.enhanced_commands import EnhancedCommandExecutor
from mcp_claude_code.executors import ProjectAnalyzer
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.project import ProjectManager
from mcp_claude_code.tools.filesystem.file_operations import FileOperations
from mcp_claude_code.tools.filesystem.navigation import FilesystemNavigation
from mcp_claude_code.tools.project.analysis import ProjectAnalysis
from mcp_claude_code.tools.shell.command_execution import CommandExecution


def register_all_tools(mcp_server: FastMCP,
                      document_context: DocumentContext,
                      permission_manager: PermissionManager,
                      command_executor: EnhancedCommandExecutor,
                      project_manager: ProjectManager,
                      project_analyzer: ProjectAnalyzer) -> None:
    """Register all Claude Code tools with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        command_executor: Enhanced command executor for running shell commands
        project_manager: Project manager for tracking projects
        project_analyzer: Project analyzer for analyzing project structure and dependencies
    """
    # Initialize and register file operations tools
    file_ops = FileOperations(document_context, permission_manager)
    file_ops.register_tools(mcp_server)
    
    # Initialize and register filesystem navigation tools
    fs_nav = FilesystemNavigation(document_context, permission_manager)
    fs_nav.register_tools(mcp_server)
    
    # Initialize and register command execution tools
    cmd_exec = CommandExecution(command_executor, script_executor, permission_manager)
    cmd_exec.register_tools(mcp_server)
    
    # Initialize and register project analysis tools
    proj_analysis = ProjectAnalysis(project_manager, project_analyzer, permission_manager)
    proj_analysis.register_tools(mcp_server)
