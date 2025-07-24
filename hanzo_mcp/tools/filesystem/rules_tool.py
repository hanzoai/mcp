"""Rules tool implementation.

This module provides the RulesTool for reading local preferences from .cursor rules 
or .claude code configuration files.
"""

import json
import os
from pathlib import Path
from typing import Annotated, TypedDict, Unpack, final, override, Optional

from mcp.server.fastmcp import Context as MCPContext
from mcp.server import FastMCP
from pydantic import Field

from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool


SearchPath = Annotated[
    str,
    Field(
        description="Directory path to search for configuration files (defaults to current directory)",
        default=".",
    ),
]


class RulesToolParams(TypedDict, total=False):
    """Parameters for the RulesTool.

    Attributes:
        path: Directory path to search for configuration files
    """

    path: str


@final
class RulesTool(FilesystemBaseTool):
    """Tool for reading local preferences from configuration files."""

    @property
    @override
    def name(self) -> str:
        """Get the tool name.

        Returns:
            Tool name
        """
        return "rules"

    @property
    @override
    def description(self) -> str:
        """Get the tool description.

        Returns:
            Tool description
        """
        return """Read local preferences and rules from .cursor/rules or .claude/code configuration files.

This tool searches for and reads configuration files that contain project-specific
preferences, coding standards, and rules for AI assistants.

Searches for (in order of priority):
1. .cursorrules in current directory
2. .cursor/rules in current directory
3. .claude/code.md in current directory
4. .claude/rules.md in current directory
5. Recursively searches parent directories up to project root

Usage:
rules                    # Search from current directory
rules --path /project    # Search from specific directory

The tool returns the contents of all found configuration files to help
understand project-specific requirements and preferences."""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[RulesToolParams],
    ) -> str:
        """Execute the tool with the given parameters.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Tool result
        """
        tool_ctx = self.create_tool_context(ctx)
        self.set_tool_context_info(tool_ctx)

        # Extract parameters
        search_path = params.get("path", ".")

        # Validate path
        path_validation = self.validate_path(search_path)
        if not path_validation.is_valid:
            await tool_ctx.error(f"Invalid path: {path_validation.error_message}")
            return f"Error: Invalid path: {path_validation.error_message}"

        # Check permissions
        is_allowed, error_message = await self.check_path_allowed(search_path, tool_ctx)
        if not is_allowed:
            return error_message

        # Check existence
        is_exists, error_message = await self.check_path_exists(search_path, tool_ctx)
        if not is_exists:
            return error_message

        # Convert to Path object
        start_path = Path(search_path).resolve()
        
        # Configuration files to search for
        config_files = [
            ".cursorrules",
            ".cursor/rules",
            ".cursor/rules.md",
            ".claude/code.md",
            ".claude/rules.md",
            ".claude/config.md",
        ]
        
        found_configs = []
        
        # Search in current directory and parent directories
        current_path = start_path
        while True:
            for config_file in config_files:
                config_path = current_path / config_file
                
                # Check if file exists and we have permission
                if config_path.exists() and config_path.is_file():
                    try:
                        # Check permissions for this specific file
                        if self.is_path_allowed(str(config_path)):
                            with open(config_path, "r", encoding="utf-8") as f:
                                content = f.read()
                            
                            found_configs.append({
                                "path": str(config_path),
                                "relative_path": str(config_path.relative_to(start_path)),
                                "content": content,
                                "size": len(content)
                            })
                            
                            await tool_ctx.info(f"Found configuration: {config_path}")
                    except Exception as e:
                        await tool_ctx.warning(f"Could not read {config_path}: {str(e)}")
            
            # Check if we've reached the root or a git repository root
            if current_path.parent == current_path:
                break
                
            # Check if this is a git repository root
            if (current_path / ".git").exists():
                # Search one more time in the git root before stopping
                if current_path != start_path:
                    for config_file in config_files:
                        config_path = current_path / config_file
                        if config_path.exists() and config_path.is_file() and str(config_path) not in [c["path"] for c in found_configs]:
                            try:
                                if self.is_path_allowed(str(config_path)):
                                    with open(config_path, "r", encoding="utf-8") as f:
                                        content = f.read()
                                    
                                    found_configs.append({
                                        "path": str(config_path),
                                        "relative_path": str(config_path.relative_to(start_path)),
                                        "content": content,
                                        "size": len(content)
                                    })
                                    
                                    await tool_ctx.info(f"Found configuration: {config_path}")
                            except Exception as e:
                                await tool_ctx.warning(f"Could not read {config_path}: {str(e)}")
                break
                
            # Move to parent directory
            parent = current_path.parent
            
            # Check if parent is still within allowed paths
            if not self.is_path_allowed(str(parent)):
                await tool_ctx.info(f"Stopped at directory boundary: {parent}")
                break
                
            current_path = parent
        
        # Format results
        if not found_configs:
            return f"""No configuration files found.

Searched for:
{chr(10).join('- ' + cf for cf in config_files)}

Starting from: {start_path}

To create project rules, create one of these files with your preferences:
- .cursorrules: For Cursor IDE rules
- .cursor/rules: Alternative Cursor location  
- .claude/code.md: For Claude-specific coding preferences
- .claude/rules.md: For general Claude interaction rules"""
        
        # Build output
        output = [f"=== Found {len(found_configs)} Configuration File(s) ===\n"]
        
        for i, config in enumerate(found_configs, 1):
            output.append(f"--- [{i}] {config['path']} ({config['size']} bytes) ---")
            output.append(config['content'])
            output.append("")  # Empty line between configs
        
        output.append(f"\nSearched from: {start_path}")
        
        return "\n".join(output)

    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this rules tool with the MCP server.

        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure

        @mcp_server.tool(name=self.name, description=self.description)
        async def rules(
            path: SearchPath = ".",
            ctx: MCPContext = None,
        ) -> str:
            return await tool_self.call(ctx, path=path)
