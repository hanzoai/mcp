"""Tree tool implementation.

Unix-style tree command for directory visualization.
"""

import os
from pathlib import Path
from typing import Annotated, TypedDict, Unpack, final, override, Optional, List

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool


# Parameter types
TreePath = Annotated[
    str,
    Field(
        description="Directory path to display",
        default=".",
    ),
]

Depth = Annotated[
    Optional[int],
    Field(
        description="Maximum depth to display",
        default=None,
    ),
]

ShowHidden = Annotated[
    bool,
    Field(
        description="Show hidden files (starting with .)",
        default=False,
    ),
]

DirsOnly = Annotated[
    bool,
    Field(
        description="Show only directories",
        default=False,
    ),
]

ShowSize = Annotated[
    bool,
    Field(
        description="Show file sizes",
        default=False,
    ),
]

Pattern = Annotated[
    Optional[str],
    Field(
        description="Only show files matching pattern",
        default=None,
    ),
]


class TreeParams(TypedDict, total=False):
    """Parameters for tree tool."""
    path: str
    depth: Optional[int]
    show_hidden: bool
    dirs_only: bool
    show_size: bool
    pattern: Optional[str]


@final
class TreeTool(FilesystemBaseTool):
    """Unix-style tree command for directory visualization."""

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "tree"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Directory tree visualization.

Usage:
tree
tree ./src --depth 2
tree --dirs-only
tree --pattern "*.py" --show-size"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[TreeParams],
    ) -> str:
        """Execute tree command."""
        tool_ctx = self.create_tool_context(ctx)
        
        # Extract parameters
        path = params.get("path", ".")
        max_depth = params.get("depth")
        show_hidden = params.get("show_hidden", False)
        dirs_only = params.get("dirs_only", False)
        show_size = params.get("show_size", False)
        pattern = params.get("pattern")
        
        # Validate path
        path_validation = self.validate_path(path)
        if path_validation.is_error:
            return f"Error: {path_validation.error_message}"
            
        # Check permissions
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg
            
        # Check existence
        exists, error_msg = await self.check_path_exists(path, tool_ctx)
        if not exists:
            return error_msg
            
        path_obj = Path(path)
        if not path_obj.is_dir():
            return f"Error: {path} is not a directory"
            
        # Build tree
        output = [str(path_obj)]
        stats = {"dirs": 0, "files": 0}
        
        self._build_tree(
            path_obj, 
            output, 
            stats,
            prefix="",
            is_last=True,
            current_depth=0,
            max_depth=max_depth,
            show_hidden=show_hidden,
            dirs_only=dirs_only,
            show_size=show_size,
            pattern=pattern
        )
        
        # Add summary
        output.append("")
        if dirs_only:
            output.append(f"{stats['dirs']} directories")
        else:
            output.append(f"{stats['dirs']} directories, {stats['files']} files")
            
        return "\n".join(output)

    def _build_tree(
        self,
        path: Path,
        output: List[str],
        stats: dict,
        prefix: str,
        is_last: bool,
        current_depth: int,
        max_depth: Optional[int],
        show_hidden: bool,
        dirs_only: bool,
        show_size: bool,
        pattern: Optional[str],
    ) -> None:
        """Recursively build tree structure."""
        # Check depth limit
        if max_depth is not None and current_depth >= max_depth:
            return
            
        try:
            # Get entries
            entries = list(path.iterdir())
            
            # Filter hidden files
            if not show_hidden:
                entries = [e for e in entries if not e.name.startswith(".")]
                
            # Filter by pattern
            if pattern:
                import fnmatch
                entries = [e for e in entries if fnmatch.fnmatch(e.name, pattern) or e.is_dir()]
                
            # Filter dirs only
            if dirs_only:
                entries = [e for e in entries if e.is_dir()]
                
            # Sort entries (dirs first, then alphabetically)
            entries.sort(key=lambda e: (not e.is_dir(), e.name.lower()))
            
            # Process each entry
            for i, entry in enumerate(entries):
                is_last_entry = i == len(entries) - 1
                
                # Skip if not allowed
                if not self.is_path_allowed(str(entry)):
                    continue
                    
                # Build the tree branch
                if prefix:
                    if is_last_entry:
                        branch = prefix + "└── "
                        extension = prefix + "    "
                    else:
                        branch = prefix + "├── "
                        extension = prefix + "│   "
                else:
                    branch = ""
                    extension = ""
                    
                # Build entry line
                line = branch + entry.name
                
                # Add size if requested
                if show_size and entry.is_file():
                    try:
                        size = entry.stat().st_size
                        line += f" ({self._format_size(size)})"
                    except:
                        pass
                        
                output.append(line)
                
                # Update stats
                if entry.is_dir():
                    stats["dirs"] += 1
                    # Recurse into directory
                    self._build_tree(
                        entry,
                        output,
                        stats,
                        prefix=extension,
                        is_last=is_last_entry,
                        current_depth=current_depth + 1,
                        max_depth=max_depth,
                        show_hidden=show_hidden,
                        dirs_only=dirs_only,
                        show_size=show_size,
                        pattern=pattern
                    )
                else:
                    stats["files"] += 1
                    
        except PermissionError:
            output.append(prefix + "[Permission Denied]")
        except Exception as e:
            output.append(prefix + f"[Error: {str(e)}]")

    def _format_size(self, size: int) -> str:
        """Format file size in human-readable format."""
        for unit in ["B", "KB", "MB", "GB", "TB"]:
            if size < 1024.0:
                return f"{size:.1f}{unit}"
            size /= 1024.0
        return f"{size:.1f}PB"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass