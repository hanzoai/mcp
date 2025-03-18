"""Filesystem operations tools for MCP Claude Code.

This module provides comprehensive tools for interacting with the filesystem,
including reading, writing, editing files, directory operations, and searching.
All operations are secured through permission validation and path checking.
"""

import json
import time
from difflib import unified_diff
from pathlib import Path
from typing import Any, final

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from mcp_claude_code.tools.common.context import (DocumentContext,
                                                  create_tool_context)
from mcp_claude_code.tools.common.permissions import PermissionManager


@final
class FileOperations:
    """File and filesystem operations tools for MCP Claude Code."""

    def __init__(
        self, document_context: DocumentContext, permission_manager: PermissionManager
    ) -> None:
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

        # Read file tool
        @mcp_server.tool()
        async def read_file(path: str, ctx: MCPContext) -> str:
            """Read the complete contents of a file from the file system.

            Handles various text encodings and provides detailed error messages
            if the file cannot be read. Use this tool when you need to examine
            the contents of a single file. Only works within allowed directories.

            Args:
                path: Path to the file to read

            Returns:
                The contents of the file
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("read_file")
            await tool_ctx.info(f"Reading file: {path}")

            # Check if file is allowed to be read
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            try:
                file_path = Path(path)

                if not file_path.exists():
                    await tool_ctx.error(f"File does not exist: {path}")
                    return f"Error: File does not exist: {path}"

                if not file_path.is_file():
                    await tool_ctx.error(f"Path is not a file: {path}")
                    return f"Error: Path is not a file: {path}"

                # Read the file
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        content = f.read()

                    # Add to document context
                    self.document_context.add_document(path, content)

                    await tool_ctx.info(
                        f"Successfully read file: {path} ({len(content)} bytes)"
                    )
                    return content
                except UnicodeDecodeError:
                    # Try with different encoding
                    try:
                        with open(file_path, "r", encoding="latin-1") as f:
                            content = f.read()
                        await tool_ctx.warning(
                            f"File read with latin-1 encoding: {path}"
                        )
                        return content
                    except Exception:
                        await tool_ctx.error(f"Cannot read binary file: {path}")
                        return f"Error: Cannot read binary file: {path}"
            except Exception as e:
                await tool_ctx.error(f"Error reading file: {str(e)}")
                return f"Error reading file: {str(e)}"

        # Read multiple files tool
        @mcp_server.tool()
        async def read_multiple_files(paths: list[str], ctx: MCPContext) -> str:
            """Read the contents of multiple files simultaneously.

            This is more efficient than reading files one by one when you need to analyze
            or compare multiple files. Each file's content is returned with its path as
            a reference. Failed reads for individual files won't stop the entire operation.
            Only works within allowed directories.

            Args:
                paths: List of file paths to read

            Returns:
                Contents of all files with path references
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("read_multiple_files")
            await tool_ctx.info(f"Reading {len(paths)} files")

            results: list[str] = []

            # Read each file
            for i, path in enumerate(paths):
                # Report progress
                await tool_ctx.report_progress(i, len(paths))

                # Check if path is allowed
                if not self.permission_manager.is_path_allowed(path):
                    results.append(
                        f"{path}: Error - Access denied - path outside allowed directories"
                    )
                    continue

                try:
                    file_path = Path(path)

                    if not file_path.exists():
                        results.append(f"{path}: Error - File does not exist")
                        continue

                    if not file_path.is_file():
                        results.append(f"{path}: Error - Path is not a file")
                        continue

                    # Read the file
                    try:
                        with open(file_path, "r", encoding="utf-8") as f:
                            content = f.read()

                        # Add to document context
                        self.document_context.add_document(path, content)

                        results.append(f"{path}:\n{content}")
                    except UnicodeDecodeError:
                        try:
                            with open(file_path, "r", encoding="latin-1") as f:
                                content = f.read()
                            results.append(f"{path} (latin-1 encoding):\n{content}")
                        except Exception:
                            results.append(f"{path}: Error - Cannot read binary file")
                except Exception as e:
                    results.append(f"{path}: Error - {str(e)}")

            # Final progress report
            await tool_ctx.report_progress(len(paths), len(paths))

            await tool_ctx.info(f"Read {len(paths)} files")
            return "\n\n---\n\n".join(results)

        # Write file tool
        @mcp_server.tool()
        async def write_file(path: str, content: str, ctx: MCPContext) -> str:
            """Create a new file or completely overwrite an existing file with new content.

            Use with caution as it will overwrite existing files without warning.
            Handles text content with proper encoding. Only works within allowed directories.

            Args:
                path: Path to the file to write
                content: Content to write to the file

            Returns:
                Result of the write operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("write_file")
            await tool_ctx.info(f"Writing file: {path}")

            # Check if file is allowed to be written
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            # Additional check already verified by is_path_allowed above
            await tool_ctx.info(f"Writing file: {path}")

            try:
                file_path = Path(path)

                # Check if parent directory is allowed
                parent_dir = str(file_path.parent)
                if not self.permission_manager.is_path_allowed(parent_dir):
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

        # Edit file tool
        @mcp_server.tool()
        async def edit_file(
            path: str, edits: list[dict[str, str]], dry_run: bool, ctx: MCPContext
        ) -> str:
            """Make line-based edits to a text file.

            Each edit replaces exact line sequences with new content.
            Returns a git-style diff showing the changes made.
            Only works within allowed directories.

            Args:
                path: Path to the file to edit
                edits: List of edit operations [{"oldText": "...", "newText": "..."}]
                dry_run: Preview changes without applying them (default: False)

            Returns:
                Git-style diff of the changes
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("edit_file")
            await tool_ctx.info(f"Editing file: {path}")

            # Check if file is allowed to be edited
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            # Additional check already verified by is_path_allowed above
            await tool_ctx.info(f"Editing file: {path}")

            try:
                file_path = Path(path)

                if not file_path.exists():
                    await tool_ctx.error(f"File does not exist: {path}")
                    return f"Error: File does not exist: {path}"

                if not file_path.is_file():
                    await tool_ctx.error(f"Path is not a file: {path}")
                    return f"Error: Path is not a file: {path}"

                # Read the file
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        original_content = f.read()

                    # Apply edits
                    modified_content = original_content
                    edits_applied = 0

                    for edit in edits:
                        old_text = edit.get("oldText", "")
                        new_text = edit.get("newText", "")

                        if old_text in modified_content:
                            modified_content = modified_content.replace(
                                old_text, new_text
                            )
                            edits_applied += 1
                        else:
                            # Try line-by-line matching for whitespace flexibility
                            old_lines = old_text.splitlines()
                            content_lines = modified_content.splitlines()

                            for i in range(len(content_lines) - len(old_lines) + 1):
                                current_chunk = content_lines[i : i + len(old_lines)]

                                # Compare with whitespace normalization
                                matches = all(
                                    old_line.strip() == content_line.strip()
                                    for old_line, content_line in zip(
                                        old_lines, current_chunk
                                    )
                                )

                                if matches:
                                    # Replace the matching lines
                                    new_lines = new_text.splitlines()
                                    content_lines[i : i + len(old_lines)] = new_lines
                                    modified_content = "\n".join(content_lines)
                                    edits_applied += 1
                                    break

                    if edits_applied < len(edits):
                        await tool_ctx.warning(
                            f"Some edits could not be applied: {edits_applied}/{len(edits)}"
                        )

                    # Generate diff
                    original_lines = original_content.splitlines(keepends=True)
                    modified_lines = modified_content.splitlines(keepends=True)

                    diff_lines = list(
                        unified_diff(
                            original_lines,
                            modified_lines,
                            fromfile=f"{path} (original)",
                            tofile=f"{path} (modified)",
                            n=3,
                        )
                    )

                    diff_text = "".join(diff_lines)

                    # Determine the number of backticks needed
                    num_backticks = 3
                    while f"```{num_backticks}" in diff_text:
                        num_backticks += 1

                    # Format diff with appropriate number of backticks
                    formatted_diff = (
                        f"```{num_backticks}diff\n{diff_text}```{num_backticks}\n"
                    )

                    # Write the file if not a dry run
                    if not dry_run and diff_text:  # Only write if there are changes
                        with open(file_path, "w", encoding="utf-8") as f:
                            f.write(modified_content)

                        # Update document context
                        self.document_context.update_document(path, modified_content)

                        await tool_ctx.info(
                            f"Successfully edited file: {path} ({edits_applied} edits applied)"
                        )
                        return f"Successfully edited file: {path} ({edits_applied} edits applied)\n\n{formatted_diff}"
                    elif not diff_text:
                        return f"No changes made to file: {path}"
                    else:
                        await tool_ctx.info(
                            f"Dry run: {edits_applied} edits would be applied"
                        )
                        return f"Dry run: {edits_applied} edits would be applied\n\n{formatted_diff}"
                except UnicodeDecodeError:
                    await tool_ctx.error(f"Cannot edit binary file: {path}")
                    return f"Error: Cannot edit binary file: {path}"
            except Exception as e:
                await tool_ctx.error(f"Error editing file: {str(e)}")
                return f"Error editing file: {str(e)}"

        # Create directory tool
        @mcp_server.tool()
        async def create_directory(path: str, ctx: MCPContext) -> str:
            """Create a new directory or ensure a directory exists.

            Can create multiple nested directories in one operation.
            If the directory already exists, this operation will succeed silently.
            Only works within allowed directories.

            Args:
                path: Path to the directory to create

            Returns:
                Result of the operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("create_directory")
            await tool_ctx.info(f"Creating directory: {path}")

            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            # Additional check already verified by is_path_allowed above
            await tool_ctx.info(f"Creating directory: {path}")

            try:
                dir_path = Path(path)

                # Create the directory
                dir_path.mkdir(parents=True, exist_ok=True)

                await tool_ctx.info(f"Successfully created directory: {path}")
                return f"Successfully created directory: {path}"
            except Exception as e:
                await tool_ctx.error(f"Error creating directory: {str(e)}")
                return f"Error creating directory: {str(e)}"

        # List directory tool
        @mcp_server.tool()
        async def list_directory(path: str, ctx: MCPContext) -> str:
            """Get a detailed listing of all files and directories in a specified path.

            Results clearly distinguish between files and directories with [FILE] and [DIR]
            prefixes. This tool is essential for understanding directory structure and
            finding specific files within a directory. Only works within allowed directories.

            Args:
                path: Path to the directory to list

            Returns:
                List of files and directories with type indicators
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("list_directory")
            await tool_ctx.info(f"Listing directory: {path}")

            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            try:
                dir_path = Path(path)

                if not dir_path.exists():
                    await tool_ctx.error(f"Directory does not exist: {path}")
                    return f"Error: Directory does not exist: {path}"

                if not dir_path.is_dir():
                    await tool_ctx.error(f"Path is not a directory: {path}")
                    return f"Error: Path is not a directory: {path}"

                # List directory contents
                entries: list[str] = []

                for entry in dir_path.iterdir():
                    # Skip entries that aren't allowed
                    if not self.permission_manager.is_path_allowed(str(entry)):
                        continue

                    entry_type = "[DIR]" if entry.is_dir() else "[FILE]"
                    entries.append(f"{entry_type} {entry.name}")

                # Sort entries (directories first, then files)
                dir_entries = sorted([e for e in entries if e.startswith("[DIR]")])
                file_entries = sorted([e for e in entries if e.startswith("[FILE]")])

                sorted_entries = dir_entries + file_entries

                if not sorted_entries:
                    return f"Directory is empty or contains no allowed entries: {path}"

                await tool_ctx.info(f"Listed {len(sorted_entries)} entries in {path}")
                return "\n".join(sorted_entries)
            except Exception as e:
                await tool_ctx.error(f"Error listing directory: {str(e)}")
                return f"Error listing directory: {str(e)}"

        # Directory tree tool
        @mcp_server.tool()
        async def directory_tree(path: str, ctx: MCPContext) -> str:
            """Get a recursive tree view of files and directories as a JSON structure.

            Each entry includes 'name', 'type' (file/directory), and 'children' for directories.
            Files have no children array, while directories always have a children array
            (which may be empty). The output is formatted with 2-space indentation for
            readability. Only works within allowed directories.

            Args:
                path: Path to the directory to traverse

            Returns:
                JSON structure representing the directory tree
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("directory_tree")
            await tool_ctx.info(f"Getting directory tree: {path}")

            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            try:
                dir_path = Path(path)

                if not dir_path.exists():
                    await tool_ctx.error(f"Directory does not exist: {path}")
                    return f"Error: Directory does not exist: {path}"

                if not dir_path.is_dir():
                    await tool_ctx.error(f"Path is not a directory: {path}")
                    return f"Error: Path is not a directory: {path}"

                # Build the tree recursively
                async def build_tree(current_path: Path) -> list[dict[str, Any]]:
                    result: list[dict[str, Any]] = []

                    # Skip processing if path isn't allowed
                    if not self.permission_manager.is_path_allowed(str(current_path)):
                        return result

                    try:
                        for entry in current_path.iterdir():
                            # Skip entries that aren't allowed
                            if not self.permission_manager.is_path_allowed(str(entry)):
                                continue

                            entry_data: dict[str, Any] = {
                                "name": entry.name,
                                "type": "directory" if entry.is_dir() else "file",
                            }

                            if entry.is_dir():
                                entry_data["children"] = await build_tree(entry)

                            result.append(entry_data)
                    except Exception as e:
                        await tool_ctx.warning(
                            f"Error processing {current_path}: {str(e)}"
                        )

                    # Sort entries (directories first, then files)
                    return sorted(
                        result,
                        key=lambda x: (0 if x["type"] == "directory" else 1, x["name"]),
                    )

                tree_data = await build_tree(dir_path)

                await tool_ctx.info(f"Generated directory tree for {path}")
                return json.dumps(tree_data, indent=2)
            except Exception as e:
                await tool_ctx.error(f"Error generating directory tree: {str(e)}")
                return f"Error generating directory tree: {str(e)}"

        # Move file tool
        @mcp_server.tool()
        async def move_file(source: str, destination: str, ctx: MCPContext) -> str:
            """Move or rename files and directories.

            Can move files between directories and rename them in a single operation.
            If the destination exists, the operation will fail. Works across different
            directories and can be used for simple renaming within the same directory.
            Both source and destination must be within allowed directories.

            Args:
                source: Source path
                destination: Destination path


            Returns:
                Result of the move operation
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("move_file")
            await tool_ctx.info(f"Moving {source} to {destination}")

            # Check if source and destination are allowed
            if not self.permission_manager.is_path_allowed(source):
                await tool_ctx.error(
                    f"Access denied - source path outside allowed directories: {source}"
                )
                return f"Error: Access denied - source path outside allowed directories: {source}"

            if not self.permission_manager.is_path_allowed(destination):
                await tool_ctx.error(
                    f"Access denied - destination path outside allowed directories: {destination}"
                )
                return f"Error: Access denied - destination path outside allowed directories: {destination}"

            # Additional check already verified by is_path_allowed above
            await tool_ctx.info(f"Moving {source} to {destination}")

            try:
                source_path = Path(source)
                dest_path = Path(destination)

                if not source_path.exists():
                    await tool_ctx.error(f"Source does not exist: {source}")
                    return f"Error: Source does not exist: {source}"

                if dest_path.exists():
                    await tool_ctx.error(f"Destination already exists: {destination}")
                    return f"Error: Destination already exists: {destination}"

                # Create parent directory if it doesn't exist
                dest_path.parent.mkdir(parents=True, exist_ok=True)

                # Move the file or directory
                if source_path.is_file():
                    # Read the file content for document context
                    try:
                        with open(source_path, "r", encoding="utf-8") as f:
                            content = f.read()

                        # Update document context after move
                        self.document_context.remove_document(source)
                        self.document_context.add_document(destination, content)
                    except UnicodeDecodeError:
                        # Binary file, just skip document context update
                        pass

                # Perform the move
                source_path.rename(dest_path)

                await tool_ctx.info(f"Successfully moved {source} to {destination}")
                return f"Successfully moved {source} to {destination}"
            except Exception as e:
                await tool_ctx.error(f"Error moving file: {str(e)}")
                return f"Error moving file: {str(e)}"

        # Get file info tool
        @mcp_server.tool()
        async def get_file_info(path: str, ctx: MCPContext) -> str:
            """Retrieve detailed metadata about a file or directory.

            Returns comprehensive information including size, creation time,
            last modified time, permissions, and type. This tool is perfect for
            understanding file characteristics without reading the actual content.
            Only works within allowed directories.

            Args:
                path: Path to the file or directory


            Returns:
                Detailed metadata about the file or directory
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("get_file_info")
            await tool_ctx.info(f"Getting file info: {path}")

            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            try:
                file_path = Path(path)

                if not file_path.exists():
                    await tool_ctx.error(f"Path does not exist: {path}")
                    return f"Error: Path does not exist: {path}"

                # Get file stats
                stats = file_path.stat()

                # Format timestamps
                created_time = time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(stats.st_ctime)
                )
                modified_time = time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(stats.st_mtime)
                )
                accessed_time = time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(stats.st_atime)
                )

                # Format permissions in octal
                permissions = oct(stats.st_mode)[-3:]

                # Build info dictionary
                file_info: dict[str, Any] = {
                    "name": file_path.name,
                    "type": "directory" if file_path.is_dir() else "file",
                    "size": stats.st_size,
                    "created": created_time,
                    "modified": modified_time,
                    "accessed": accessed_time,
                    "permissions": permissions,
                }

                # Format the output
                result = [f"{key}: {value}" for key, value in file_info.items()]

                await tool_ctx.info(f"Retrieved info for {path}")
                return "\n".join(result)
            except Exception as e:
                await tool_ctx.error(f"Error getting file info: {str(e)}")
                return f"Error getting file info: {str(e)}"

        # List allowed directories tool
        @mcp_server.tool()
        async def list_allowed_directories(ctx: MCPContext) -> str:
            """Returns the list of directories that this server is allowed to access.

            Use this to understand which directories are available before trying to access files.

            Returns:
                List of allowed directories
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("list_allowed_directories")
            await tool_ctx.info("Listing allowed directories")

            # Get allowed paths from permission manager
            allowed_paths = [
                str(path) for path in self.permission_manager.allowed_paths
            ]

            if not allowed_paths:
                return "No directories are currently allowed."

            await tool_ctx.info(f"Listed {len(allowed_paths)} allowed directories")
            return "Allowed directories:\n" + "\n".join(allowed_paths)

        # Search content tool (grep-like functionality)
        @mcp_server.tool()
        async def search_content(
            ctx: MCPContext, pattern: str, path: str, file_pattern: str = "*"
        ) -> str:
            """Search for a pattern in file contents.

            Similar to grep, this tool searches for text patterns within files.
            Searches recursively through all files in the specified directory
            that match the file pattern. Returns matching lines with file and
            line number references. Only searches within allowed directories.

            Args:
                pattern: Text pattern to search for
                path: Directory to search in
                file_pattern: File pattern to match (e.g., "*.py" for Python files)

            Returns:
                Matching lines with file and line number references
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("search_content")
            await tool_ctx.info(
                f"Searching for pattern '{pattern}' in files matching '{file_pattern}' in {path}"
            )

            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            try:
                dir_path = Path(path)

                if not dir_path.exists():
                    await tool_ctx.error(f"Path does not exist: {path}")
                    return f"Error: Path does not exist: {path}"

                if not dir_path.is_dir():
                    await tool_ctx.error(f"Path is not a directory: {path}")
                    return f"Error: Path is not a directory: {path}"

                # Find matching files
                matching_files: list[Path] = []

                # Recursive function to find files
                async def find_files(current_path: Path) -> None:
                    # Skip if not allowed
                    if not self.permission_manager.is_path_allowed(str(current_path)):
                        return

                    try:
                        for entry in current_path.iterdir():
                            # Skip if not allowed
                            if not self.permission_manager.is_path_allowed(str(entry)):
                                continue

                            if entry.is_file():
                                # Check if file matches pattern
                                if file_pattern == "*" or entry.match(file_pattern):
                                    matching_files.append(entry)
                            elif entry.is_dir():
                                # Recurse into directory
                                await find_files(entry)
                    except Exception as e:
                        await tool_ctx.warning(
                            f"Error accessing {current_path}: {str(e)}"
                        )

                # Find all matching files
                await find_files(dir_path)

                # Report progress
                total_files = len(matching_files)
                await tool_ctx.info(f"Searching through {total_files} files")

                # Search through files
                results: list[str] = []
                files_processed = 0
                matches_found = 0

                for i, file_path in enumerate(matching_files):
                    # Report progress every 10 files
                    if i % 10 == 0:
                        await tool_ctx.report_progress(i, total_files)

                    try:
                        with open(file_path, "r", encoding="utf-8") as f:
                            for line_num, line in enumerate(f, 1):
                                if pattern in line:
                                    results.append(
                                        f"{file_path}:{line_num}: {line.rstrip()}"
                                    )
                                    matches_found += 1
                        files_processed += 1
                    except UnicodeDecodeError:
                        # Skip binary files
                        continue
                    except Exception as e:
                        await tool_ctx.warning(f"Error reading {file_path}: {str(e)}")

                # Final progress report
                await tool_ctx.report_progress(total_files, total_files)

                if not results:
                    return f"No matches found for pattern '{pattern}' in files matching '{file_pattern}' in {path}"

                await tool_ctx.info(
                    f"Found {matches_found} matches in {files_processed} files"
                )
                return (
                    f"Found {matches_found} matches in {files_processed} files:\n\n"
                    + "\n".join(results)
                )
            except Exception as e:
                await tool_ctx.error(f"Error searching file contents: {str(e)}")
                return f"Error searching file contents: {str(e)}"

        # Content replace tool (search and replace across multiple files)
        @mcp_server.tool()
        async def content_replace(
            ctx: MCPContext,
            pattern: str,
            replacement: str,
            path: str,
            file_pattern: str = "*",
            dry_run: bool = False,
        ) -> str:
            """Replace a pattern in file contents across multiple files.

            Searches for text patterns across all files in the specified directory
            that match the file pattern and replaces them with the specified text.
            Can be run in dry-run mode to preview changes without applying them.
            Only works within allowed directories.

            Args:
                pattern: Text pattern to search for
                replacement: Text to replace with
                path: Directory to search in
                file_pattern: File pattern to match (e.g., "*.py" for Python files)
                dry_run: Preview changes without applying them (default: False)

            Returns:
                Summary of replacements made or preview of changes
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("content_replace")
            await tool_ctx.info(
                f"Replacing pattern '{pattern}' with '{replacement}' in files matching '{file_pattern}' in {path}"
            )

            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                await tool_ctx.error(
                    f"Access denied - path outside allowed directories: {path}"
                )
                return (
                    f"Error: Access denied - path outside allowed directories: {path}"
                )

            # Additional check already verified by is_path_allowed above
            await tool_ctx.info(
                f"Replacing pattern '{pattern}' with '{replacement}' in files matching '{file_pattern}' in {path}"
            )

            try:
                dir_path = Path(path)

                if not dir_path.exists():
                    await tool_ctx.error(f"Path does not exist: {path}")
                    return f"Error: Path does not exist: {path}"

                if not dir_path.is_dir():
                    await tool_ctx.error(f"Path is not a directory: {path}")
                    return f"Error: Path is not a directory: {path}"

                # Find matching files
                matching_files: list[Path] = []

                # Recursive function to find files
                async def find_files(current_path: Path) -> None:
                    # Skip if not allowed
                    if not self.permission_manager.is_path_allowed(str(current_path)):
                        return

                    try:
                        for entry in current_path.iterdir():
                            # Skip if not allowed
                            if not self.permission_manager.is_path_allowed(str(entry)):
                                continue

                            if entry.is_file():
                                # Check if file matches pattern
                                if file_pattern == "*" or entry.match(file_pattern):
                                    matching_files.append(entry)
                            elif entry.is_dir():
                                # Recurse into directory
                                await find_files(entry)
                    except Exception as e:
                        await tool_ctx.warning(
                            f"Error accessing {current_path}: {str(e)}"
                        )

                # Find all matching files
                await find_files(dir_path)

                # Report progress
                total_files = len(matching_files)
                await tool_ctx.info(f"Processing {total_files} files")

                # Process files
                results: list[str] = []
                files_modified = 0
                replacements_made = 0

                for i, file_path in enumerate(matching_files):
                    # Report progress every 10 files
                    if i % 10 == 0:
                        await tool_ctx.report_progress(i, total_files)

                    try:
                        # Read file
                        with open(file_path, "r", encoding="utf-8") as f:
                            content = f.read()

                        # Count occurrences
                        count = content.count(pattern)

                        if count > 0:
                            # Replace pattern
                            new_content = content.replace(pattern, replacement)

                            # Add to results
                            replacements_made += count
                            files_modified += 1
                            results.append(f"{file_path}: {count} replacements")

                            # Write file if not a dry run
                            if not dry_run:
                                with open(file_path, "w", encoding="utf-8") as f:
                                    f.write(new_content)

                                # Update document context
                                self.document_context.update_document(
                                    str(file_path), new_content
                                )
                    except UnicodeDecodeError:
                        # Skip binary files
                        continue
                    except Exception as e:
                        await tool_ctx.warning(
                            f"Error processing {file_path}: {str(e)}"
                        )

                # Final progress report
                await tool_ctx.report_progress(total_files, total_files)

                if replacements_made == 0:
                    return f"No occurrences of pattern '{pattern}' found in files matching '{file_pattern}' in {path}"

                if dry_run:
                    await tool_ctx.info(
                        f"Dry run: {replacements_made} replacements would be made in {files_modified} files"
                    )
                    message = f"Dry run: {replacements_made} replacements of '{pattern}' with '{replacement}' would be made in {files_modified} files:"
                else:
                    await tool_ctx.info(
                        f"Made {replacements_made} replacements in {files_modified} files"
                    )
                    message = f"Made {replacements_made} replacements of '{pattern}' with '{replacement}' in {files_modified} files:"

                return message + "\n\n" + "\n".join(results)
            except Exception as e:
                await tool_ctx.error(f"Error replacing content: {str(e)}")
                return f"Error replacing content: {str(e)}"
