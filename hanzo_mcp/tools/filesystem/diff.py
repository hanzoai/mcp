"""Diff tool for comparing files."""

import difflib
from pathlib import Path
from typing import Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from mcp.server import FastMCP


class DiffTool(BaseTool):
    """Tool for comparing files and showing differences."""
    
    name = "diff"
    
    def __init__(self, permission_manager: PermissionManager):
        """Initialize the diff tool.
        
        Args:
            permission_manager: Permission manager for access control
        """
        super().__init__()
        self.permission_manager = permission_manager
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Compare files and show differences. Supports unified and context diff formats.

Usage:
diff file1.py file2.py
diff old_version.js new_version.js --context 5
diff before.txt after.txt --unified
diff a.json b.json --ignore-whitespace"""
    
    @override
    async def run(
        self,
        ctx: MCPContext,
        file1: str,
        file2: str,
        unified: bool = True,
        context: int = 3,
        ignore_whitespace: bool = False,
        show_line_numbers: bool = True,
    ) -> str:
        """Compare two files and show differences.
        
        Args:
            ctx: MCP context
            file1: Path to first file
            file2: Path to second file
            unified: Use unified diff format (default: True)
            context: Number of context lines to show (default: 3)
            ignore_whitespace: Ignore whitespace differences (default: False)
            show_line_numbers: Show line numbers in output (default: True)
            
        Returns:
            Diff output showing differences between files
        """
        # Resolve file paths
        path1 = Path(file1).expanduser().resolve()
        path2 = Path(file2).expanduser().resolve()
        
        # Check permissions
        if not self.permission_manager.is_path_allowed(str(path1)):
            raise PermissionError(f"Access denied to path: {path1}")
        if not self.permission_manager.is_path_allowed(str(path2)):
            raise PermissionError(f"Access denied to path: {path2}")
        
        # Check if files exist
        if not path1.exists():
            raise ValueError(f"File not found: {path1}")
        if not path2.exists():
            raise ValueError(f"File not found: {path2}")
        
        # Read file contents
        try:
            with open(path1, 'r', encoding='utf-8') as f:
                lines1 = f.readlines()
        except Exception as e:
            raise RuntimeError(f"Error reading {path1}: {e}")
        
        try:
            with open(path2, 'r', encoding='utf-8') as f:
                lines2 = f.readlines()
        except Exception as e:
            raise RuntimeError(f"Error reading {path2}: {e}")
        
        # Optionally normalize whitespace
        if ignore_whitespace:
            lines1 = [line.strip() + '\n' for line in lines1]
            lines2 = [line.strip() + '\n' for line in lines2]
        
        # Generate diff
        if unified:
            #  diff format
            diff_lines = list(difflib.unified_diff(
                lines1,
                lines2,
                fromfile=str(path1),
                tofile=str(path2),
                n=context,
                lineterm=''
            ))
        else:
            # Context diff format
            diff_lines = list(difflib.context_diff(
                lines1,
                lines2,
                fromfile=str(path1),
                tofile=str(path2),
                n=context,
                lineterm=''
            ))
        
        if not diff_lines:
            return f"Files {path1.name} and {path2.name} are identical"
        
        # Format output
        output = []
        
        # Add header
        output.append(f"Comparing: {path1.name} vs {path2.name}")
        output.append("=" * 60)
        
        # Add diff with optional line numbers
        if show_line_numbers and unified:
            # Parse unified diff to add line numbers
            current_line1 = 0
            current_line2 = 0
            
            for line in diff_lines:
                if line.startswith('@@'):
                    # Parse hunk header
                    parts = line.split()
                    if len(parts) >= 3:
                        # Extract line numbers
                        old_info = parts[1].strip('-').split(',')
                        new_info = parts[2].strip('+').split(',')
                        current_line1 = int(old_info[0]) - 1
                        current_line2 = int(new_info[0]) - 1
                    output.append(line)
                elif line.startswith('-'):
                    current_line1 += 1
                    output.append(f"{current_line1:4d}- {line[1:]}")
                elif line.startswith('+'):
                    current_line2 += 1
                    output.append(f"{current_line2:4d}+ {line[1:]}")
                elif line.startswith(' '):
                    current_line1 += 1
                    current_line2 += 1
                    output.append(f"{current_line1:4d}  {line[1:]}")
                else:
                    output.append(line)
        else:
            # Standard diff output
            output.extend(diff_lines)
        
        # Add summary
        additions = sum(1 for line in diff_lines if line.startswith('+') and not line.startswith('+++'))
        deletions = sum(1 for line in diff_lines if line.startswith('-') and not line.startswith('---'))
        
        output.append("")
        output.append("=" * 60)
        output.append(f"Summary: {additions} additions, {deletions} deletions")
        
        return '\n'.join(output)

    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        tool_self = self
        
        @server.tool(name=self.name, description=self.description)
        async def diff_handler(
            ctx: MCPContext,
            file1: str,
            file2: str,
            unified: bool = True,
            context: int = 3,
            ignore_whitespace: bool = False,
            show_line_numbers: bool = True
        ) -> str:
            """Handle diff tool calls."""
            return await tool_self.run(
                ctx,
                file1=file1,
                file2=file2,
                unified=unified,
                context=context,
                ignore_whitespace=ignore_whitespace,
                show_line_numbers=show_line_numbers,
            )
    
    async def call(self, ctx: MCPContext, **params) -> str:
        """Call the tool with arguments."""
        return await self.run(
            ctx,
            file1=params["file1"],
            file2=params["file2"],
            unified=params.get("unified", True),
            context=params.get("context", 3),
            ignore_whitespace=params.get("ignore_whitespace", False),
            show_line_numbers=params.get("show_line_numbers", True)
        )


# Create tool instance (requires permission manager to be set)
def create_diff_tool(permission_manager: PermissionManager) -> DiffTool:
    """Create a diff tool instance.
    
    Args:
        permission_manager: Permission manager for access control
        
    Returns:
        Configured diff tool instance
    """
    return DiffTool(permission_manager)