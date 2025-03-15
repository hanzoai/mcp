"""Filesystem navigation and search tools for MCP Claude Code.

This module provides tools for listing directories, finding files,
and searching file contents.
"""

from pathlib import Path
from typing import final

from mcp.server.fastmcp import Context as MCPContext, FastMCP

from mcp_claude_code.context import DocumentContext
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.common.context import ToolContext, create_tool_context


@final
class FilesystemNavigation:
    """Filesystem navigation and search tools for MCP Claude Code."""
    
    def __init__(self, 
                 document_context: DocumentContext, 
                 permission_manager: PermissionManager) -> None:
        """Initialize filesystem navigation.
        
        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context: DocumentContext = document_context
        self.permission_manager: PermissionManager = permission_manager
    
    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register filesystem navigation tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        # Glob tool for finding files
        @mcp_server.tool()
        async def glob_tool(pattern: str, ctx: MCPContext, root_dir: str = ".") -> str:
            """Find files matching a glob pattern.
            
            Args:
                pattern: The glob pattern to match
                ctx: MCP context for logging and progress tracking
                root_dir: Optional root directory for the search
                
            Returns:
                A list of matching files
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("glob")
            tool_ctx.info(f"Finding files matching pattern '{pattern}' in '{root_dir}'")
            
            # Check if root directory is allowed
            if not self.permission_manager.is_path_allowed(root_dir):
                tool_ctx.error(f"Root directory not allowed: {root_dir}")
                return f"Error: Root directory not allowed: {root_dir}"
                
            try:
                # Expand the pattern and find files
                root_path = Path(root_dir)
                if pattern.startswith("/") or pattern.startswith("\\"):
                    tool_ctx.error("Pattern should be relative, not absolute")
                    return "Error: Pattern should be relative, not absolute"
                    
                # Find files matching the pattern
                found_files = list(root_path.glob(pattern))
                
                # Filter out files that aren't allowed
                allowed_files: list[Path] = []
                for file in found_files:
                    if self.permission_manager.is_path_allowed(str(file)):
                        allowed_files.append(file)
                
                # Format the results
                if not allowed_files:
                    tool_ctx.info(f"No files found matching pattern: {pattern}")
                    return f"No files found matching pattern: {pattern} in {root_dir}"
                
                tool_ctx.info(f"Found {len(allowed_files)} files matching pattern: {pattern}")
                result = f"Found {len(allowed_files)} files matching pattern: {pattern}\n\n"
                for file in allowed_files:
                    result += f"- {file}\n"
                
                return result
            except Exception as e:
                tool_ctx.error(f"Error finding files: {str(e)}")
                return f"Error finding files: {str(e)}"
        
        # Grep tool for searching file contents
        @mcp_server.tool()
        async def grep_tool(pattern: str, 
                           ctx: MCPContext, 
                           file_pattern: str = "*", 
                           root_dir: str = ".") -> str:
            """Search for a pattern in file contents.
            
            Args:
                pattern: The pattern to search for
                ctx: MCP context for logging and progress tracking
                file_pattern: Optional glob pattern to filter files
                root_dir: Optional root directory for the search
                
            Returns:
                Matching lines from files
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("grep")
            tool_ctx.info(f"Searching for pattern '{pattern}' in files matching '{file_pattern}' in '{root_dir}'")
            
            # Check if root directory is allowed
            if not self.permission_manager.is_path_allowed(root_dir):
                tool_ctx.error(f"Root directory not allowed: {root_dir}")
                return f"Error: Root directory not allowed: {root_dir}"
                
            try:
                results: list[str] = []
                root_path = Path(root_dir)
                
                # Ensure file pattern is relative
                if file_pattern.startswith("/") or file_pattern.startswith("\\"):
                    tool_ctx.error("File pattern should be relative, not absolute")
                    return "Error: File pattern should be relative, not absolute"
                
                files = list(root_path.glob(file_pattern))
                
                # Filter files that are allowed to be accessed
                allowed_files: list[Path] = []
                for file in files:
                    if self.permission_manager.is_path_allowed(str(file)) and file.is_file():
                        allowed_files.append(file)
                
                # Report progress on the number of files being processed
                total_files = len(allowed_files)
                tool_ctx.info(f"Processing {total_files} files")
                
                # Perform the search
                for i, file in enumerate(allowed_files):
                    if i % 10 == 0:  # Report progress every 10 files
                        await tool_ctx.report_progress(i, total_files)
                        
                    try:
                        with open(file, 'r', encoding='utf-8') as f:
                            for line_num, line in enumerate(f, 1):
                                if pattern in line:
                                    results.append(f"{file}:{line_num}: {line.strip()}")
                    except UnicodeDecodeError:
                        # Skip binary files
                        continue
                
                # Final progress report
                await tool_ctx.report_progress(total_files, total_files)
                
                if not results:
                    tool_ctx.info(f"No matches found for pattern '{pattern}'")
                    return f"No matches found for pattern '{pattern}' in files matching '{file_pattern}' in {root_dir}"
                
                # Add document to context for future reference
                for file in allowed_files:
                    try:
                        with open(file, 'r', encoding='utf-8') as f:
                            content = f.read()
                        self.document_context.add_document(str(file), content)
                    except UnicodeDecodeError:
                        # Skip binary files
                        continue
                
                tool_ctx.info(f"Found {len(results)} matches")
                return f"Found {len(results)} matches:\n\n" + "\n".join(results)
            except Exception as e:
                tool_ctx.error(f"Error searching files: {str(e)}")
                return f"Error searching files: {str(e)}"
        
        # LS tool for listing files and directories
        @mcp_server.tool()
        async def ls_tool(ctx: MCPContext, path: str = ".") -> str:
            """List files and directories.
            
            Args:
                ctx: MCP context for logging and progress tracking
                path: The directory path to list
                
            Returns:
                A list of files and directories
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("ls")
            tool_ctx.info(f"Listing directory: {path}")
            
            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                tool_ctx.error(f"Path not allowed: {path}")
                return f"Error: Path not allowed: {path}"
                
            try:
                dir_path = Path(path)
                
                if not dir_path.exists():
                    tool_ctx.error(f"Path does not exist: {path}")
                    return f"Path does not exist: {path}"
                
                if not dir_path.is_dir():
                    tool_ctx.error(f"Path is not a directory: {path}")
                    return f"Path is not a directory: {path}"
                
                # list directory contents
                contents = list(dir_path.iterdir())
                
                # Filter contents based on permissions
                allowed_contents: list[Path] = []
                for item in contents:
                    if self.permission_manager.is_path_allowed(str(item)):
                        allowed_contents.append(item)
                
                # Format the results
                dirs = [f"📁 {item.name}/" for item in allowed_contents if item.is_dir()]
                files = [f"📄 {item.name}" for item in allowed_contents if item.is_file()]
                
                result = f"Contents of {dir_path}:\n\n"
                
                if dirs:
                    result += "Directories:\n" + "\n".join(sorted(dirs)) + "\n\n"
                
                if files:
                    result += "Files:\n" + "\n".join(sorted(files))
                
                if not dirs and not files:
                    result += "Directory is empty or no accessible contents."
                
                tool_ctx.info(f"Listed {len(dirs)} directories and {len(files)} files")
                return result
            except Exception as e:
                tool_ctx.error(f"Error listing directory: {str(e)}")
                return f"Error listing directory: {str(e)}"
        
        # Search and replace tool
        @mcp_server.tool()
        async def search_replace_tool(
            pattern: str, 
            replacement: str, 
            ctx: MCPContext,
            file_pattern: str = "*.py",
            root_dir: str = "."
        ) -> str:
            """Search and replace text across multiple files.
            
            Args:
                pattern: The text pattern to search for
                replacement: The replacement text
                ctx: MCP context for logging and progress tracking
                file_pattern: Optional glob pattern to filter files
                root_dir: Optional root directory for the search
                
            Returns:
                Results of the search and replace operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("search_replace")
            tool_ctx.info(f"Searching for pattern '{pattern}' and replacing with '{replacement}' in files matching '{file_pattern}' in '{root_dir}'")
            
            # Check if root directory is allowed
            if not self.permission_manager.is_path_allowed(root_dir):
                tool_ctx.error(f"Root directory not allowed: {root_dir}")
                return f"Error: Root directory not allowed: {root_dir}"
            
            # Ensure file pattern is relative
            if file_pattern.startswith("/") or file_pattern.startswith("\\"):
                tool_ctx.error("File pattern should be relative, not absolute")
                return "Error: File pattern should be relative, not absolute"
            
            try:
                # Find matching files
                root_path = Path(root_dir)
                matching_files = list(root_path.glob(file_pattern))
                
                # Filter files that are allowed to be accessed and modified
                allowed_files: list[Path] = []
                for file in matching_files:
                    if (self.permission_manager.is_path_allowed(str(file)) and 
                        file.is_file() and 
                        self.permission_manager.is_operation_approved(str(file), "edit")):
                        allowed_files.append(file)
                
                if not allowed_files:
                    tool_ctx.error(f"No files found that can be modified")
                    return f"No files found matching pattern: {file_pattern} in {root_dir} that can be modified"
                
                # Process files
                results: list[str] = []
                modified_count = 0
                total_replacements = 0
                
                # Report progress on the number of files being processed
                total_files = len(allowed_files)
                tool_ctx.info(f"Processing {total_files} files")
                
                for i, file in enumerate(allowed_files):
                    # Report progress
                    await tool_ctx.report_progress(i, total_files)
                    
                    try:
                        with open(file, 'r', encoding='utf-8') as f:
                            content = f.read()
                        
                        # Count occurrences and replace
                        occurrences = content.count(pattern)
                        if occurrences > 0:
                            new_content = content.replace(pattern, replacement)
                            
                            # Write the file
                            with open(file, 'w', encoding='utf-8') as f:
                                _ = f.write(new_content)  # Explicitly ignore the return value
                            
                            # Update document context
                            self.document_context.update_document(str(file), new_content)
                            
                            results.append(f"{file}: {occurrences} replacements")
                            modified_count += 1
                            total_replacements += occurrences
                    except UnicodeDecodeError:
                        # Skip binary files
                        continue
                    except Exception as e:
                        results.append(f"{file}: Error - {str(e)}")
                
                # Final progress report
                await tool_ctx.report_progress(total_files, total_files)
                
                if total_replacements == 0:
                    tool_ctx.info(f"No occurrences of '{pattern}' found")
                    return f"No occurrences of '{pattern}' found in files matching '{file_pattern}' in {root_dir}"
                
                tool_ctx.info(f"Replaced {total_replacements} occurrences in {modified_count} files")
                summary = f"Replaced {total_replacements} occurrences of '{pattern}' with '{replacement}' in {modified_count} files:\n\n"
                return summary + "\n".join(results)
            except Exception as e:
                tool_ctx.error(f"Error during search and replace: {str(e)}")
                return f"Error during search and replace: {str(e)}"
