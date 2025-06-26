"""Index tool for managing vector store indexing."""

import asyncio
import os
import time
from pathlib import Path
from typing import Annotated, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.vector.git_ingester import GitIngester
from hanzo_mcp.tools.vector.infinity_store import InfinityVectorStore
from hanzo_mcp.tools.vector.project_manager import ProjectVectorManager


Path_str = Annotated[
    str,
    Field(
        description="Path to index (defaults to current working directory)",
        min_length=1,
    ),
]

IncludeGitHistory = Annotated[
    bool,
    Field(
        description="Include git history in the index",
        default=True,
    ),
]

FilePatterns = Annotated[
    list[str] | None,
    Field(
        description="File patterns to include (e.g., ['*.py', '*.js'])",
        default=None,
    ),
]

ShowStats = Annotated[
    bool,
    Field(
        description="Show detailed statistics after indexing",
        default=True,
    ),
]

Force = Annotated[
    bool,
    Field(
        description="Force re-indexing even if already indexed",
        default=False,
    ),
]


class IndexToolParams(TypedDict, total=False):
    """Parameters for the index tool."""

    path: str
    include_git_history: bool
    file_patterns: list[str] | None
    show_stats: bool
    force: bool


@final
class IndexTool(BaseTool):
    """Tool for indexing files and git history into vector store."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the index tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager
        self.project_manager = ProjectVectorManager(permission_manager)

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "index"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Index files and git history into the vector store for semantic search.

This tool:
- Indexes all project files into a vector database
- Includes git history (commits, diffs, blame) when available
- Supports incremental updates
- Shows statistics about indexed content
- Automatically creates project-specific databases

Usage:
- index: Index the current directory
- index --path /path/to/project: Index a specific path
- index --file-patterns "*.py" "*.js": Index only specific file types
- index --no-git-history: Skip git history indexing
- index --force: Force re-indexing of all files"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[IndexToolParams],
    ) -> str:
        """Execute the index tool.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Indexing result and statistics
        """
        start_time = time.time()
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        path = params.get("path", os.getcwd())
        include_git_history = params.get("include_git_history", True)
        file_patterns = params.get("file_patterns")
        show_stats = params.get("show_stats", True)
        force = params.get("force", False)

        # Resolve absolute path
        abs_path = os.path.abspath(path)
        
        # Check permissions
        if not self.permission_manager.has_permission(abs_path):
            return f"Permission denied: {abs_path}"

        # Check if path exists
        if not os.path.exists(abs_path):
            return f"Path does not exist: {abs_path}"

        await tool_ctx.info(f"Starting indexing of {abs_path}")

        try:
            # Get or create vector store for this project
            vector_store = self.project_manager.get_project_store(abs_path)
            
            # Check if already indexed (unless force)
            if not force:
                stats = await vector_store.get_stats()
                if stats and stats.get("document_count", 0) > 0:
                    await tool_ctx.info("Project already indexed, use --force to re-index")
                    if show_stats:
                        return self._format_stats(stats, abs_path, time.time() - start_time)
                    return "Project is already indexed. Use --force to re-index."

            # Prepare file patterns
            if file_patterns is None:
                # Default patterns for code files
                file_patterns = [
                    "*.py", "*.js", "*.ts", "*.jsx", "*.tsx",
                    "*.java", "*.cpp", "*.c", "*.h", "*.hpp",
                    "*.go", "*.rs", "*.rb", "*.php", "*.swift",
                    "*.kt", "*.scala", "*.cs", "*.vb", "*.fs",
                    "*.sh", "*.bash", "*.zsh", "*.fish",
                    "*.md", "*.rst", "*.txt", "*.json", "*.yaml", "*.yml",
                    "*.toml", "*.ini", "*.cfg", "*.conf",
                    "*.html", "*.css", "*.scss", "*.sass", "*.less",
                    "*.sql", "*.graphql", "*.proto",
                    "Dockerfile", "Makefile", "*.mk",
                    ".gitignore", ".dockerignore", "requirements.txt",
                    "package.json", "Cargo.toml", "go.mod", "pom.xml",
                ]

            # Clear existing index if force
            if force:
                await tool_ctx.info("Clearing existing index...")
                await vector_store.clear()

            # Index files
            await tool_ctx.info("Indexing files...")
            indexed_files = 0
            total_size = 0
            errors = []

            for pattern in file_patterns:
                pattern_files = await self._find_files(abs_path, pattern)
                for file_path in pattern_files:
                    try:
                        # Check file size (skip very large files)
                        file_size = os.path.getsize(file_path)
                        if file_size > 10 * 1024 * 1024:  # 10MB
                            await tool_ctx.warning(f"Skipping large file: {file_path}")
                            continue

                        # Read file content
                        try:
                            with open(file_path, "r", encoding="utf-8") as f:
                                content = f.read()
                        except UnicodeDecodeError:
                            # Skip binary files
                            continue

                        # Index the file
                        rel_path = os.path.relpath(file_path, abs_path)
                        await vector_store.index_document(
                            content=content,
                            metadata={
                                "type": "file",
                                "path": rel_path,
                                "absolute_path": file_path,
                                "size": file_size,
                                "extension": Path(file_path).suffix,
                            }
                        )
                        indexed_files += 1
                        total_size += file_size

                        if indexed_files % 100 == 0:
                            await tool_ctx.info(f"Indexed {indexed_files} files...")

                    except Exception as e:
                        errors.append(f"{file_path}: {str(e)}")

            await tool_ctx.info(f"Indexed {indexed_files} files ({total_size / 1024 / 1024:.1f} MB)")

            # Index git history if requested
            git_stats = {}
            if include_git_history and os.path.exists(os.path.join(abs_path, ".git")):
                await tool_ctx.info("Indexing git history...")
                
                git_ingester = GitIngester(vector_store)
                git_stats = await git_ingester.ingest_repository(
                    repo_path=abs_path,
                    include_history=True,
                    include_diffs=True,
                    include_blame=True,
                    file_patterns=file_patterns,
                )
                
                await tool_ctx.info(
                    f"Indexed {git_stats.get('commits_indexed', 0)} commits, "
                    f"{git_stats.get('diffs_indexed', 0)} diffs"
                )

            # Get final statistics
            if show_stats:
                stats = await vector_store.get_stats()
                stats.update({
                    "files_indexed": indexed_files,
                    "total_size_mb": total_size / 1024 / 1024,
                    "errors": len(errors),
                    **git_stats,
                })
                result = self._format_stats(stats, abs_path, time.time() - start_time)
                
                if errors:
                    result += f"\n\nErrors ({len(errors)}):\n"
                    result += "\n".join(errors[:10])  # Show first 10 errors
                    if len(errors) > 10:
                        result += f"\n... and {len(errors) - 10} more errors"
                
                return result
            else:
                return f"Successfully indexed {indexed_files} files"

        except Exception as e:
            await tool_ctx.error(f"Indexing failed: {str(e)}")
            return f"Error during indexing: {str(e)}"

    async def _find_files(self, base_path: str, pattern: str) -> list[str]:
        """Find files matching a pattern.

        Args:
            base_path: Base directory to search
            pattern: File pattern to match

        Returns:
            List of matching file paths
        """
        import glob

        # Use glob to find files
        if pattern.startswith("*."):
            # Extension pattern
            files = glob.glob(
                os.path.join(base_path, "**", pattern),
                recursive=True,
            )
        else:
            # Exact filename
            files = glob.glob(
                os.path.join(base_path, "**", pattern),
                recursive=True,
            )

        # Filter out hidden directories and common ignore patterns
        filtered_files = []
        ignore_dirs = {".git", "__pycache__", "node_modules", ".venv", "venv", "dist", "build"}
        
        for file_path in files:
            # Check if any parent directory is in ignore list
            parts = Path(file_path).parts
            if any(part in ignore_dirs for part in parts):
                continue
            if any(part.startswith(".") and part != "." for part in parts[:-1]):
                continue  # Skip hidden directories (but allow hidden files like .gitignore)
            filtered_files.append(file_path)

        return filtered_files

    def _format_stats(self, stats: dict, path: str, elapsed_time: float) -> str:
        """Format statistics for display.

        Args:
            stats: Statistics dictionary
            path: Indexed path
            elapsed_time: Time taken for indexing

        Returns:
            Formatted statistics string
        """
        result = f"=== Index Statistics for {path} ===\n\n"
        
        # Basic stats
        result += f"Indexing completed in {elapsed_time:.1f} seconds\n\n"
        
        result += "Content Statistics:\n"
        result += f"  Documents: {stats.get('document_count', 0):,}\n"
        result += f"  Files indexed: {stats.get('files_indexed', 0):,}\n"
        result += f"  Total size: {stats.get('total_size_mb', 0):.1f} MB\n"
        
        if stats.get("commits_indexed", 0) > 0:
            result += f"\nGit History:\n"
            result += f"  Commits: {stats.get('commits_indexed', 0):,}\n"
            result += f"  Diffs: {stats.get('diffs_indexed', 0):,}\n"
            result += f"  Blame entries: {stats.get('blame_entries', 0):,}\n"
        
        # Vector store info
        result += f"\nVector Store:\n"
        result += f"  Database: {stats.get('database_name', 'default')}\n"
        result += f"  Table: {stats.get('table_name', 'documents')}\n"
        result += f"  Vectors: {stats.get('vector_count', stats.get('document_count', 0)):,}\n"
        
        if stats.get("errors", 0) > 0:
            result += f"\nErrors: {stats.get('errors', 0)}\n"
        
        return result

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        # Tool registration is handled by the ToolRegistry
        pass