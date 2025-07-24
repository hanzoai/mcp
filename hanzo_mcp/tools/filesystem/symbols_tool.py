"""Unified symbols tool implementation.

This module provides the SymbolsTool for searching, indexing, and querying code symbols
using tree-sitter AST parsing. It can find function definitions, class declarations,
and other code structures with full context.
"""

import os
from pathlib import Path
from typing import Annotated, TypedDict, Unpack, final, override, Optional, List, Dict, Any
import json

from mcp.server.fastmcp import Context as MCPContext
from grep_ast.grep_ast import TreeContext
from pydantic import Field

from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action: search (default), ast, index, query, list",
        default="search",
    ),
]

Pattern = Annotated[
    Optional[str],
    Field(
        description="Pattern to search for in code",
        default=None,
    ),
]

SearchPath = Annotated[
    str,
    Field(
        description="Path to search/index (file or directory)",
        default=".",
    ),
]

SymbolType = Annotated[
    Optional[str],
    Field(
        description="Symbol type: function, class, method, variable",
        default=None,
    ),
]

IgnoreCase = Annotated[
    bool,
    Field(
        description="Ignore case when matching",
        default=False,
    ),
]

ShowContext = Annotated[
    bool,
    Field(
        description="Show AST context around matches",
        default=True,
    ),
]

Limit = Annotated[
    int,
    Field(
        description="Maximum results to return",
        default=50,
    ),
]


class SymbolsParams(TypedDict, total=False):
    """Parameters for symbols tool."""
    action: str
    pattern: Optional[str]
    path: str
    symbol_type: Optional[str]
    ignore_case: bool
    show_context: bool
    limit: int


@final
class SymbolsTool(FilesystemBaseTool):
    """Tool for code symbol operations using tree-sitter."""
    
    def __init__(self, permission_manager):
        """Initialize the symbols tool."""
        super().__init__(permission_manager)
        self._symbol_cache = {}  # Cache for indexed symbols

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "symbols"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Code symbols search with tree-sitter AST. Actions: search (default), ast, index, query, list.

Usage:
symbols "function_name"
symbols --action ast --pattern "TODO" --path ./src
symbols --action query --symbol-type function --path ./src
symbols --action index --path ./project
symbols --action list --path ./src --symbol-type class

