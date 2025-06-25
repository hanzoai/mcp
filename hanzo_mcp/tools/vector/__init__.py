"""Vector database tools for Hanzo MCP.

This package provides tools for working with local vector databases for semantic search,
document indexing, and retrieval-augmented generation (RAG) workflows.

Supported backends:
- Infinity database (default) - High-performance local vector database
"""

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from fastmcp import FastMCP

# Try to import vector dependencies
try:
    from .infinity_store import InfinityVectorStore
    from .project_manager import ProjectVectorManager
    from .vector_index import VectorIndexTool
    from .vector_search import VectorSearchTool
    
    VECTOR_AVAILABLE = True
    
    def register_vector_tools(
        mcp_server: FastMCP,
        permission_manager: PermissionManager,
        vector_config: dict | None = None,
        enabled_tools: dict[str, bool] | None = None,
        search_paths: list[str] | None = None,
        project_manager: 'ProjectVectorManager | None' = None,
    ) -> list[BaseTool]:
        """Register vector database tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
            permission_manager: Permission manager for access control
            vector_config: Vector store configuration
            enabled_tools: Dictionary of individual tool enable states
            search_paths: Paths to search for projects (default: None, uses allowed paths)
            project_manager: Optional existing project manager to reuse
            
        Returns:
            List of registered tools
        """
        if not vector_config or not vector_config.get("enabled", False):
            return []
        
        # Check individual tool enablement
        tool_enabled = enabled_tools or {}
        tools = []
        
        # Use provided project manager or create new one
        if project_manager is None:
            # Initialize project-aware vector manager
            store_config = vector_config.copy()
            project_manager = ProjectVectorManager(
                global_db_path=store_config.get("data_path"),
                embedding_model=store_config.get("embedding_model", "text-embedding-3-small"),
                dimension=store_config.get("dimension", 1536),
            )
            
            # Auto-detect projects from search paths for new manager
            if search_paths:
                detected_projects = project_manager.detect_projects(search_paths)
                print(f"Detected {len(detected_projects)} projects with LLM.md files")
        
        # Register individual tools if enabled
        if tool_enabled.get("vector_index", True):
            tools.append(VectorIndexTool(permission_manager, project_manager))
        
        if tool_enabled.get("vector_search", True):
            tools.append(VectorSearchTool(permission_manager, project_manager))
        
        # Register with MCP server
        from hanzo_mcp.tools.common.base import ToolRegistry
        ToolRegistry.register_tools(mcp_server, tools)
        
        return tools

except ImportError:
    VECTOR_AVAILABLE = False
    
    def register_vector_tools(*args, **kwargs) -> list[BaseTool]:
        """Vector tools not available - missing dependencies."""
        print("Warning: Vector tools not available. Install infinity-embedded: pip install infinity-embedded")
        return []


__all__ = [
    "register_vector_tools",
    "VECTOR_AVAILABLE",
]

if VECTOR_AVAILABLE:
    __all__.extend([
        "InfinityVectorStore",
        "ProjectVectorManager",
        "VectorIndexTool", 
        "VectorSearchTool",
    ])