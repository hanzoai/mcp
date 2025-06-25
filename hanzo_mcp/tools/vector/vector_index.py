"""Vector indexing tool for adding documents to vector database."""

from typing import Dict, List, Optional, TypedDict, Unpack, final
from pathlib import Path

from fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.common.validation import validate_path_parameter

from .infinity_store import InfinityVectorStore
from .project_manager import ProjectVectorManager


class VectorIndexParams(TypedDict, total=False):
    """Parameters for vector indexing operations."""
    
    file_path: str
    content: Optional[str]
    chunk_size: Optional[int]
    chunk_overlap: Optional[int]
    metadata: Optional[Dict[str, str]]


@final
class VectorIndexTool(BaseTool):
    """Tool for indexing documents in the vector database."""
    
    def __init__(self, permission_manager: PermissionManager, project_manager: ProjectVectorManager):
        """Initialize the vector index tool.
        
        Args:
            permission_manager: Permission manager for access control
            project_manager: Project-aware vector store manager
        """
        self.permission_manager = permission_manager
        self.project_manager = project_manager
    
    @property
    def name(self) -> str:
        """Get the tool name."""
        return "vector_index"
    
    @property
    def description(self) -> str:
        """Get the tool description."""
        return """Index documents in project-aware vector databases for semantic search.
        
Can index individual text content or entire files. Files are automatically assigned
to the appropriate project database based on LLM.md detection or stored in the global
database. Files are chunked for optimal search performance.

Projects are detected by finding LLM.md files, with databases stored in .hanzo/db
directories alongside them. Use this to build searchable knowledge bases per project."""
    
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[VectorIndexParams],
    ) -> str:
        """Index content or files in the vector database.
        
        Args:
            ctx: MCP context
            **params: Tool parameters
            
        Returns:
            Indexing result message
        """
        file_path = params.get("file_path")
        content = params.get("content")
        chunk_size = params.get("chunk_size", 1000)
        chunk_overlap = params.get("chunk_overlap", 200)
        metadata = params.get("metadata", {})
        
        if not file_path and not content:
            return "Error: Either file_path or content must be provided"
        
        try:
            if file_path:
                # Validate file access
                # Use permission manager's existing validation
                if not self.permission_manager.is_path_allowed(file_path):
                    return f"Error: Access denied to path {file_path}"
                
                if not Path(file_path).exists():
                    return f"Error: File does not exist: {file_path}"
                
                # Index file using project-aware manager
                doc_ids, project_info = self.project_manager.add_file_to_appropriate_store(
                    file_path=file_path,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                    metadata=metadata,
                )
                
                file_name = Path(file_path).name
                if project_info:
                    return f"Successfully indexed {file_name} with {len(doc_ids)} chunks in project '{project_info.name}'"
                else:
                    return f"Successfully indexed {file_name} with {len(doc_ids)} chunks in global database"
            
            else:
                # Index content directly in global store (no project context)
                global_store = self.project_manager._get_global_store()
                doc_id = global_store.add_document(
                    content=content,
                    metadata=metadata,
                )
                
                return f"Successfully indexed content as document {doc_id} in global database"
                
        except Exception as e:
            return f"Error indexing content: {str(e)}"