"""Authentication module for Hanzo MCP.

This module provides tools for authenticating with Hanzo API and services.
"""

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.auth.auth_tool import AuthTool
from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager


def register_auth_tools(
    mcp_server: FastMCP,
    document_context: DocumentContext,
    permission_manager: PermissionManager,
    enable_auth_tool: bool = True,
) -> None:
    """Register authentication tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        enable_auth_tool: Whether to enable the auth tool (default: True)
    """
    if enable_auth_tool:
        # Initialize and register auth tool
        auth_tool = AuthTool(
            document_context=document_context,
            permission_manager=permission_manager,
        )
        auth_tool.register(mcp_server)
