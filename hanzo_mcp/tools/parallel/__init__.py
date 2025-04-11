"""Parallel tool execution module for Hanzo MCP.

This module provides tools for executing multiple tool calls in parallel,
enabling improved performance for batch operations.
"""

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.parallel.parallel_tool import ParallelTool


def register_parallel_tools(
    mcp_server: FastMCP,
    document_context: DocumentContext,
    permission_manager: PermissionManager,
    enable_parallel_tool: bool = True,
) -> None:
    """Register parallel execution tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        enable_parallel_tool: Whether to enable the parallel tool (default: True)
    """
    if enable_parallel_tool:
        # Initialize and register parallel tool
        parallel_tool = ParallelTool(
            document_context=document_context,
            permission_manager=permission_manager,
        )
        parallel_tool.register(mcp_server)
