"""Symbols tool implementation.

This module provides the SymbolsTool for searching, indexing, and querying code symbols
using tree-sitter AST parsing. It can find function definitions, class declarations,
and other code structures with full context.
"""

import os
from pathlib import Path
from typing import Annotated, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server import FastMCP
from grep_ast.grep_ast import TreeContext
from pydantic import Field

from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool

Pattern = Annotated[
    str,
    Field(
        description="The regex pattern to search for in source code files",
        min_length=1,
    ),
]

SearchPath = Annotated[
    str,
    Field(
        description="The path to search in (file or directory)",
        min_length=1,
    ),
]

IgnoreCase = Annotated[
    bool,
    Field(
        description="Whether to ignore case when matching",
        default=False,
    ),
]

LineNumber = Annotated[
    bool,
    Field(
        description="Whether to display line numbers",
        default=False,
    ),
]


class GrepAstToolParams(TypedDict):
    """Parameters for the GrepAstTool.

    Attributes:
        pattern: The regex pattern to search for in source code files
        path: The path to search in (file or directory)
        ignore_case: Whether to ignore case when matching
        line_number: Whether to display line numbers
    """

    pattern: Pattern
    path: SearchPath
    ignore_case: IgnoreCase
    line_number: LineNumber


@final
class SymbolsTool(FilesystemBaseTool):
    """Tool for searching and querying code symbols using tree-sitter AST parsing."""

    @property
    @override
    def name(self) -> str:
        """Get the tool name.

        Returns:
            Tool name
        """
        return "symbols"

    @property
    @override
    def description(self) -> str:
        """Get the tool description.

        Returns:
            Tool description
        """
        return """Code symbols search with tree-sitter AST. Actions: search (default), index, query.

Usage:
symbols "function_name" ./src
symbols --action index --path ./src
symbols --action query --type function --path ./src

Finds code structures (functions, classes, methods) with full context."""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GrepAstToolParams],
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
        pattern: Pattern = params["pattern"]
        path: SearchPath = params["path"]
        ignore_case = params.get("ignore_case", False)
        line_number = params.get("line_number", False)

        # Validate the path
        path_validation = self.validate_path(path)
        if not path_validation.is_valid:
            await tool_ctx.error(f"Invalid path: {path_validation.error_message}")
            return f"Error: Invalid path: {path_validation.error_message}"

        # Check if path is allowed
        is_allowed, error_message = await self.check_path_allowed(path, tool_ctx)
        if not is_allowed:
            return error_message

        # Check if path exists
        is_exists, error_message = await self.check_path_exists(path, tool_ctx)
        if not is_exists:
            return error_message

        await tool_ctx.info(f"Searching for '{pattern}' in {path}")

        # Get the files to process
        path_obj = Path(path)
        files_to_process = []

        if path_obj.is_file():
            files_to_process.append(str(path_obj))
        elif path_obj.is_dir():
            for root, _, files in os.walk(path_obj):
                for file in files:
                    file_path = Path(root) / file
                    if self.is_path_allowed(str(file_path)):
                        files_to_process.append(str(file_path))

        if not files_to_process:
            await tool_ctx.warning(f"No source code files found in {path}")
            return f"No source code files found in {path}"

        # Process each file
        results = []
        processed_count = 0

        await tool_ctx.info(f"Found {len(files_to_process)} file(s) to process")

        for file_path in files_to_process:
            await tool_ctx.report_progress(processed_count, len(files_to_process))

            try:
                # Read the file
                with open(file_path, "r", encoding="utf-8") as f:
                    code = f.read()

                # Process the file with grep-ast
                try:
                    tc = TreeContext(
                        file_path,
                        code,
                        color=False,
                        verbose=False,
                        line_number=line_number,
                    )

                    # Find matches
                    loi = tc.grep(pattern, ignore_case)

                    if loi:
                        tc.add_lines_of_interest(loi)
                        tc.add_context()
                        output = tc.format()

                        # Add the result to our list
                        results.append(f"\n{file_path}:\n{output}\n")
                except Exception as e:
                    # Skip files that can't be parsed by tree-sitter
                    await tool_ctx.warning(f"Could not parse {file_path}: {str(e)}")
            except UnicodeDecodeError:
                await tool_ctx.warning(f"Could not read {file_path} as text")
            except Exception as e:
                await tool_ctx.error(f"Error processing {file_path}: {str(e)}")

            processed_count += 1

        # Final progress report
        await tool_ctx.report_progress(len(files_to_process), len(files_to_process))

        if not results:
            await tool_ctx.warning(f"No matches found for '{pattern}' in {path}")
            return f"No matches found for '{pattern}' in {path}"

        await tool_ctx.info(f"Found matches in {len(results)} file(s)")

        # Join the results
        return "\n".join(results)

    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this tool with the MCP server.

        Creates a wrapper function with explicitly defined parameters that match
        the tool's parameter schema and registers it with the MCP server.

        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure

        @mcp_server.tool(name=self.name, description=self.description)
        async def symbols(
            ctx: MCPContext,
            pattern: Pattern,
            path: SearchPath,
            ignore_case: IgnoreCase = False,
            line_number: LineNumber = False
        ) -> str:
            return await tool_self.call(
                ctx,
                pattern=pattern,
                path=path,
                ignore_case=ignore_case,
                line_number=line_number,
            )
