"""Tools package for MCP Claude Code.

This package contains all the tools for the MCP Claude Code server.
It provides a unified interface for registering all tools with an MCP server.

This includes a "think" tool implementation based on Anthropic's research showing
improved performance for complex tool-based interactions when Claude has a dedicated
space for structured thinking.
"""

from typing import Any

from mcp.server.fastmcp import FastMCP

from dev_mcp.tools.common.context import DocumentContext
from dev_mcp.tools.common.permissions import PermissionManager
from dev_mcp.tools.common.thinking import ThinkingTool
from dev_mcp.tools.filesystem.file_operations import FileOperations
from dev_mcp.tools.jupyter.notebook_operations import JupyterNotebookTools
from dev_mcp.tools.project.analysis import ProjectAnalysis, ProjectManager
from dev_mcp.tools.shell.command_executor import CommandExecutor


def register_all_tools(
    mcp_server: FastMCP,
    document_context: DocumentContext,
    permission_manager: PermissionManager,
    project_manager: ProjectManager,
    project_analyzer: Any,
) -> None:
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
    # Now includes all filesystem functionality (navigation + file operations)
    file_ops = FileOperations(document_context, permission_manager)
    file_ops.register_tools(mcp_server)

    # Initialize and register command execution tools
    cmd_exec = CommandExecutor(permission_manager)
    cmd_exec.register_tools(mcp_server)

    # Initialize and register project analysis tools
    proj_analysis = ProjectAnalysis(
        project_manager, project_analyzer, permission_manager
    )
    proj_analysis.register_tools(mcp_server)

    # Initialize and register Jupyter notebook tools
    jupyter_tools = JupyterNotebookTools(document_context, permission_manager)
    jupyter_tools.register_tools(mcp_server)

    # Initialize and register thinking tool
    thinking_tool = ThinkingTool()
    thinking_tool.register_tools(mcp_server)