Finds code structures (functions, classes, methods) with full context."""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[SymbolsParams],
    ) -> str:
        """Execute symbols operation."""
        tool_ctx = self.create_tool_context(ctx)
        self.set_tool_context_info(tool_ctx)

        # Extract action
        action = params.get("action", "search")
        
        # Route to appropriate handler
        if action == "search":
            return await self._handle_search(params, tool_ctx)
        elif action == "ast" or action == "grep_ast":  # Support both for backward compatibility
            return await self._handle_ast(params, tool_ctx)
        elif action == "index":
            return await self._handle_index(params, tool_ctx)
        elif action == "query":
            return await self._handle_query(params, tool_ctx)
        elif action == "list":
            return await self._handle_list(params, tool_ctx)
        else:
            return f"Error: Unknown action '{action}'. Valid actions: search, ast, index, query, list"

    async def _handle_search(self, params: Dict[str, Any], tool_ctx) -> str:
        """Search for pattern in code with AST context."""
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern required for search action"
        
        path = params.get("path", ".")
        ignore_case = params.get("ignore_case", False)
        show_context = params.get("show_context", True)
        limit = params.get("limit", 50)
        
        # Validate path
        path_validation = self.validate_path(path)
        if not path_validation.is_valid:
            await tool_ctx.error(f"Invalid path: {path_validation.error_message}")
            return f"Error: Invalid path: {path_validation.error_message}"

        # Check permissions
        is_allowed, error_message = await self.check_path_allowed(path, tool_ctx)
        if not is_allowed:
            return error_message

        # Check existence
        is_exists, error_message = await self.check_path_exists(path, tool_ctx)
        if not is_exists:
            return error_message

        await tool_ctx.info(f"Searching for '{pattern}' in {path}")

        # Get files to process
        files_to_process = self._get_source_files(path)
        if not files_to_process:
            return f"No source code files found in {path}"

        # Process files
        results = []
        match_count = 0
        
        for file_path in files_to_process:
            if match_count >= limit:
                break
                
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    code = f.read()

                tc = TreeContext(
                    file_path,
                    code,
                    color=False,
                    verbose=False,
                    line_number=True,
                )

                # Find matches
                loi = tc.grep(pattern, ignore_case)
                
                if loi:
                    if show_context:
                        tc.add_lines_of_interest(loi)
                        tc.add_context()
                        output = tc.format()
                    else:
                        # Just show matching lines
                        output = "\n".join([f"{line}: {code.splitlines()[line-1]}" for line in loi])
                    
                    results.append(f"\n{file_path}:\n{output}\n")
                    match_count += len(loi)
                    
            except Exception as e:
                await tool_ctx.warning(f"Could not parse {file_path}: {str(e)}")

        if not results:
            return f"No matches found for '{pattern}' in {path}"

        output = [f"=== Symbol Search Results for '{pattern}' ==="]
        output.append(f"Found {match_count} matches in {len(results)} files\n")
        output.extend(results)
        
        if match_count >= limit:
            output.append(f"\n(Results limited to {limit} matches)")
        
        return "\n".join(output)

    async def _handle_ast(self, params: Dict[str, Any], tool_ctx) -> str:
        """AST-aware grep - shows code structure context around matches."""
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern required for ast action"

        path = params.get("path", ".")
        ignore_case = params.get("ignore_case", False)
        show_context = params.get("show_context", True)
        limit = params.get("limit", 50)

        # Validate path
        path_validation = self.validate_path(path)
        if not path_validation.is_valid:
            await tool_ctx.error(f"Invalid path: {path_validation.error_message}")
            return f"Error: Invalid path: {path_validation.error_message}"

        # Check permissions
        is_allowed, error_message = await self.check_path_allowed(path, tool_ctx)
        if not is_allowed:
            return error_message

        # Check existence
        is_exists, error_message = await self.check_path_exists(path, tool_ctx)
        if not is_exists:
            return error_message

        await tool_ctx.info(f"Running AST-aware grep for '{pattern}' in {path}")

        # Get files to process
        files_to_process = self._get_source_files(path)
        if not files_to_process:
            return f"No source code files found in {path}"

        # Process files
        results = []
        match_count = 0
        
        for file_path in files_to_process:
            if match_count >= limit:
                break

            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    code = f.read()

                # Create TreeContext for AST parsing
                tc = TreeContext(
                    file_path,
                    code,
                    color=False,
                    verbose=False,
                    line_number=True,
                )

                # Find matches with case sensitivity option
                if ignore_case:
                    import re
                    loi = tc.grep(pattern, ignore_case=True)
                else:
                    loi = tc.grep(pattern, ignore_case=False)

                if loi:
                    # Always show AST context for grep_ast
                    tc.add_lines_of_interest(loi)
                    tc.add_context()
                    
                    # Get the formatted output with structure
                    output = tc.format()
                    
                    # Add section separator and file info
                    results.append(f"\n{'='*60}")
                    results.append(f"File: {file_path}")
                    results.append(f"Matches: {len(loi)}")
                    results.append(f"{'='*60}\n")
                    results.append(output)
                    
                    match_count += len(loi)

            except Exception as e:
                await tool_ctx.warning(f"Could not parse {file_path}: {str(e)}")

        if not results:
            return f"No matches found for '{pattern}' in {path}"

        output = [f"=== AST-aware Grep Results for '{pattern}' ==="]
        output.append(f"Total matches: {match_count} in {len([r for r in results if '===' in str(r)])//4} files\n")
        output.extend(results)

        if match_count >= limit:
            output.append(f"\n(Results limited to {limit} matches)")

        return "\n".join(output)

    async def _handle_index(self, params: Dict[str, Any], tool_ctx) -> str:
        """Index symbols in a codebase."""
        path = params.get("path", ".")
        
        # Validate path
        is_allowed, error_message = await self.check_path_allowed(path, tool_ctx)
        if not is_allowed:
            return error_message

        await tool_ctx.info(f"Indexing symbols in {path}...")
        
        files_to_process = self._get_source_files(path)
        if not files_to_process:
            return f"No source code files found in {path}"

        # Clear cache for this path
        self._symbol_cache[path] = {
            "functions": [],
            "classes": [],
            "methods": [],
            "variables": [],
        }
        
        indexed_count = 0
        symbol_count = 0
        
        for file_path in files_to_process:
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    code = f.read()

                tc = TreeContext(file_path, code, color=False, verbose=False)
                
                # Extract symbols (simplified - would need proper tree-sitter queries)
                # This is a placeholder for actual symbol extraction
                symbols = self._extract_symbols(tc, file_path)
                
                for symbol_type, syms in symbols.items():
                    self._symbol_cache[path][symbol_type].extend(syms)
                    symbol_count += len(syms)
                
                indexed_count += 1
                
            except Exception as e:
                await tool_ctx.warning(f"Could not index {file_path}: {str(e)}")

        output = [f"=== Symbol Indexing Complete ==="]
        output.append(f"Indexed {indexed_count} files")
        output.append(f"Found {symbol_count} total symbols:")
        
        for symbol_type, symbols in self._symbol_cache[path].items():
            if symbols:
                output.append(f"  {symbol_type}: {len(symbols)}")
        
        return "\n".join(output)

    async def _handle_query(self, params: Dict[str, Any], tool_ctx) -> str:
        """Query indexed symbols."""
        path = params.get("path", ".")
        symbol_type = params.get("symbol_type")
        pattern = params.get("pattern")
        limit = params.get("limit", 50)
        
        # Check if we have indexed this path
        if path not in self._symbol_cache:
            return f"No symbols indexed for {path}. Run 'symbols --action index --path {path}' first."
        
        symbols = self._symbol_cache[path]
        results = []
        
        # Filter by type if specified
        if symbol_type:
            if symbol_type in symbols:
                candidates = symbols[symbol_type]
            else:
                return f"Unknown symbol type: {symbol_type}. Valid types: {', '.join(symbols.keys())}"
        else:
            # Combine all symbol types
            candidates = []
            for syms in symbols.values():
                candidates.extend(syms)
        
        # Filter by pattern if specified
        if pattern:
            filtered = []
            for sym in candidates:
                if pattern.lower() in sym["name"].lower():
                    filtered.append(sym)
            candidates = filtered
        
        # Limit results
        candidates = candidates[:limit]
        
        if not candidates:
            return "No symbols found matching criteria"
        
        output = [f"=== Symbol Query Results ==="]
        output.append(f"Found {len(candidates)} symbols\n")
        
        for sym in candidates:
            output.append(f"{sym['type']}: {sym['name']}")
            output.append(f"  File: {sym['file']}:{sym['line']}")
            if sym.get("signature"):
                output.append(f"  Signature: {sym['signature']}")
            output.append("")
        
        return "\n".join(output)

    async def _handle_list(self, params: Dict[str, Any], tool_ctx) -> str:
        """List all symbols in a path."""
        # Similar to query but shows all symbols
        params["pattern"] = None
        return await self._handle_query(params, tool_ctx)

    def _get_source_files(self, path: str) -> List[str]:
        """Get all source code files in a path."""
        path_obj = Path(path)
        files_to_process = []
        
        # Common source file extensions
        extensions = {
            ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".cpp", ".c", ".h", 
            ".hpp", ".cs", ".rb", ".go", ".rs", ".swift", ".kt", ".scala",
            ".php", ".lua", ".r", ".jl", ".ex", ".exs", ".clj", ".cljs"
        }
        
        if path_obj.is_file():
            if path_obj.suffix in extensions:
                files_to_process.append(str(path_obj))
        elif path_obj.is_dir():
            for root, _, files in os.walk(path_obj):
                for file in files:
                    file_path = Path(root) / file
                    if file_path.suffix in extensions and self.is_path_allowed(str(file_path)):
                        files_to_process.append(str(file_path))
        
        return files_to_process

    def _extract_symbols(self, tc: TreeContext, file_path: str) -> Dict[str, List[Dict[str, Any]]]:
        """Extract symbols from a TreeContext (placeholder implementation)."""
        # This would need proper tree-sitter queries to extract symbols
        # For now, return empty structure
        return {
            "functions": [],
            "classes": [],
            "methods": [],
            "variables": [],
        }

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass