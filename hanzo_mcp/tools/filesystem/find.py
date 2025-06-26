"""Unified find tool implementation.

This module provides the FindTool for finding text patterns in files using
multiple search backends in order of preference: rg > ag > ack > grep.
"""

import asyncio
import fnmatch
import json
import re
import shlex
import shutil
from pathlib import Path
from typing import Annotated, TypedDict, Unpack, final, override, Optional, List, Dict, Any

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.context import ToolContext
from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool


# Parameter types
Pattern = Annotated[
    str,
    Field(
        description="Pattern to search for (regex or literal)",
        min_length=1,
    ),
]

SearchPath = Annotated[
    str,
    Field(
        description="Path to search in",
        default=".",
    ),
]

Include = Annotated[
    Optional[str],
    Field(
        description='File pattern to include (e.g. "*.js")',
        default=None,
    ),
]

Exclude = Annotated[
    Optional[str],
    Field(
        description='File pattern to exclude',
        default=None,
    ),
]

CaseSensitive = Annotated[
    bool,
    Field(
        description="Case sensitive search",
        default=True,
    ),
]

FixedStrings = Annotated[
    bool,
    Field(
        description="Treat pattern as literal string, not regex",
        default=False,
    ),
]

ShowContext = Annotated[
    int,
    Field(
        description="Lines of context to show around matches",
        default=0,
    ),
]

Backend = Annotated[
    Optional[str],
    Field(
        description="Force specific backend: rg, ag, ack, grep",
        default=None,
    ),
]


class FindParams(TypedDict, total=False):
    """Parameters for find tool."""
    pattern: str
    path: str
    include: Optional[str]
    exclude: Optional[str]
    case_sensitive: bool
    fixed_strings: bool
    show_context: int
    backend: Optional[str]


