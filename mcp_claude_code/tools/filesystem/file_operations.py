"""File operations tools for MCP Claude Code.

This module provides tools for reading, writing, and editing files.
"""

from pathlib import Path
from typing import final

from mcp.server.fastmcp import Context as MCPContext, FastMCP

from mcp_claude_code.context import DocumentContext
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.common.context import ToolContext, create_tool_context


@final
class FileOperations:
    """File operations tools for MCP Claude Code."""
    
    def __init__(self, 
                 document_context: DocumentContext, 
                 permission_manager: PermissionManager) -> None:
        """Initialize file operations.
        
        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context: DocumentContext = document_context
        self.permission_manager: PermissionManager = permission_manager
    
    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register file operation tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        # FileRead tool for reading file contents
        @mcp_server.tool()
        async def file_read_tool(file_path: str, ctx: MCPContext) -> str:
            """Read the contents of a file.
            
            Args:
                file_path: Path to the file to read
                ctx: MCP context for logging and progress tracking
                
            Returns:
                The contents of the file
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("file_read")
            tool_ctx.info(f"Reading file: {file_path}")
            
            # Check if file is allowed to be read
            if not self.permission_manager.is_path_allowed(file_path):
                tool_ctx.error(f"File not allowed to be read: {file_path}")
                return f"Error: File not allowed to be read: {file_path}"
                
            try:
                path = Path(file_path)
                
                if not path.exists():
                    tool_ctx.error(f"File does not exist: {file_path}")
                    return f"File does not exist: {file_path}"
                
                if not path.is_file():
                    tool_ctx.error(f"Path is not a file: {file_path}")
                    return f"Path is not a file: {file_path}"
                
                # Read the file
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    # Add to document context
                    self.document_context.add_document(file_path, content)
                    
                    tool_ctx.info(f"Successfully read file: {file_path} ({len(content)} bytes)")
                    return f"Contents of {file_path}:\n\n{content}"
                except UnicodeDecodeError:
                    tool_ctx.error(f"Cannot read binary file: {file_path}")
                    return f"Cannot read binary file: {file_path}"
            except Exception as e:
                tool_ctx.error(f"Error reading file: {str(e)}")
                return f"Error reading file: {str(e)}"
        
        # FileEdit tool for editing files
        @mcp_server.tool()
        async def file_edit_tool(file_path: str, old_text: str, new_text: str, ctx: MCPContext) -> str:
            """Edit a file by replacing text.
            
            Args:
                file_path: Path to the file to edit
                old_text: Text to replace
                new_text: New text to insert
                ctx: MCP context for logging and progress tracking
                
            Returns:
                Result of the edit operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("file_edit")
            tool_ctx.info(f"Editing file: {file_path}")
            
            # Check if file is allowed to be edited
            if not self.permission_manager.is_path_allowed(file_path):
                tool_ctx.error(f"File not allowed to be edited: {file_path}")
                return f"Error: File not allowed to be edited: {file_path}"
                
            # Check if file edit permission has been granted
            if not self.permission_manager.is_operation_approved(file_path, "edit"):
                # Request permission
                tool_ctx.info(f"Requesting permission to edit file: {file_path}")
                self.permission_manager.approve_operation(file_path, "edit")
                return f"Permission requested to edit file: {file_path}\nPlease approve the edit operation and try again."
            
            try:
                path = Path(file_path)
                
                if not path.exists():
                    tool_ctx.error(f"File does not exist: {file_path}")
                    return f"File does not exist: {file_path}"
                
                if not path.is_file():
                    tool_ctx.error(f"Path is not a file: {file_path}")
                    return f"Path is not a file: {file_path}"
                
                # Read the file
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    # Check if old_text exists in content
                    if old_text not in content:
                        tool_ctx.error(f"Text to replace not found in file: {file_path}")
                        return f"Text to replace not found in file: {file_path}"
                    
                    # Count replacements for logging
                    count = content.count(old_text)
                    
                    # Replace text
                    new_content = content.replace(old_text, new_text)
                    
                    # Write the file
                    with open(path, 'w', encoding='utf-8') as f:
                        _ = f.write(new_content)  # Explicitly ignore the return value
                    
                    # Update in document context
                    self.document_context.update_document(file_path, new_content)
                    
                    tool_ctx.info(f"Successfully edited file: {file_path} ({count} replacements)")
                    return f"Successfully edited file: {file_path} ({count} replacements)"
                except UnicodeDecodeError:
                    tool_ctx.error(f"Cannot edit binary file: {file_path}")
                    return f"Cannot edit binary file: {file_path}"
            except Exception as e:
                tool_ctx.error(f"Error editing file: {str(e)}")
                return f"Error editing file: {str(e)}"
        
        # FileWrite tool for creating or overwriting files
        @mcp_server.tool()
        async def file_write_tool(file_path: str, content: str, ctx: MCPContext) -> str:
            """Create or overwrite a file with content.
            
            Args:
                file_path: Path to the file to write
                content: Content to write to the file
                ctx: MCP context for logging and progress tracking
                
            Returns:
                Result of the write operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("file_write")
            tool_ctx.info(f"Writing file: {file_path}")
            
            # Check if file is allowed to be written
            if not self.permission_manager.is_path_allowed(file_path):
                tool_ctx.error(f"File not allowed to be written: {file_path}")
                return f"Error: File not allowed to be written: {file_path}"
                
            # Check if file write permission has been granted
            if not self.permission_manager.is_operation_approved(file_path, "write"):
                # Request permission
                tool_ctx.info(f"Requesting permission to write file: {file_path}")
                self.permission_manager.approve_operation(file_path, "write")
                return f"Permission requested to write file: {file_path}\nPlease approve the write operation and try again."
            
            try:
                path = Path(file_path)
                
                # Check if parent directory is allowed
                parent_dir = str(path.parent)
                if not self.permission_manager.is_path_allowed(parent_dir):
                    tool_ctx.error(f"Parent directory not allowed: {parent_dir}")
                    return f"Error: Parent directory not allowed: {parent_dir}"
                
                # Create parent directories if they don't exist
                path.parent.mkdir(parents=True, exist_ok=True)
                
                # Write the file
                with open(path, 'w', encoding='utf-8') as f:
                    _ = f.write(content)  # Explicitly ignore the return value
                
                # Add to document context
                self.document_context.add_document(file_path, content)
                
                tool_ctx.info(f"Successfully wrote file: {file_path} ({len(content)} bytes)")
                return f"Successfully wrote file: {file_path}"
            except Exception as e:
                tool_ctx.error(f"Error writing file: {str(e)}")
                return f"Error writing file: {str(e)}"
