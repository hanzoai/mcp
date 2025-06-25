"""Filesystem tools package for Hanzo MCP.

This package provides tools for interacting with the filesystem, including reading, writing,
and editing files, directory navigation, and content searching.
"""

from fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem.content_replace import ContentReplaceTool
from hanzo_mcp.tools.filesystem.directory_tree import DirectoryTreeTool
from hanzo_mcp.tools.filesystem.edit import Edit
from hanzo_mcp.tools.filesystem.grep import Grep
from hanzo_mcp.tools.filesystem.grep_ast_tool import GrepAstTool
from hanzo_mcp.tools.filesystem.multi_edit import MultiEdit
from hanzo_mcp.tools.filesystem.read import ReadTool
from hanzo_mcp.tools.filesystem.write import Write
from hanzo_mcp.tools.filesystem.unified_search import UnifiedSearchTool

# Export all tool classes
__all__ = [
    "ReadTool",
    "Write",
    "Edit",
    "MultiEdit",
    "DirectoryTreeTool",
    "Grep",
    "ContentReplaceTool",
    "GrepAstTool",
    "UnifiedSearchTool",
    "get_filesystem_tools",
    "register_filesystem_tools",
]


def get_read_only_filesystem_tools(
    permission_manager: PermissionManager,
) -> list[BaseTool]:
    """Create instances of read-only filesystem tools.

    Args:
        permission_manager: Permission manager for access control

    Returns:
        List of read-only filesystem tool instances
    """
    return [
        ReadTool(permission_manager),
        DirectoryTreeTool(permission_manager),
        Grep(permission_manager),
        GrepAstTool(permission_manager),
    ]


def get_filesystem_tools(permission_manager: PermissionManager) -> list[BaseTool]:
    """Create instances of all filesystem tools.

    Args:
        permission_manager: Permission manager for access control

    Returns:
        List of filesystem tool instances
    """
    return [
        ReadTool(permission_manager),
        Write(permission_manager),
        Edit(permission_manager),
        MultiEdit(permission_manager),
        DirectoryTreeTool(permission_manager),
        Grep(permission_manager),
        ContentReplaceTool(permission_manager),
        GrepAstTool(permission_manager),
    ]


def register_filesystem_tools(
    mcp_server: FastMCP,
    permission_manager: PermissionManager,
    disable_write_tools: bool = False,
    disable_search_tools: bool = False,
    enabled_tools: dict[str, bool] | None = None,
    project_manager=None,
) -> list[BaseTool]:
    """Register filesystem tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        permission_manager: Permission manager for access control
        disable_write_tools: Whether to disable write tools (default: False)
        disable_search_tools: Whether to disable search tools (default: False)
        enabled_tools: Dictionary of individual tool enable states (default: None)
        project_manager: Optional project manager for unified search (default: None)

    Returns:
        List of registered tools
    """
    # Define tool mapping
    tool_classes = {
        "read": ReadTool,
        "write": Write,
        "edit": Edit,
        "multi_edit": MultiEdit,
        "directory_tree": DirectoryTreeTool,
        "grep": Grep,
        "grep_ast": GrepAstTool,
        "content_replace": ContentReplaceTool,
        "unified_search": UnifiedSearchTool,
    }
    
    tools = []
    
    if enabled_tools:
        # Use individual tool configuration
        for tool_name, enabled in enabled_tools.items():
            if enabled and tool_name in tool_classes:
                tool_class = tool_classes[tool_name]
                if tool_name == "unified_search":
                    # Unified search requires project_manager
                    tools.append(tool_class(permission_manager, project_manager))
                else:
                    tools.append(tool_class(permission_manager))
    else:
        # Use category-level configuration (backward compatibility)
        if disable_write_tools and disable_search_tools:
            # Only read and directory tools
            tools = [
                ReadTool(permission_manager),
                DirectoryTreeTool(permission_manager),
            ]
        elif disable_write_tools:
            # Read-only tools including search
            tools = get_read_only_filesystem_tools(permission_manager)
        elif disable_search_tools:
            # Write tools but no search
            tools = [
                ReadTool(permission_manager),
                Write(permission_manager),
                Edit(permission_manager),
                MultiEdit(permission_manager),
                DirectoryTreeTool(permission_manager),
                ContentReplaceTool(permission_manager),
            ]
        else:
            # All tools
            tools = get_filesystem_tools(permission_manager)
    
    ToolRegistry.register_tools(mcp_server, tools)
    return tools
