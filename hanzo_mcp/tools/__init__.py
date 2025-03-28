"""Tools package for Hanzo MCP.

This package contains all the tools for the Hanzo MCP server.
It provides a unified interface for registering all tools with an MCP server.

This includes a "think" tool implementation based on Anthropic's research showing
improved performance for complex tool-based interactions when Claude has a dedicated
space for structured thinking.
"""

from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.common.thinking import ThinkingTool
from hanzo_mcp.tools.dev_tool import DevTool
from hanzo_mcp.tools.project.analysis import ProjectManager
# Conditional import for vector store manager
try:
    from hanzo_mcp.tools.vector.store_manager import VectorStoreManager
except ImportError:
    VectorStoreManager = None

# Conditional import for tree-sitter manager
try:
    from hanzo_mcp.tools.symbols.tree_sitter_manager import TreeSitterManager
except ImportError:
    TreeSitterManager = None


async def register_all_tools(
    mcp_server: FastMCP,
    document_context: DocumentContext,
    permission_manager: PermissionManager,
    project_manager: ProjectManager,
    project_analyzer: Any,
    vector_store_manager: Optional[VectorStoreManager] = None,
    tree_sitter_manager: Optional[TreeSitterManager] = None,
) -> None:
    """Register all Hanzo MCP tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        document_context: Document context for tracking file contents
        permission_manager: Permission manager for access control
        project_manager: Project manager for tracking projects
        project_analyzer: Project analyzer for analyzing project structure and dependencies
        vector_store_manager: Optional vector store manager for embeddings and search
    """
        # Initialize the consolidated dev tool
    dev_tool = DevTool(
        document_context=document_context,
        permission_manager=permission_manager,
        command_executor=project_analyzer.command_executor,
        project_manager=project_manager,
        project_analyzer=project_analyzer,
        vector_store_manager=vector_store_manager,
        tree_sitter_manager=tree_sitter_manager
    )
    # Register all dev tools
    await dev_tool.register_tools(mcp_server)

    # Initialize and register thinking tool
    thinking_tool = ThinkingTool()
    thinking_tool.register_tools(mcp_server)