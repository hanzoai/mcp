"""Unified vector store tool."""

from typing import Annotated, TypedDict, Unpack, final, override, Optional, List, Dict, Any
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.vector.project_manager import ProjectVectorManager


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action: search (default), index, stats, clear",
        default="search",
    ),
]

Query = Annotated[
    Optional[str],
    Field(
        description="Search query for semantic similarity",
        default=None,
    ),
]

Path = Annotated[
    Optional[str],
    Field(
        description="Path to index or search within",
        default=".",
    ),
]

Include = Annotated[
    Optional[str],
    Field(
        description="File pattern to include (e.g., '*.py')",
        default=None,
    ),
]

Exclude = Annotated[
    Optional[str],
    Field(
        description="File pattern to exclude",
        default=None,
    ),
]

Limit = Annotated[
    int,
    Field(
        description="Maximum results to return",
        default=10,
    ),
]

IncludeGit = Annotated[
    bool,
    Field(
        description="Include git history in indexing",
        default=True,
    ),
]

ForceReindex = Annotated[
    bool,
    Field(
        description="Force reindexing even if up to date",
        default=False,
    ),
]


class VectorParams(TypedDict, total=False):
    """Parameters for vector tool."""
    action: str
    query: Optional[str]
    path: Optional[str]
    include: Optional[str]
    exclude: Optional[str]
    limit: int
    include_git: bool
    force_reindex: bool


@final
class VectorTool(BaseTool):
    """Unified vector store tool for semantic search."""
    
    def __init__(self, permission_manager: PermissionManager, project_manager: ProjectVectorManager):
        """Initialize the vector tool."""
        super().__init__(permission_manager)
        self.project_manager = project_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "vector"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Semantic search with embeddings. Actions: search (default), index, stats, clear.

Usage:
vector "find authentication logic"
vector --action index --path ./src --include "*.py"
vector --action stats
vector --action clear --path ./old_code
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[VectorParams],
    ) -> str:
        """Execute vector operation."""
        tool_ctx = self.create_tool_context(ctx)

        # Extract action
        action = params.get("action", "search")
        
        # Route to appropriate handler
        if action == "search":
            return await self._handle_search(params, tool_ctx)
        elif action == "index":
            return await self._handle_index(params, tool_ctx)
        elif action == "stats":
            return await self._handle_stats(params, tool_ctx)
        elif action == "clear":
            return await self._handle_clear(params, tool_ctx)
        else:
            return f"Error: Unknown action '{action}'. Valid actions: search, index, stats, clear"

    async def _handle_search(self, params: Dict[str, Any], tool_ctx) -> str:
        """Handle semantic search."""
        query = params.get("query")
        if not query:
            return "Error: query is required for search action"
        
        path = params.get("path", ".")
        limit = params.get("limit", 10)
        
        # Validate path
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg
        
        try:
            # Determine search scope
            project = self.project_manager.get_project_for_path(path)
            if not project:
                return "Error: No indexed project found for this path. Run 'vector --action index' first."
            
            # Search
            await tool_ctx.info(f"Searching for: {query}")
            results = project.search(query, k=limit)
            
            if not results:
                return f"No results found for: {query}"
            
            # Format results
            output = [f"=== Vector Search Results for '{query}' ==="]
            output.append(f"Found {len(results)} matches\n")
            
            for i, result in enumerate(results, 1):
                score = result.get("score", 0)
                file_path = result.get("file_path", "unknown")
                content = result.get("content", "")
                chunk_type = result.get("metadata", {}).get("type", "content")
                
                output.append(f"Result {i} - Score: {score:.1%}")
                output.append(f"File: {file_path}")
                if chunk_type != "content":
                    output.append(f"Type: {chunk_type}")
                output.append("-" * 60)
                
                # Truncate content if too long
                if len(content) > 300:
                    content = content[:300] + "..."
                output.append(content)
                output.append("")
            
            return "\n".join(output)
            
        except Exception as e:
            await tool_ctx.error(f"Search failed: {str(e)}")
            return f"Error during search: {str(e)}"

    async def _handle_index(self, params: Dict[str, Any], tool_ctx) -> str:
        """Handle indexing files."""
        path = params.get("path", ".")
        include = params.get("include")
        exclude = params.get("exclude")
        include_git = params.get("include_git", True)
        force = params.get("force_reindex", False)
        
        # Validate path
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg
        
        try:
            await tool_ctx.info(f"Indexing {path}...")
            
            # Get or create project
            project = self.project_manager.get_or_create_project(path)
            
            # Index files
            stats = await project.index_directory(
                path,
                include_pattern=include,
                exclude_pattern=exclude,
                force_reindex=force
            )
            
            # Index git history if requested
            if include_git and Path(path).joinpath(".git").exists():
                await tool_ctx.info("Indexing git history...")
                git_stats = await project.index_git_history(path)
                stats["git_commits"] = git_stats.get("commits_indexed", 0)
            
            # Format output
            output = [f"=== Indexing Complete ==="]
            output.append(f"Path: {path}")
            output.append(f"Files indexed: {stats.get('files_indexed', 0)}")
            output.append(f"Chunks created: {stats.get('chunks_created', 0)}")
            if stats.get("git_commits"):
                output.append(f"Git commits indexed: {stats['git_commits']}")
            output.append(f"Total documents: {project.get_stats().get('total_documents', 0)}")
            
            return "\n".join(output)
            
        except Exception as e:
            await tool_ctx.error(f"Indexing failed: {str(e)}")
            return f"Error during indexing: {str(e)}"

    async def _handle_stats(self, params: Dict[str, Any], tool_ctx) -> str:
        """Get vector store statistics."""
        path = params.get("path")
        
        try:
            if path:
                # Stats for specific project
                project = self.project_manager.get_project_for_path(path)
                if not project:
                    return f"No indexed project found for path: {path}"
                
                stats = project.get_stats()
                output = [f"=== Vector Store Stats for {project.name} ==="]
            else:
                # Global stats
                stats = self.project_manager.get_global_stats()
                output = ["=== Global Vector Store Stats ==="]
            
            output.append(f"Total documents: {stats.get('total_documents', 0)}")
            output.append(f"Total size: {stats.get('total_size_mb', 0):.1f} MB")
            
            if stats.get("projects"):
                output.append(f"\nProjects indexed: {len(stats['projects'])}")
                for proj in stats["projects"]:
                    output.append(f"  - {proj['name']}: {proj['documents']} docs, {proj['size_mb']:.1f} MB")
            
            return "\n".join(output)
            
        except Exception as e:
            await tool_ctx.error(f"Failed to get stats: {str(e)}")
            return f"Error getting stats: {str(e)}"

    async def _handle_clear(self, params: Dict[str, Any], tool_ctx) -> str:
        """Clear vector store."""
        path = params.get("path")
        
        if not path:
            return "Error: path is required for clear action"
        
        # Validate path
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg
        
        try:
            project = self.project_manager.get_project_for_path(path)
            if not project:
                return f"No indexed project found for path: {path}"
            
            # Get stats before clearing
            stats = project.get_stats()
            doc_count = stats.get("total_documents", 0)
            
            # Clear
            project.clear()
            
            return f"Cleared {doc_count} documents from vector store for {project.name}"
            
        except Exception as e:
            await tool_ctx.error(f"Failed to clear: {str(e)}")
            return f"Error clearing vector store: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass