"""Write file tool implementation.

This module provides the WriteFileTool for creating or overwriting files.
"""

from pathlib import Path
from typing import Any, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from mcp_claude_code.tools.filesystem.base import FilesystemBaseTool


@final
class WriteFileTool(FilesystemBaseTool):
    """Tool for writing file contents."""
    
    @property
    @override
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "write_file"
        
    @property
    @override
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return """Create a new file or completely overwrite an existing file with new content.

Use with caution as it will overwrite existing files without warning.
Handles text content with proper encoding. Only works within allowed directories."""
        
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
                    "type": "string",
                    "description": "path to the file to write"
                },
                "content": {
                    "type": "string",
                    "description": "content to write to the file"
                }
            },
            "required": ["path", "content"],
            "type": "object"
        }
        
    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return ["path", "content"]
        
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
        path = params.get("path")
        content = params.get("content")

        if not path:
            await tool_ctx.error("Parameter 'path' is required but was None")
            return "Error: Parameter 'path' is required but was None"

        if path.strip() == "":
            await tool_ctx.error("Parameter 'path' cannot be empty")
            return "Error: Parameter 'path' cannot be empty"

        # Validate parameters
        path_validation = self.validate_path(path)
        if path_validation.is_error:
            await tool_ctx.error(path_validation.error_message)
            return f"Error: {path_validation.error_message}"

        if not content:
            await tool_ctx.error("Parameter 'content' is required but was None")
            return "Error: Parameter 'content' is required but was None"

        await tool_ctx.info(f"Writing file: {path}")

        # Check if file is allowed to be written
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg

        # Additional check already verified by is_path_allowed above
        await tool_ctx.info(f"Writing file: {path}")

        try:
            file_path = Path(path)

            # Check if parent directory is allowed
            parent_dir = str(file_path.parent)
            if not self.is_path_allowed(parent_dir):
                await tool_ctx.error(f"Parent directory not allowed: {parent_dir}")
                return f"Error: Parent directory not allowed: {parent_dir}"

            # Create parent directories if they don't exist
            file_path.parent.mkdir(parents=True, exist_ok=True)

            # Write the file
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)

            # Add to document context
            self.document_context.add_document(path, content)

            await tool_ctx.info(
                f"Successfully wrote file: {path} ({len(content)} bytes)"
            )
            return f"Successfully wrote file: {path} ({len(content)} bytes)"
        except Exception as e:
            await tool_ctx.error(f"Error writing file: {str(e)}")
            return f"Error writing file: {str(e)}"
            
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this tool with the MCP server.
        
        Creates a wrapper function with explicitly defined parameters that match
        the tool's parameter schema and registers it with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def write_file(path: str, content: str, ctx: MCPContext) -> str:
            return await tool_self.call(ctx, path=path, content=content)
