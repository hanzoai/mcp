"""Filesystem tools package for Hanzo MCP.

This package provides tools for interacting with the filesystem, including reading, writing,
and editing files, directory navigation, and content searching.
"""

from mcp.server import FastMCP

from hanzo_mcp.tools.common.base import BaseTool, ToolRegistry

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem.content_replace import ContentReplaceTool
from hanzo_mcp.tools.filesystem.directory_tree import DirectoryTreeTool
from hanzo_mcp.tools.filesystem.edit import Edit
from hanzo_mcp.tools.filesystem.grep import Grep
from hanzo_mcp.tools.filesystem.symbols import SymbolsTool
from hanzo_mcp.tools.filesystem.git_search import GitSearchTool
from hanzo_mcp.tools.filesystem.multi_edit import MultiEdit
from hanzo_mcp.tools.filesystem.read import ReadTool
from hanzo_mcp.tools.filesystem.write import Write
from hanzo_mcp.tools.filesystem.batch_search import BatchSearchTool
from hanzo_mcp.tools.filesystem.find_files import FindFilesTool
from hanzo_mcp.tools.filesystem.unified_search import UnifiedSearchTool
from hanzo_mcp.tools.filesystem.watch import watch_tool
from hanzo_mcp.tools.filesystem.diff import create_diff_tool

# Export all tool classes
__all__ = [
    "ReadTool",
    "Write",
    "Edit",
    "MultiEdit",
    "DirectoryTreeTool",
    "Grep",
    "ContentReplaceTool",
    "SymbolsTool",
    "GitSearchTool",
    "BatchSearchTool",
    "FindFilesTool",
    "UnifiedSearchTool",
    "get_filesystem_tools",
    "register_filesystem_tools",
]


def get_read_only_filesystem_tools(
    permission_manager: PermissionManager,
    project_manager=None,
) -> list[BaseTool]:
    """Create instances of read-only filesystem tools.

    Args:
        permission_manager: Permission manager for access control
        project_manager: Optional project manager for unified search

    Returns:
        List of read-only filesystem tool instances
    """
    tools = [
        ReadTool(permission_manager),
        DirectoryTreeTool(permission_manager),
        Grep(permission_manager),
        SymbolsTool(permission_manager),
        GitSearchTool(permission_manager),
        FindFilesTool(permission_manager),
        watch_tool,
        create_diff_tool(permission_manager),
    ]
    
    # Add unified search if project manager is available
    if project_manager:
        tools.append(UnifiedSearchTool(permission_manager, project_manager))
    
    return tools


def get_filesystem_tools(permission_manager: PermissionManager, project_manager=None) -> list[BaseTool]:
    """Create instances of all filesystem tools.

    Args:
        permission_manager: Permission manager for access control
        project_manager: Optional project manager for unified search

    Returns:
        List of filesystem tool instances
    """
    tools = [
        ReadTool(permission_manager),
        Write(permission_manager),
        Edit(permission_manager),
        MultiEdit(permission_manager),
        DirectoryTreeTool(permission_manager),
        Grep(permission_manager),
        ContentReplaceTool(permission_manager),
        SymbolsTool(permission_manager),
        GitSearchTool(permission_manager),
        FindFilesTool(permission_manager),
        watch_tool,
        create_diff_tool(permission_manager),
    ]
    
    # Add unified search if project manager is available
    if project_manager:
        tools.append(UnifiedSearchTool(permission_manager, project_manager))
    
    return tools


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
        "grep_ast": SymbolsTool,  # Using correct import name
        "git_search": GitSearchTool,
        "content_replace": ContentReplaceTool,
        "batch_search": BatchSearchTool,
        "find_files": FindFilesTool,
        "unified_search": UnifiedSearchTool,
        "watch": lambda pm: watch_tool,  # Singleton instance
        "diff": create_diff_tool,
    }
    
    tools = []
    
    if enabled_tools:
        # Use individual tool configuration
        for tool_name, enabled in enabled_tools.items():
            if enabled and tool_name in tool_classes:
                tool_class = tool_classes[tool_name]
                if tool_name in ["batch_search", "unified_search"]:
                    # Batch search and unified search require project_manager
                    tools.append(tool_class(permission_manager, project_manager))
                elif tool_name == "watch":
                    # Watch tool is a singleton
                    tools.append(tool_class(permission_manager))
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
            tools = get_read_only_filesystem_tools(permission_manager, project_manager)
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
            tools = get_filesystem_tools(permission_manager, project_manager)
    
    ToolRegistry.register_tools(mcp_server, tools)
    return tools
