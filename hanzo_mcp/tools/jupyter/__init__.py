"""Jupyter notebook tools package for Hanzo MCP.

This package provides tools for working with Jupyter notebooks (.ipynb files),
including reading and editing notebook cells.
"""

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.jupyter.edit_notebook import EditNotebookTool
from hanzo_mcp.tools.jupyter.read_notebook import ReadNotebookTool

# Export all tool classes
__all__ = [
    "ReadNotebookTool",
    "EditNotebookTool",
    "get_jupyter_tools",
    "register_jupyter_tools",
]

def get_read_only_jupyter_tools(
    document_context: DocumentContext, permission_manager: PermissionManager
) -> list[BaseTool]:
    """Create instances of read only Jupyter notebook tools.
    
    Args:
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        
    Returns:
        List of Jupyter notebook tool instances
    """
    return [
        ReadNotebookTool(document_context, permission_manager),
    ]


def get_jupyter_tools(
    document_context: DocumentContext, permission_manager: PermissionManager
) -> list[BaseTool]:
    """Create instances of all Jupyter notebook tools.
    
    Args:
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        
    Returns:
        List of Jupyter notebook tool instances
    """
    return [
        ReadNotebookTool(document_context, permission_manager),
        EditNotebookTool(document_context, permission_manager),
    ]


def register_jupyter_tools(
    mcp_server: FastMCP,
    document_context: DocumentContext,
    permission_manager: PermissionManager,
    disable_write_tools: bool = False,
) -> None:
    """Register all Jupyter notebook tools with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        disable_write_tools: Whether to disable write/edit tools (default: False)
    """
    if disable_write_tools:
        tools = get_read_only_jupyter_tools(document_context, permission_manager)
    else:
        tools = get_jupyter_tools(document_context, permission_manager)
    ToolRegistry.register_tools(mcp_server, tools)
