"""Filesystem tools package for Hanzo MCP.

This package provides tools for interacting with the filesystem, including reading, writing,
and editing files, directory navigation, and content searching.
"""

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry
from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem.content_replace import ContentReplaceTool
from hanzo_mcp.tools.filesystem.directory_tree import DirectoryTreeTool
from hanzo_mcp.tools.filesystem.edit_file import EditFileTool
from hanzo_mcp.tools.filesystem.get_file_info import GetFileInfoTool
from hanzo_mcp.tools.filesystem.grep_ast_tool import GrepAstTool
from hanzo_mcp.tools.filesystem.read_files import ReadFilesTool
from hanzo_mcp.tools.filesystem.search_content import SearchContentTool
from hanzo_mcp.tools.filesystem.write_file import WriteFileTool

# Export all tool classes
__all__ = [
    "ReadFilesTool",
    "WriteFileTool",
    "EditFileTool",
    "DirectoryTreeTool",
    "GetFileInfoTool",
    "SearchContentTool",
    "ContentReplaceTool",
    "GrepAstTool",
    "get_filesystem_tools",
    "register_filesystem_tools",
]

def get_read_only_filesystem_tools(
            document_context: DocumentContext, permission_manager: PermissionManager,
            disable_search_tools: bool = False
) -> list[BaseTool]:
    """Create instances of read-only filesystem tools.
    
    Args:
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        disable_search_tools: Whether to disable search tools (default: False)

    Returns:
        List of read-only filesystem tool instances
    """
    tools = [
        ReadFilesTool(document_context, permission_manager),
        DirectoryTreeTool(document_context, permission_manager),
        GetFileInfoTool(document_context, permission_manager),
    ]
    
    if not disable_search_tools:
        tools.extend([
            SearchContentTool(document_context, permission_manager),
            GrepAstTool(document_context, permission_manager)
        ])
        
    return tools


def get_filesystem_tools(
    document_context: DocumentContext, permission_manager: PermissionManager,
    disable_search_tools: bool = False
) -> list[BaseTool]:
    """Create instances of all filesystem tools.
    
    Args:
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        disable_search_tools: Whether to disable search tools (default: False)
        
    Returns:
        List of filesystem tool instances
    """
    tools = [
        ReadFilesTool(document_context, permission_manager),
        WriteFileTool(document_context, permission_manager),
        EditFileTool(document_context, permission_manager),
        DirectoryTreeTool(document_context, permission_manager),
        GetFileInfoTool(document_context, permission_manager),
    ]
    
    if not disable_search_tools:
        tools.extend([
            SearchContentTool(document_context, permission_manager),
            ContentReplaceTool(document_context, permission_manager),
            GrepAstTool(document_context, permission_manager),
        ])
        
    return tools


def register_filesystem_tools(
    mcp_server: FastMCP,
    document_context: DocumentContext,
    permission_manager: PermissionManager,
    disable_write_tools: bool = False,
    disable_search_tools: bool = False,
) -> None:
    """Register all filesystem tools with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        disable_write_tools: Whether to disable write/edit tools (default: False)
        disable_search_tools: Whether to disable search tools (default: False)
    """
    if disable_write_tools:
        tools = get_read_only_filesystem_tools(document_context, permission_manager, disable_search_tools)
    else:
        tools = get_filesystem_tools(document_context, permission_manager, disable_search_tools)
    ToolRegistry.register_tools(mcp_server, tools)
