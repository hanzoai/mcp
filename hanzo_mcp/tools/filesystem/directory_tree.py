"""Directory tree tool implementation.

This module provides the DirectoryTreeTool for viewing file and directory structures.
"""

import os
from pathlib import Path
from typing import Any, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.path_utils import PathUtils
from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool


@final
class DirectoryTreeTool(FilesystemBaseTool):
    """Tool for viewing directory structure as a tree."""
    
    @property
    @override
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "directory_tree"
        
    @property
    @override
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return """Get a recursive tree view of files and directories with customizable depth and filtering.

Returns a structured view of the directory tree with files and subdirectories.
Directories are marked with trailing slashes. The output is formatted as an
indented list for readability. By default, common development directories like
.git, node_modules, and venv are noted but not traversed unless explicitly
requested. Only works within allowed directories."""
        
    @property
    @override
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.
        
        Returns:
            Parameter specifications
        """
        return {
            "properties": {
                "path": {
                    "title": "Path",
                    "type": "string",
                    "description":"The path to the directory to view"
                },
                "depth": {
                    "default": 3,
                    "title": "Depth",
                    "type": "integer",
                    "description": "The maximum depth to traverse (0 for unlimited)"
                },
                "include_filtered": {
                    "default": False,
                    "title": "Include Filtered",
                    "type": "boolean",
                    "description": "Include directories that are normally filtered"
                }
            },
            "required": ["path"],
            "title": "directory_treeArguments",
            "type": "object"
        }
        
    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return ["path"]
        
    @override
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.
        
        Args:
            ctx: MCP context
            **params: Tool parameters
            
        Returns:
            Tool result
        """
        tool_ctx = self.create_tool_context(ctx)
        
        # Extract parameters
        path = params.get("path")
        depth = params.get("depth", 3)  # Default depth is 3
        include_filtered = params.get("include_filtered", False)  # Default to False
        
        if not path:
            await tool_ctx.error("Parameter 'path' is required but was None")
            return "Error: Parameter 'path' is required but was None"

        if path.strip() == "":
            await tool_ctx.error("Parameter 'path' cannot be empty")
            return "Error: Parameter 'path' cannot be empty"

        # Validate path parameter
        path_validation = self.validate_path(path)
        if path_validation.is_error:
            await tool_ctx.error(path_validation.error_message)
            return f"Error: {path_validation.error_message}"

        await tool_ctx.info(f"Getting directory tree: {path} (depth: {depth}, include_filtered: {include_filtered})")

        # Check if path is allowed
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg

        try:
            dir_path = Path(path)

            # Check if path exists
            exists, error_msg = await self.check_path_exists(path, tool_ctx)
            if not exists:
                return error_msg
                
            # Check if path is a directory
            is_dir, error_msg = await self.check_is_directory(path, tool_ctx)
            if not is_dir:
                return error_msg

            # Define filtered directories based on common patterns and .gitignore
            FILTERED_DIRECTORIES = {
                # Hidden/dot directories
                ".git", ".github", ".gitignore", ".hg", ".svn", ".venv", ".env",
                ".idea", ".vscode", ".vs", ".cache", ".config", ".local",
                ".pytest_cache", ".ruff_cache", ".mypy_cache", ".pytype",
                ".coverage", ".tox", ".nox", ".circleci", ".llm-context",
                # Cache directories
                "__pycache__", ".ipynb_checkpoints", "htmlcov", ".eggs",
                # Build artifacts
                "dist", "build", "target", "out", "site", "coverage", 
                # Dependency directories
                "node_modules", "venv", "env", "ENV", "lib", "libs", "vendor",
                "eggs", "sdist", "wheels", "share"
            }
            
            # Log filtering settings
            await tool_ctx.info(f"Directory tree filtering: include_filtered={include_filtered}")
            
            # Try to get additional patterns from .gitignore if it exists
            gitignore_patterns = set()
            gitignore_path = dir_path / ".gitignore"
            if gitignore_path.exists() and gitignore_path.is_file():
                try:
                    with open(gitignore_path, "r") as f:
                        for line in f:
                            line = line.strip()
                            if line and not line.startswith("#"):
                                # Strip trailing slashes for directory patterns
                                if line.endswith("/"):
                                    line = line[:-1]
                                # Extract the actual pattern without path
                                pattern = line.split("/")[-1]
                                if pattern and "*" not in pattern and "?" not in pattern:
                                    gitignore_patterns.add(pattern)
                except Exception as e:
                    await tool_ctx.warning(f"Error reading .gitignore: {str(e)}")
            
            # Add gitignore patterns to filtered directories
            FILTERED_DIRECTORIES.update(gitignore_patterns)
                
            # Check if a directory should be filtered
            def should_filter(current_path: Path) -> bool:
                # Don't filter if it's the explicitly requested path
                if str(current_path.absolute()) == str(dir_path.absolute()):
                    # Don't filter explicitly requested paths
                    return False
                    
                # First check standard filtered directories
                if current_path.name in FILTERED_DIRECTORIES and not include_filtered:
                    return True
                    
                # Also filter hidden directories (dot directories) unless explicitly included
                if PathUtils.is_dot_directory(current_path) and not include_filtered:
                    return True
                    
                return False
            
            # Track stats for summary
            stats = {
                "directories": 0,
                "files": 0,
                "skipped_depth": 0,
                "skipped_filtered": 0
            }

            # Build the tree recursively
            async def build_tree(current_path: Path, current_depth: int = 0) -> list[dict[str, Any]]:
                result: list[dict[str, Any]] = []

                # Skip processing if path isn't allowed
                if not self.is_path_allowed(str(current_path)):
                    return result

                try:
                    # Sort entries: directories first, then files alphabetically
                    entries = sorted(current_path.iterdir(), key=lambda x: (not x.is_dir(), x.name))
                    
                    for entry in entries:
                        # Skip entries that aren't allowed
                        if not self.is_path_allowed(str(entry)):
                            continue

                        if entry.is_dir():
                            stats["directories"] += 1
                            entry_data: dict[str, Any] = {
                                "name": entry.name,
                                "type": "directory",
                            }

                            # Check if we should filter this directory
                            if should_filter(entry):
                                entry_data["skipped"] = "filtered-directory"
                                stats["skipped_filtered"] += 1
                                result.append(entry_data)
                                continue

                            # Check depth limit (if enabled)
                            if depth > 0 and current_depth >= depth:
                                entry_data["skipped"] = "depth-limit"
                                stats["skipped_depth"] += 1
                                result.append(entry_data)
                                continue

                            # Process children recursively with depth increment
                            entry_data["children"] = await build_tree(entry, current_depth + 1)
                            result.append(entry_data)
                        else:
                            # Files should be at the same level check as directories
                            if depth <= 0 or current_depth < depth:
                                stats["files"] += 1
                                # Add file entry
                                result.append({
                                    "name": entry.name,
                                    "type": "file"
                                })
                            
                except Exception as e:
                    await tool_ctx.warning(
                        f"Error processing {current_path}: {str(e)}"
                    )

                return result

            # Format the tree as a simple indented structure
            def format_tree(tree_data: list[dict[str, Any]], level: int = 0) -> list[str]:
                lines = []
                
                for item in tree_data:
                    # Indentation based on level
                    indent = "  " * level
                    
                    # Format based on type
                    if item["type"] == "directory":
                        if "skipped" in item:
                            lines.append(f"{indent}{item['name']}/ [skipped - {item['skipped']}]")
                        else:
                            lines.append(f"{indent}{item['name']}/")
                            # Add children with increased indentation if present
                            if "children" in item:
                                lines.extend(format_tree(item["children"], level + 1))
                    else:
                        # File
                        lines.append(f"{indent}{item['name']}")
                        
                return lines

            # Build tree starting from the requested directory
            tree_data = await build_tree(dir_path)
            
            # Format as simple text
            formatted_output = "\n".join(format_tree(tree_data))
            
            # Add stats summary
            summary = (
                f"\nDirectory Stats: {stats['directories']} directories, {stats['files']} files "
                f"({stats['skipped_depth']} skipped due to depth limit, "
                f"{stats['skipped_filtered']} filtered directories skipped)"
            )
            
            await tool_ctx.info(
                f"Generated directory tree for {path} (depth: {depth}, include_filtered: {include_filtered})"
            )
            
            return formatted_output + summary
        except Exception as e:
            await tool_ctx.error(f"Error generating directory tree: {str(e)}")
            return f"Error generating directory tree: {str(e)}"
            
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this directory tree tool with the MCP server.
        
        Creates a wrapper function with explicitly defined parameters that match
        the tool's parameter schema and registers it with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def directory_tree(ctx: MCPContext, path: str, depth: int = 3, include_filtered: bool = False) -> str:
            return await tool_self.call(ctx, path=path, depth=depth, include_filtered=include_filtered)
