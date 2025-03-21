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
from mcp_claude_code.tools.common.validation import validate_path_parameter


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

        # Read files tool
        @mcp_server.tool()
        async def read_files(paths: list[str] | str, ctx: MCPContext) -> str:
            """Read the contents of one or multiple files.

            Can read a single file or multiple files simultaneously. When reading multiple files,
            each file's content is returned with its path as a reference. Failed reads for
            individual files won't stop the entire operation. Only works within allowed directories.

            Args:
                paths: Either a single file path (string) or a list of file paths

            Returns:
                Contents of the file(s) with path references
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("read_files")

            # Validate the 'paths' parameter
            if not paths:
                await tool_ctx.error("Parameter 'paths' is required but was None")
                return "Error: Parameter 'paths' is required but was None"

            # Convert single path to list if necessary
            path_list: list[str] = [paths] if isinstance(paths, str) else paths

            # Handle empty list case
            if not path_list:
                await tool_ctx.warning("No files specified to read")
                return "Error: No files specified to read"

            # For a single file with direct string return
            single_file_mode = isinstance(paths, str)

            await tool_ctx.info(f"Reading {len(path_list)} file(s)")

            results: list[str] = []

            # Read each file
            for i, path in enumerate(path_list):
                # Report progress
                await tool_ctx.report_progress(i, len(path_list))

                # Check if path is allowed
                if not self.permission_manager.is_path_allowed(path):
                    await tool_ctx.error(
                        f"Access denied - path outside allowed directories: {path}"
                    )
                    results.append(
                        f"{path}: Error - Access denied - path outside allowed directories"
                    )
                    continue

                try:
                    file_path = Path(path)

                    if not file_path.exists():
                        await tool_ctx.error(f"File does not exist: {path}")
                        results.append(f"{path}: Error - File does not exist")
                        continue

                    if not file_path.is_file():
                        await tool_ctx.error(f"Path is not a file: {path}")
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
                            await tool_ctx.warning(
                                f"File read with latin-1 encoding: {path}"
                            )
                            results.append(f"{path} (latin-1 encoding):\n{content}")
                        except Exception:
                            await tool_ctx.error(f"Cannot read binary file: {path}")
                            results.append(f"{path}: Error - Cannot read binary file")
                except Exception as e:
                    await tool_ctx.error(f"Error reading file: {str(e)}")
                    results.append(f"{path}: Error - {str(e)}")

            # Final progress report
            await tool_ctx.report_progress(len(path_list), len(path_list))

            await tool_ctx.info(f"Read {len(path_list)} file(s)")

            # For single file mode with direct string input, return just the content
            # if successful, otherwise return the error
            if single_file_mode and len(results) == 1:
                result_text = results[0]
                # If it's a successful read (doesn't contain "Error - ")
                if not result_text.split(":", 1)[1].strip().startswith("Error - "):
                    # Just return the content part (after the first colon and newline)
                    return result_text.split(":", 1)[1].strip()
                else:
                    # Return just the error message
                    return "Error: " + result_text.split("Error - ", 1)[1]

            # For multiple files or failed single file read, return all results
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

            # Validate parameters
            path_validation = validate_path_parameter(path)
            if path_validation.is_error:
                await tool_ctx.error(path_validation.error_message)
                return f"Error: {path_validation.error_message}"

            if not content:
                await tool_ctx.error("Parameter 'content' is required but was None")
                return "Error: Parameter 'content' is required but was None"

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

            # Validate parameters
            path_validation = validate_path_parameter(path)
            if path_validation.is_error:
                await tool_ctx.error(path_validation.error_message)
                return f"Error: {path_validation.error_message}"

            if not edits:
                await tool_ctx.error("Parameter 'edits' is required but was None")
                return "Error: Parameter 'edits' is required but was None"

            if not edits:  # Check for empty list
                await tool_ctx.warning("No edits specified")
                return "Error: No edits specified"

            # dry_run parameter can be None safely as it has a default value in the function signature

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

            # Validate path parameter
            path_validation = validate_path_parameter(path)
            if path_validation.is_error:
                await tool_ctx.error(path_validation.error_message)
                return f"Error: {path_validation.error_message}"

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

            # Validate path parameter
            path_validation = validate_path_parameter(path)
            if path_validation.is_error:
                await tool_ctx.error(path_validation.error_message)
                return f"Error: {path_validation.error_message}"

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

            # Validate required parameters
            if not pattern:
                await tool_ctx.error("Parameter 'pattern' is required but was None")
                return "Error: Parameter 'pattern' is required but was None"

            if pattern.strip() == "":
                await tool_ctx.error("Parameter 'pattern' cannot be empty")
                return "Error: Parameter 'pattern' cannot be empty"

            path_validation = validate_path_parameter(path)
            if path_validation.is_error:
                await tool_ctx.error(path_validation.error_message)
                return f"Error: {path_validation.error_message}"

            # file_pattern can be None safely as it has a default value

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

            # Validate required parameters
            if not pattern:
                await tool_ctx.error("Parameter 'pattern' is required but was None")
                return "Error: Parameter 'pattern' is required but was None"

            if pattern.strip() == "":
                await tool_ctx.error("Parameter 'pattern' cannot be empty")
                return "Error: Parameter 'pattern' cannot be empty"

            if not replacement:
                await tool_ctx.error("Parameter 'replacement' is required but was None")
                return "Error: Parameter 'replacement' is required but was None"

            # Note: replacement can be an empty string as sometimes you want to delete the pattern

            path_validation = validate_path_parameter(path)
            if path_validation.is_error:
                await tool_ctx.error(path_validation.error_message)
                return f"Error: {path_validation.error_message}"

            # file_pattern and dry_run can be None safely as they have default values

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