@final
class FindTool(FilesystemBaseTool):
    """Unified find tool with multiple backend support."""
    
    def __init__(self, permission_manager):
        """Initialize the find tool."""
        super().__init__(permission_manager)
        self._backend_order = ["rg", "ag", "ack", "grep"]
        self._available_backends = None

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "find"

    @property
    @override  
    def description(self) -> str:
        """Get the tool description."""
        backends = self._get_available_backends()
        backend_str = ", ".join(backends) if backends else "fallback grep"
        
        return f"""Find pattern in files (like ffind). Available: {backend_str}.

Usage:
find "TODO"
find "error.*fatal" ./src
find "config" --include "*.json"
find "password" --exclude "*.log"

Fast, intuitive file content search."""

    def _get_available_backends(self) -> List[str]:
        """Get list of available search backends."""
        if self._available_backends is None:
            self._available_backends = []
            for backend in self._backend_order:
                if shutil.which(backend):
                    self._available_backends.append(backend)
        return self._available_backends

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[FindParams],
    ) -> str:
        """Execute find operation."""
        tool_ctx = self.create_tool_context(ctx)

        # Extract parameters
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern is required"
            
        path = params.get("path", ".")
        include = params.get("include")
        exclude = params.get("exclude")
        case_sensitive = params.get("case_sensitive", True)
        fixed_strings = params.get("fixed_strings", False)
        show_context = params.get("show_context", 0)
        backend = params.get("backend")
        
        # Validate path
        path_validation = self.validate_path(path)
        if path_validation.is_error:
            await tool_ctx.error(path_validation.error_message)
            return f"Error: {path_validation.error_message}"

        # Check permissions
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg

        # Check existence
        exists, error_msg = await self.check_path_exists(path, tool_ctx)
        if not exists:
            return error_msg

        # Select backend
        available = self._get_available_backends()
        
        if backend:
            # User specified backend
            if backend not in available and backend != "grep":
                return f"Error: Backend '{backend}' not available. Available: {', '.join(available + ['grep'])}"
            selected_backend = backend
        elif available:
            # Use first available
            selected_backend = available[0]
        else:
            # Fallback
            selected_backend = "grep"
            
        await tool_ctx.info(f"Using {selected_backend} to search for '{pattern}' in {path}")
        
        # Execute search
        if selected_backend == "rg":
            return await self._run_ripgrep(pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx)
        elif selected_backend == "ag":
            return await self._run_silver_searcher(pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx)
        elif selected_backend == "ack":
            return await self._run_ack(pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx)
        else:
            return await self._run_fallback_grep(pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx)

    async def _run_ripgrep(self, pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx) -> str:
        """Run ripgrep backend."""
        cmd = ["rg", "--json"]
        
        if not case_sensitive:
            cmd.append("-i")
        if fixed_strings:
            cmd.append("-F")
        if show_context > 0:
            cmd.extend(["-C", str(show_context)])
        if include:
            cmd.extend(["-g", include])
        if exclude:
            cmd.extend(["-g", f"!{exclude}"])
            
        cmd.extend([pattern, path])
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await process.communicate()
            
            if process.returncode not in [0, 1]:  # 1 = no matches
                await tool_ctx.error(f"ripgrep failed: {stderr.decode()}")
                return f"Error: {stderr.decode()}"
                
            return self._parse_ripgrep_output(stdout.decode())
            
        except Exception as e:
            await tool_ctx.error(f"Error running ripgrep: {str(e)}")
            return f"Error running ripgrep: {str(e)}"

    async def _run_silver_searcher(self, pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx) -> str:
        """Run silver searcher (ag) backend."""
        cmd = ["ag", "--nocolor", "--nogroup"]
        
        if not case_sensitive:
            cmd.append("-i")
        if fixed_strings:
            cmd.append("-F")
        if show_context > 0:
            cmd.extend(["-C", str(show_context)])
        if include:
            cmd.extend(["-G", include])
        if exclude:
            cmd.extend(["--ignore", exclude])
            
        cmd.extend([pattern, path])
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await process.communicate()
            
            if process.returncode not in [0, 1]:
                await tool_ctx.error(f"ag failed: {stderr.decode()}")
                return f"Error: {stderr.decode()}"
                
            output = stdout.decode()
            if not output.strip():
                return "No matches found."
                
            lines = output.strip().split('\n')
            return f"Found {len(lines)} matches:\n\n" + output
            
        except Exception as e:
            await tool_ctx.error(f"Error running ag: {str(e)}")
            return f"Error running ag: {str(e)}"

    async def _run_ack(self, pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx) -> str:
        """Run ack backend."""
        cmd = ["ack", "--nocolor", "--nogroup"]
        
        if not case_sensitive:
            cmd.append("-i")
        if fixed_strings:
            cmd.append("-Q")
        if show_context > 0:
            cmd.extend(["-C", str(show_context)])
        if include:
            # ack uses different syntax for file patterns
            cmd.extend(["--type-add", f"custom:ext:{include.replace('*.', '')}", "--type=custom"])
            
        cmd.extend([pattern, path])
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await process.communicate()
            
            if process.returncode not in [0, 1]:
                await tool_ctx.error(f"ack failed: {stderr.decode()}")
                return f"Error: {stderr.decode()}"
                
            output = stdout.decode()
            if not output.strip():
                return "No matches found."
                
            lines = output.strip().split('\n')
            return f"Found {len(lines)} matches:\n\n" + output
            
        except Exception as e:
            await tool_ctx.error(f"Error running ack: {str(e)}")
            return f"Error running ack: {str(e)}"

    async def _run_fallback_grep(self, pattern, path, include, exclude, case_sensitive, fixed_strings, show_context, tool_ctx) -> str:
        """Fallback Python implementation."""
        await tool_ctx.info("Using fallback Python grep implementation")
        
        try:
            input_path = Path(path)
            matching_files = []
            
            # Get files to search
            if input_path.is_file():
                if self._match_file_pattern(input_path.name, include, exclude):
                    matching_files.append(input_path)
            else:
                for entry in input_path.rglob("*"):
                    if entry.is_file() and self.is_path_allowed(str(entry)):
                        if self._match_file_pattern(entry.name, include, exclude):
                            matching_files.append(entry)
            
            if not matching_files:
                return "No matching files found."
            
            # Compile pattern
            if fixed_strings:
                pattern_re = re.escape(pattern)
            else:
                pattern_re = pattern
                
            if not case_sensitive:
                flags = re.IGNORECASE
            else:
                flags = 0
                
            regex = re.compile(pattern_re, flags)
            
            # Search files
            results = []
            total_matches = 0
            
            for file_path in matching_files:
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        lines = f.readlines()
                        
                    for i, line in enumerate(lines, 1):
                        if regex.search(line):
                            # Format result with context if requested
                            if show_context > 0:
                                start = max(0, i - show_context - 1)
                                end = min(len(lines), i + show_context)
                                
                                context_lines = []
                                for j in range(start, end):
                                    prefix = ":" if j + 1 == i else "-"
                                    context_lines.append(f"{file_path}:{j+1}{prefix}{lines[j].rstrip()}")
                                results.extend(context_lines)
                                results.append("")  # Separator
                            else:
                                results.append(f"{file_path}:{i}:{line.rstrip()}")
                            total_matches += 1
                            
                except UnicodeDecodeError:
                    pass  # Skip binary files
                except Exception as e:
                    await tool_ctx.warning(f"Error reading {file_path}: {str(e)}")
            
            if not results:
                return "No matches found."
                
            return f"Found {total_matches} matches:\n\n" + "\n".join(results)
            
        except Exception as e:
            await tool_ctx.error(f"Error in fallback grep: {str(e)}")
            return f"Error in fallback grep: {str(e)}"

    def _match_file_pattern(self, filename: str, include: Optional[str], exclude: Optional[str]) -> bool:
        """Check if filename matches include/exclude patterns."""
        if include and not fnmatch.fnmatch(filename, include):
            return False
        if exclude and fnmatch.fnmatch(filename, exclude):
            return False
        return True

    def _parse_ripgrep_output(self, output: str) -> str:
        """Parse ripgrep JSON output."""
        if not output.strip():
            return "No matches found."
            
        results = []
        total_matches = 0
        
        for line in output.splitlines():
            if not line.strip():
                continue
                
            try:
                data = json.loads(line)
                
                if data.get("type") == "match":
                    match_data = data.get("data", {})
                    path = match_data.get("path", {}).get("text", "")
                    line_number = match_data.get("line_number", 0)
                    line_text = match_data.get("lines", {}).get("text", "").rstrip()
                    
                    results.append(f"{path}:{line_number}:{line_text}")
                    total_matches += 1
                    
                elif data.get("type") == "context":
                    context_data = data.get("data", {})
                    path = context_data.get("path", {}).get("text", "")
                    line_number = context_data.get("line_number", 0)
                    line_text = context_data.get("lines", {}).get("text", "").rstrip()
                    
                    results.append(f"{path}:{line_number}-{line_text}")
                    
            except json.JSONDecodeError:
                pass
                
        if not results:
            return "No matches found."
            
        return f"Found {total_matches} matches:\n\n" + "\n".join(results)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass