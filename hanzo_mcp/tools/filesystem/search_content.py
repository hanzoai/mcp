"""Search content tool implementation.

This module provides the SearchContentTool for finding text patterns in files.
"""

import asyncio
import fnmatch
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool


def is_ripgrep_available() -> bool:
    """Check if ripgrep (rg) is available in the system path.
    
    Returns:
        True if ripgrep is available, False otherwise
    """
    return shutil.which("rg") is not None


@final
class SearchContentTool(FilesystemBaseTool):
    """Tool for searching for text patterns in files."""
    
    @property
    @override
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "search_content"
        
    @property
    @override
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return """Search for a pattern in file contents.

Similar to grep, this tool searches for text patterns within files.
Searches recursively through all files in the specified directory
that match the file pattern. Returns matching lines with file and
line number references. Only searches within allowed directories."""
        
    @property
    @override
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.
        
        Returns:
            Parameter specifications
        """
        return {
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "text pattern to search for"
                },
                "path": {
                    "type": "string",
                    "description": "path to the directory or file to search"
                },
                "file_pattern": {
                    "default": "*",
                    "type": "string"
                }
            },
            "required": ["pattern", "path"],
            "title": "search_contentArguments",
            "type": "object"
        }
        
    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return ["pattern", "path"]
        
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
        self.set_tool_context_info(tool_ctx)
        
        # Extract parameters
        pattern = params.get("pattern")
        path = params.get("path")
        file_pattern = params.get("file_pattern", "*")  # Default to all files
        
        # Validate required parameters
        if not pattern:
            await tool_ctx.error("Parameter 'pattern' is required but was None")
            return "Error: Parameter 'pattern' is required but was None"

        if pattern.strip() == "":
            await tool_ctx.error("Parameter 'pattern' cannot be empty")
            return "Error: Parameter 'pattern' cannot be empty"

        if not path:
            await tool_ctx.error("Parameter 'path' is required but was None")
            return "Error: Parameter 'path' is required but was None"

        if path.strip() == "":
            await tool_ctx.error("Parameter 'path' cannot be empty")
            return "Error: Parameter 'path' cannot be empty"

        path_validation = self.validate_path(path)
        if path_validation.is_error:
            await tool_ctx.error(path_validation.error_message)
            return f"Error: {path_validation.error_message}"

        # file_pattern can be None safely as it has a default value

        await tool_ctx.info(
            f"Searching for pattern '{pattern}' in files matching '{file_pattern}' in {path}"
        )

        # Check if path is allowed
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg

        try:
            input_path = Path(path)

            # Check if path exists
            exists, error_msg = await self.check_path_exists(path, tool_ctx)
            if not exists:
                return error_msg
                
            # Try to use ripgrep if available for faster searching
            if is_ripgrep_available():
                await tool_ctx.info("Using ripgrep for faster searching")
                try:
                    return await self._search_with_ripgrep(tool_ctx, pattern, path, file_pattern, input_path)
                except Exception as e:
                    await tool_ctx.warning(f"Error using ripgrep: {str(e)}. Falling back to standard search.")
                    return await self._search_standard(tool_ctx, pattern, path, file_pattern, input_path)
            else:
                await tool_ctx.info("Ripgrep not available, using standard search")
                return await self._search_standard(tool_ctx, pattern, path, file_pattern, input_path)
                
        except Exception as e:
            await tool_ctx.error(f"Error searching file contents: {str(e)}")
            return f"Error searching file contents: {str(e)}"
            
    async def _search_with_ripgrep(self, tool_ctx: Any, pattern: str, path: str, 
                                 file_pattern: str, input_path: Path) -> str:
        """Search using ripgrep for better performance.
        
        Args:
            tool_ctx: Tool context for logging
            pattern: Pattern to search for
            path: Path to search in
            file_pattern: File pattern to match
            input_path: Path object for the search path
            
        Returns:
            Search results
        """
        try:
            # For single file search with file pattern, check if file matches pattern first
            if input_path.is_file() and file_pattern != "*":
                if not fnmatch.fnmatch(input_path.name, file_pattern):
                    await tool_ctx.info(f"File does not match pattern '{file_pattern}': {path}")
                    return f"File does not match pattern '{file_pattern}': {path}"
                    
            # Build the ripgrep command
            rg_cmd = ["rg", "--line-number"]
            
            # Add case sensitivity (ripgrep is case sensitive by default)
            rg_cmd.append(pattern)
            
            # Handle file pattern if it's not "*"
            if file_pattern != "*":
                rg_cmd.extend(["--glob", file_pattern])
                
            # Add the path
            rg_cmd.append(str(input_path))
            
            # Use subprocess to run ripgrep
            await tool_ctx.info(f"Running ripgrep: {' '.join(rg_cmd)}")
            process = subprocess.run(rg_cmd, capture_output=True, text=True)
            
            # Process the output
            if process.returncode == 0 or process.returncode == 1:  # 0=matches found, 1=no matches
                output = process.stdout.strip()
                
                if not output:
                    if input_path.is_file():
                        return f"No matches found for pattern '{pattern}' in file: {path}"
                    else:
                        return f"No matches found for pattern '{pattern}' in files matching '{file_pattern}' in directory: {path}"
                
                # Count matches and files
                matches = output.splitlines()
                matches_found = len(matches)
                files_set = set()
                for match in matches:
                    file_path = match.split(':', 1)[0]
                    files_set.add(file_path)
                files_processed = len(files_set)
                
                result = f"Found {matches_found} matches in {files_processed} file{'s' if files_processed > 1 else ''}:\n\n"
                result += output
                
                await tool_ctx.info(f"Found {matches_found} matches in {files_processed} file(s)")
                return result
            else:
                # Error occurred
                await tool_ctx.error(f"Ripgrep error: {process.stderr}")
                # We'll fall back to standard search in the outer try-except block
                raise Exception(f"Ripgrep error: {process.stderr}")
                
        except Exception as e:
            # Let the exception propagate so the call() method can catch it
            # and handle the fallback
            raise e
    
    async def _search_standard(self, tool_ctx: Any, pattern: str, path: str,
                              file_pattern: str, input_path: Path) -> str:
        """Search using standard Python methods.
        
        Args:
            tool_ctx: Tool context for logging
            pattern: Pattern to search for
            path: Path to search in
            file_pattern: File pattern to match
            input_path: Path object for the search path
            
        Returns:
            Search results
        """
        # Find matching files using optimized file finding
        matching_files: list[Path] = []

        # Process based on whether path is a file or directory
        if input_path.is_file():
            # Single file search
            if file_pattern == "*" or fnmatch.fnmatch(input_path.name, file_pattern):
                matching_files.append(input_path)
                await tool_ctx.info(f"Searching single file: {path}")
            else:
                await tool_ctx.info(f"File does not match pattern '{file_pattern}': {path}")
                return f"File does not match pattern '{file_pattern}': {path}"
        elif input_path.is_dir():
            # Directory search - optimized file finding
            await tool_ctx.info(f"Finding files in directory: {path}")
            
            # Keep track of allowed paths for filtering
            allowed_paths: set[str] = set()
            
            # Collect all allowed paths first for faster filtering
            for entry in input_path.rglob("*"):
                entry_path = str(entry)
                if self.is_path_allowed(entry_path):
                    allowed_paths.add(entry_path)
            
            # Find matching files efficiently
            for entry in input_path.rglob("*"):
                entry_path = str(entry)
                if entry_path in allowed_paths and entry.is_file():
                    if file_pattern == "*" or fnmatch.fnmatch(entry.name, file_pattern):
                        matching_files.append(entry)
            
            await tool_ctx.info(f"Found {len(matching_files)} matching files")
        else:
            # This shouldn't happen since we already checked for existence
            await tool_ctx.error(f"Path is neither a file nor a directory: {path}")
            return f"Error: Path is neither a file nor a directory: {path}"

        # Report progress
        total_files = len(matching_files)
        if input_path.is_file():
            await tool_ctx.info(f"Searching file: {path}")
        else:
            await tool_ctx.info(f"Searching through {total_files} files in directory")

        # set up for parallel processing
        results: list[str] = []
        files_processed = 0
        matches_found = 0
        batch_size = 20  # Process files in batches to avoid overwhelming the system
        
        # Use a semaphore to limit concurrent file operations
        # Adjust the value based on system resources
        semaphore = asyncio.Semaphore(10)
        
        # Create an async function to search a single file
        async def search_file(file_path: Path) -> list[str]:
            nonlocal files_processed, matches_found
            file_results: list[str] = []
            
            try:
                async with semaphore:  # Limit concurrent operations
                    try:
                        with open(file_path, "r", encoding="utf-8") as f:
                            for line_num, line in enumerate(f, 1):
                                if re.search(pattern, line):
                                    file_results.append(
                                        f"{file_path}:{line_num}: {line.rstrip()}"
                                    )
                                    matches_found += 1
                        files_processed += 1
                    except UnicodeDecodeError:
                        # Skip binary files
                        files_processed += 1
                    except Exception as e:
                        await tool_ctx.warning(f"Error reading {file_path}: {str(e)}")
            except Exception as e:
                await tool_ctx.warning(f"Error processing {file_path}: {str(e)}")
                
            return file_results

        # Process files in parallel batches
        for i in range(0, len(matching_files), batch_size):
            batch = matching_files[i:i+batch_size]
            batch_tasks = [search_file(file_path) for file_path in batch]
            
            # Report progress
            await tool_ctx.report_progress(i, total_files)
            
            # Wait for the batch to complete
            batch_results = await asyncio.gather(*batch_tasks)
            
            # Flatten and collect results
            for file_result in batch_results:
                results.extend(file_result)

        # Final progress report
        await tool_ctx.report_progress(total_files, total_files)

        if not results:
            if input_path.is_file():
                return f"No matches found for pattern '{pattern}' in file: {path}"
            else:
                return f"No matches found for pattern '{pattern}' in files matching '{file_pattern}' in directory: {path}"

        await tool_ctx.info(
            f"Found {matches_found} matches in {files_processed} file{'s' if files_processed > 1 else ''}"
        )
        return (
            f"Found {matches_found} matches in {files_processed} file{'s' if files_processed > 1 else ''}:\n\n"
            + "\n".join(results)
        )
            
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this search content tool with the MCP server.
        
        Creates a wrapper function with explicitly defined parameters that match
        the tool's parameter schema and registers it with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def search_content(ctx: MCPContext, pattern: str, path: str, file_pattern: str = "*") -> str:
            return await tool_self.call(ctx, pattern=pattern, path=path, file_pattern=file_pattern)
