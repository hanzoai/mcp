"""Vector store tools for Hanzo MCP.

This module provides tools for vector embeddings and semantic search of project files.
It integrates with ChromaDB to create a local vector database for each project directory,
facilitating efficient semantic search and context retrieval for AI-assisted coding.
"""

from typing import final

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
# Conditional import to allow running tests without sentence-transformers
try:
    from hanzo_mcp.tools.vector.store_manager import VectorStoreManager
except ImportError:
    # Create a stub class for testing
    class VectorStoreManager:
        def __init__(self, document_context, permission_manager):
            self.document_context = document_context
            self.permission_manager = permission_manager
        
        async def register_tools(self, mcp_server):
            pass


@final
class VectorTools:
    """Vector store tools for Hanzo MCP."""

    def __init__(
        self,
        document_context: DocumentContext,
        permission_manager: PermissionManager,
        vector_store_manager: VectorStoreManager,
    ) -> None:
        """Initialize vector tools.

        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
            vector_store_manager: Vector store manager for managing vector databases
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        self.vector_store_manager = vector_store_manager

    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register vector tools with the MCP server.

        Args:
            mcp_server: The FastMCP server instance
        """
        # Register tools
        self.vector_store_manager.register_tools(mcp_server)
