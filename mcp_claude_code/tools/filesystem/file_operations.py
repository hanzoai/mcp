"""Filesystem operations tools for MCP Claude Code.

This module provides comprehensive tools for interacting with the filesystem,
including reading, writing, editing files, directory operations, and searching.
All operations are secured through permission validation and path checking.
"""

import re
import time
from difflib import unified_diff
from pathlib import Path
from typing import Any, final

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from mcp_claude_code.tools.common.context import DocumentContext, create_tool_context
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
                paths: Either a single absolute file path (string) or a list of absolute file paths

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
                path: Absolute path to the file to write
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
                path: Absolute path to the file to edit
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

            # Validate each edit to ensure oldText is not empty
            for i, edit in enumerate(edits):
                old_text = edit.get("oldText", "")
                if not old_text or old_text.strip() == "":
                    await tool_ctx.error(
                        f"Parameter 'oldText' in edit at index {i} is empty"
                    )
                    return f"Error: Parameter 'oldText' in edit at index {i} cannot be empty - must provide text to match"

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
        async def directory_tree(path: str, ctx: MCPContext, depth: int = 3, include_filtered: bool = False) -> str:
            """Get a recursive tree view of files and directories with customizable depth and filtering.

            Returns a structured view of the directory tree with files and subdirectories.
            Directories are marked with trailing slashes. The output is formatted as an
            indented list for readability. By default, common development directories like
            .git, node_modules, and venv are noted but not traversed unless explicitly
            requested. Only works within allowed directories.

            Args:
                path: Absolute path to the directory to explore
                depth: Maximum depth to traverse (default: 3, 0 or -1 for unlimited)
                include_filtered: Whether to include normally filtered directories (default: False)

            Returns:
                Structured tree view of the directory
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("directory_tree")

            # Validate path parameter
            path_validation = validate_path_parameter(path)
            if path_validation.is_error:
                await tool_ctx.error(path_validation.error_message)
                return f"Error: {path_validation.error_message}"

            await tool_ctx.info(f"Getting directory tree: {path} (depth: {depth}, include_filtered: {include_filtered})")

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

                # Define filtered directories
                FILTERED_DIRECTORIES = {
                    ".git", "node_modules", ".venv", "venv", 
                    "__pycache__", ".pytest_cache", ".idea", 
                    ".vs", ".vscode", "dist", "build", "target",
                    ".ruff_cache",".llm-context"
                }
                
                # Log filtering settings
                await tool_ctx.info(f"Directory tree filtering: include_filtered={include_filtered}")
                
                # Check if a directory should be filtered
                def should_filter(current_path: Path) -> bool:
                    # Don't filter if it's the explicitly requested path
                    if str(current_path.absolute()) == str(dir_path.absolute()):
                        # Don't filter explicitly requested paths
                        return False
                        
                    # Filter based on directory name if filtering is enabled
                    return current_path.name in FILTERED_DIRECTORIES and not include_filtered
                
                # Track stats for summary
                stats = {
                    "directories": 0,
                    "files": 0,
                    "skipped_depth": 0,
                    "skipped_filtered": 0
                }

                # Build the tree recursively
                async def build_tree(current_path: Path, current_depth: int = 0) -> list[dict[str, Any]]:
                    result: list[dict[str, Any]] = []

                    # Skip processing if path isn't allowed
                    if not self.permission_manager.is_path_allowed(str(current_path)):
                        return result

                    try:
                        # Sort entries: directories first, then files alphabetically
                        entries = sorted(current_path.iterdir(), key=lambda x: (not x.is_dir(), x.name))
                        
                        for entry in entries:
                            # Skip entries that aren't allowed
                            if not self.permission_manager.is_path_allowed(str(entry)):
                                continue

                            if entry.is_dir():
                                stats["directories"] += 1
                                entry_data: dict[str, Any] = {
                                    "name": entry.name,
                                    "type": "directory",
                                }

                                # Check if we should filter this directory
                                if should_filter(entry):
                                    entry_data["skipped"] = "filtered-directory"
                                    stats["skipped_filtered"] += 1
                                    result.append(entry_data)
                                    continue

                                # Check depth limit (if enabled)
                                if depth > 0 and current_depth >= depth:
                                    entry_data["skipped"] = "depth-limit"
                                    stats["skipped_depth"] += 1
                                    result.append(entry_data)
                                    continue

                                # Process children recursively with depth increment
                                entry_data["children"] = await build_tree(entry, current_depth + 1)
                                result.append(entry_data)
                            else:
                                # Files should be at the same level check as directories
                                if depth <= 0 or current_depth < depth:
                                    stats["files"] += 1
                                    # Add file entry
                                    result.append({
                                        "name": entry.name,
                                        "type": "file"
                                    })
                                
                    except Exception as e:
                        await tool_ctx.warning(
                            f"Error processing {current_path}: {str(e)}"
                        )

                    return result

                # Format the tree as a simple indented structure
                def format_tree(tree_data: list[dict[str, Any]], level: int = 0) -> list[str]:
                    lines = []
                    
                    for item in tree_data:
                        # Indentation based on level
                        indent = "  " * level
                        
                        # Format based on type
                        if item["type"] == "directory":
                            if "skipped" in item:
                                lines.append(f"{indent}{item['name']}/ [skipped - {item['skipped']}]")
                            else:
                                lines.append(f"{indent}{item['name']}/")
                                # Add children with increased indentation if present
                                if "children" in item:
                                    lines.extend(format_tree(item["children"], level + 1))
                        else:
                            # File
                            lines.append(f"{indent}{item['name']}")
                            
                    return lines

                # Build tree starting from the requested directory
                tree_data = await build_tree(dir_path)
                
                # Format as simple text
                formatted_output = "\n".join(format_tree(tree_data))
                
                # Add stats summary
                summary = (
                    f"\nDirectory Stats: {stats['directories']} directories, {stats['files']} files "
                    f"({stats['skipped_depth']} skipped due to depth limit, "
                    f"{stats['skipped_filtered']} filtered directories skipped)"
                )
                
                await tool_ctx.info(
                    f"Generated directory tree for {path} (depth: {depth}, include_filtered: {include_filtered})"
                )
                
                return formatted_output + summary
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
                path: Absolute path to the file to write


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
                path: Absolute directory or file to search in
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
                input_path = Path(path)

                if not input_path.exists():
                    await tool_ctx.error(f"Path does not exist: {path}")
                    return f"Error: Path does not exist: {path}"

                # Find matching files
                matching_files: list[Path] = []

                # Process based on whether path is a file or directory
                if input_path.is_file():
                    # Single file search
                    if file_pattern == "*" or input_path.match(file_pattern):
                        matching_files.append(input_path)
                        await tool_ctx.info(f"Searching single file: {path}")
                    else:
                        await tool_ctx.info(f"File does not match pattern '{file_pattern}': {path}")
                        return f"File does not match pattern '{file_pattern}': {path}"
                elif input_path.is_dir():
                    # Directory search - recursive function to find files
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

                    # Find all matching files in directory
                    await tool_ctx.info(f"Searching directory: {path}")
                    await find_files(input_path)
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
                                if re.search(pattern, line):
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
                    if input_path.is_file():
                        return f"No matches found for pattern '{pattern}' in file: {path}"
                    else:
                        return f"No matches found for pattern '{pattern}' in files matching '{file_pattern}' in directory: {path}"

                await tool_ctx.info(
                    f"Found {matches_found} matches in {files_processed} file{'s' if files_processed != 1 else ''}"
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
                path: Absolute directory or file to search in
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
                input_path = Path(path)

                if not input_path.exists():
                    await tool_ctx.error(f"Path does not exist: {path}")
                    return f"Error: Path does not exist: {path}"

                # Find matching files
                matching_files: list[Path] = []

                # Process based on whether path is a file or directory
                if input_path.is_file():
                    # Single file search
                    if file_pattern == "*" or input_path.match(file_pattern):
                        matching_files.append(input_path)
                        await tool_ctx.info(f"Searching single file: {path}")
                    else:
                        await tool_ctx.info(f"File does not match pattern '{file_pattern}': {path}")
                        return f"File does not match pattern '{file_pattern}': {path}"
                elif input_path.is_dir():
                    # Directory search - recursive function to find files
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

                    # Find all matching files in directory
                    await tool_ctx.info(f"Searching directory: {path}")
                    await find_files(input_path)
                else:
                    # This shouldn't happen since we already checked for existence
                    await tool_ctx.error(f"Path is neither a file nor a directory: {path}")
                    return f"Error: Path is neither a file nor a directory: {path}"

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
