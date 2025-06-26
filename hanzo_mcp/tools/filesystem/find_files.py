"""Find files using ffind library."""

import os
from typing import Annotated, Optional, TypedDict, Unpack, final, override
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager

try:
    import ffind
    FFIND_AVAILABLE = True
except ImportError:
    FFIND_AVAILABLE = False


Pattern = Annotated[
    str,
    Field(
        description="File name pattern to search for (supports wildcards)",
        min_length=1,
    ),
]

Path_ = Annotated[
    Optional[str],
    Field(
        description="Directory to search in (defaults to current directory)",
        default=None,
    ),
]

Recursive = Annotated[
    bool,
    Field(
        description="Search recursively in subdirectories",
        default=True,
    ),
]

IgnoreCase = Annotated[
    bool,
    Field(
        description="Case-insensitive search",
        default=True,
    ),
]

Hidden = Annotated[
    bool,
    Field(
        description="Include hidden files in search",
        default=False,
    ),
]

DirsOnly = Annotated[
    bool,
    Field(
        description="Only find directories",
        default=False,
    ),
]

FilesOnly = Annotated[
    bool,
    Field(
        description="Only find files (not directories)",
        default=True,
    ),
]

MaxResults = Annotated[
    int,
    Field(
        description="Maximum number of results",
        default=100,
    ),
]


class FindFilesParams(TypedDict, total=False):
    """Parameters for find files tool."""

    pattern: str
    path: Optional[str]
    recursive: bool
    ignore_case: bool
    hidden: bool
    dirs_only: bool
    files_only: bool
    max_results: int


@final
class FindFilesTool(BaseTool):
    """Tool for finding files using ffind."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the find files tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "find_files"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Find files by name pattern using efficient search.

Uses the ffind library for fast file searching with support for:
- Wildcards (* and ?)
- Case-insensitive search
- Hidden files
- Directory vs file filtering

Examples:
- find_files --pattern "*.py"              # Find all Python files
- find_files --pattern "test_*"            # Find files starting with test_
- find_files --pattern "README.*"          # Find README files
- find_files --pattern "*config*" --hidden # Include hidden config files
- find_files --pattern "src" --dirs-only   # Find directories named src

For content search, use 'grep' instead.
For database search, use 'sql_search' or 'vector_search'.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[FindFilesParams],
    ) -> str:
        """Find files matching pattern.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            List of matching files
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern is required"

        search_path = params.get("path") or os.getcwd()
        recursive = params.get("recursive", True)
        ignore_case = params.get("ignore_case", True)
        hidden = params.get("hidden", False)
        dirs_only = params.get("dirs_only", False)
        files_only = params.get("files_only", True)
        max_results = params.get("max_results", 100)

        # Validate path
        search_path = os.path.abspath(search_path)
        if not self.permission_manager.has_permission(search_path):
            return f"Error: No permission to access {search_path}"

        if not os.path.exists(search_path):
            return f"Error: Path does not exist: {search_path}"

        await tool_ctx.info(f"Searching for '{pattern}' in {search_path}")

        # If ffind is not available, fall back to basic implementation
        if not FFIND_AVAILABLE:
            return await self._find_files_fallback(
                pattern, search_path, recursive, ignore_case, 
                hidden, dirs_only, files_only, max_results
            )

        try:
            # Use ffind for efficient searching
            results = []
            count = 0
            
            # Configure ffind options
            options = {
                'pattern': pattern,
                'path': search_path,
                'recursive': recursive,
                'ignore_case': ignore_case,
                'hidden': hidden,
            }
            
            # Search with ffind
            for filepath in ffind.find(**options):
                # Check if it matches our criteria
                is_dir = os.path.isdir(filepath)
                
                if dirs_only and not is_dir:
                    continue
                if files_only and is_dir:
                    continue
                
                # Make path relative for cleaner output
                try:
                    rel_path = os.path.relpath(filepath, search_path)
                except ValueError:
                    rel_path = filepath
                
                results.append(rel_path)
                count += 1
                
                if count >= max_results:
                    break
            
            if not results:
                return f"No files found matching '{pattern}'"
            
            # Format output
            output = [f"Found {len(results)} file(s) matching '{pattern}':"]
            output.append("")
            
            for filepath in sorted(results):
                output.append(filepath)
            
            if count >= max_results:
                output.append(f"\n... (showing first {max_results} results)")
            
            return "\n".join(output)

        except Exception as e:
            await tool_ctx.error(f"Error during search: {str(e)}")
            # Fall back to basic implementation
            return await self._find_files_fallback(
                pattern, search_path, recursive, ignore_case,
                hidden, dirs_only, files_only, max_results
            )

    async def _find_files_fallback(
        self, pattern: str, search_path: str, recursive: bool,
        ignore_case: bool, hidden: bool, dirs_only: bool,
        files_only: bool, max_results: int
    ) -> str:
        """Fallback implementation when ffind is not available."""
        import fnmatch
        
        results = []
        count = 0
        
        # Convert pattern for case-insensitive matching
        if ignore_case:
            pattern = pattern.lower()
        
        try:
            if recursive:
                # Walk directory tree
                for root, dirs, files in os.walk(search_path):
                    # Skip hidden directories if not requested
                    if not hidden:
                        dirs[:] = [d for d in dirs if not d.startswith('.')]
                    
                    # Check directories
                    if not files_only:
                        for dirname in dirs:
                            if self._match_pattern(dirname, pattern, ignore_case):
                                filepath = os.path.join(root, dirname)
                                rel_path = os.path.relpath(filepath, search_path)
                                results.append(rel_path + '/')
                                count += 1
                                if count >= max_results:
                                    break
                    
                    # Check files
                    if not dirs_only:
                        for filename in files:
                            if not hidden and filename.startswith('.'):
                                continue
                            
                            if self._match_pattern(filename, pattern, ignore_case):
                                filepath = os.path.join(root, filename)
                                rel_path = os.path.relpath(filepath, search_path)
                                results.append(rel_path)
                                count += 1
                                if count >= max_results:
                                    break
                    
                    if count >= max_results:
                        break
            else:
                # Only search in the specified directory
                for entry in os.listdir(search_path):
                    if not hidden and entry.startswith('.'):
                        continue
                    
                    filepath = os.path.join(search_path, entry)
                    is_dir = os.path.isdir(filepath)
                    
                    if dirs_only and not is_dir:
                        continue
                    if files_only and is_dir:
                        continue
                    
                    if self._match_pattern(entry, pattern, ignore_case):
                        results.append(entry + '/' if is_dir else entry)
                        count += 1
                        if count >= max_results:
                            break
            
            if not results:
                return f"No files found matching '{pattern}' (using fallback search)"
            
            # Format output
            output = [f"Found {len(results)} file(s) matching '{pattern}' (using fallback search):"]
            output.append("")
            
            for filepath in sorted(results):
                output.append(filepath)
            
            if count >= max_results:
                output.append(f"\n... (showing first {max_results} results)")
            
            output.append("\nNote: Install 'ffind' for faster searching: pip install ffind")
            
            return "\n".join(output)
            
        except Exception as e:
            return f"Error searching for files: {str(e)}"

    def _match_pattern(self, filename: str, pattern: str, ignore_case: bool) -> bool:
        """Check if filename matches pattern."""
        import fnmatch
        
        if ignore_case:
            return fnmatch.fnmatch(filename.lower(), pattern)
        else:
            return fnmatch.fnmatch(filename, pattern)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
