"""MCP server implementing Claude Code capabilities."""

import os
from pathlib import Path
from typing import Any, Literal, cast, final

from mcp.server.fastmcp import Context, FastMCP

from mcp_claude_code.enhanced_commands import EnhancedCommandExecutor
from mcp_claude_code.tool_integration import register_command_tools
from mcp_claude_code.context import DocumentContext
from mcp_claude_code.executors import ProjectAnalyzer, ScriptExecutor
from mcp_claude_code.permissions import PermissionManager
from mcp_claude_code.project import ProjectManager


@final
class ClaudeCodeServer:
    """MCP server implementing Claude Code capabilities."""

    def __init__(self, name: str = "claude-code", allowed_paths: list[str] | None = None):
        """Initialize the Claude Code server.
        
        Args:
            name: The name of the server
            allowed_paths: list of paths that the server is allowed to access
        """
        self.mcp = FastMCP(name)
        
        # Initialize context, permissions, and command executor
        self.document_context = DocumentContext()
        self.permission_manager = PermissionManager()
        # Initialize command executor
        self.command_executor = EnhancedCommandExecutor(
            permission_manager=self.permission_manager,
            verbose=False  # Set to True for debugging
        )
        self.script_executor = ScriptExecutor(self.permission_manager)
        self.project_analyzer = ProjectAnalyzer(self.script_executor)
        self.project_manager = ProjectManager(
            self.document_context,
            self.permission_manager,
            self.project_analyzer
        )
        
        # Add allowed paths
        if allowed_paths:
            for path in allowed_paths:
                self.permission_manager.add_allowed_path(path)
                self.document_context.add_allowed_path(path)
        
        self._setup_tools()
        
    def _setup_tools(self):
        """Set up all the Claude Code tools."""
        # Register command execution tools
        register_command_tools(self.mcp, self.command_executor)
        # Bash tool for executing shell commands
        @self.mcp.tool()
        async def bash_tool(command: str, ctx: Context, cwd: str | None = None) -> str:
            """Execute a shell command in the environment.
            
            Args:
                command: The shell command to execute
                cwd: Optional working directory for the command
            
            Returns:
                The output of the command
            """
            # Check if command is allowed
            if not self.command_executor.is_command_allowed(command):
                return f"Error: Command not allowed: {command}"
            
            # Check if working directory is allowed
            if cwd and not self.permission_manager.is_path_allowed(cwd):
                return f"Error: Working directory not allowed: {cwd}"
                
            # Execute the command
            return_code, stdout, stderr = await self.command_executor.execute_command(
                command, 
                cwd=cwd,
                timeout=30.0
            )
            
            # Format the result
            if return_code != 0:
                return f"Command failed with exit code {return_code}:\n{stderr}"
            
            return stdout
        
        # Glob tool for finding files
        @self.mcp.tool()
        async def glob_tool(pattern: str, ctx: Context, root_dir: str = ".") -> str:
            """Find files matching a glob pattern.
            
            Args:
                pattern: The glob pattern to match
                root_dir: Optional root directory for the search
                
            Returns:
                A list of matching files
            """
            # Check if root directory is allowed
            if not self.permission_manager.is_path_allowed(root_dir):
                return f"Error: Root directory not allowed: {root_dir}"
                
            try:
                # Expand the pattern and find files
                root_path = Path(root_dir)
                if pattern.startswith("/") or pattern.startswith("\\"):
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
                    return f"No files found matching pattern: {pattern} in {root_dir}"
                
                result = f"Found {len(allowed_files)} files matching pattern: {pattern}\n\n"
                for file in allowed_files:
                    result += f"- {file}\n"
                
                return result
            except Exception as e:
                return f"Error finding files: {str(e)}"
        
        # Grep tool for searching file contents
        @self.mcp.tool()
        async def grep_tool(pattern: str, ctx: Context, file_pattern: str = "*", root_dir: str = ".") -> str:
            """Search for a pattern in file contents.
            
            Args:
                pattern: The pattern to search for
                file_pattern: Optional glob pattern to filter files
                root_dir: Optional root directory for the search
                
            Returns:
                Matching lines from files
            """
            # Check if root directory is allowed
            if not self.permission_manager.is_path_allowed(root_dir):
                return f"Error: Root directory not allowed: {root_dir}"
                
            try:
                results: list[str] = []
                root_path = Path(root_dir)
                
                # Ensure file pattern is relative
                if file_pattern.startswith("/") or file_pattern.startswith("\\"):
                    return "Error: File pattern should be relative, not absolute"
                
                files = list(root_path.glob(file_pattern))
                
                # Filter files that are allowed to be accessed
                allowed_files: list[Path] = []
                for file in files:
                    if self.permission_manager.is_path_allowed(str(file)) and file.is_file():
                        allowed_files.append(file)
                
                # Perform the search
                for file in allowed_files:
                    try:
                        with open(file, 'r', encoding='utf-8') as f:
                            for i, line in enumerate(f, 1):
                                if pattern in line:
                                    results.append(f"{file}:{i}: {line.strip()}")
                    except UnicodeDecodeError:
                        # Skip binary files
                        continue
                
                if not results:
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
                
                return f"Found {len(results)} matches:\n\n" + "\n".join(results)
            except Exception as e:
                return f"Error searching files: {str(e)}"
        
        # LS tool for listing files and directories
        @self.mcp.tool()
        async def ls_tool(ctx: Context, path: str = ".") -> str:
            """list files and directories.
            
            Args:
                path: The directory path to list
                
            Returns:
                A list of files and directories
            """
            # Check if path is allowed
            if not self.permission_manager.is_path_allowed(path):
                return f"Error: Path not allowed: {path}"
                
            try:
                dir_path = Path(path)
                
                if not dir_path.exists():
                    return f"Path does not exist: {path}"
                
                if not dir_path.is_dir():
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
                
                return result
            except Exception as e:
                return f"Error listing directory: {str(e)}"
        
        # FileRead tool for reading file contents
        @self.mcp.tool()
        async def file_read_tool(file_path: str, ctx: Context) -> str:
            """Read the contents of a file.
            
            Args:
                file_path: Path to the file to read
                
            Returns:
                The contents of the file
            """
            # Check if file is allowed to be read
            if not self.permission_manager.is_path_allowed(file_path):
                return f"Error: File not allowed to be read: {file_path}"
                
            try:
                path = Path(file_path)
                
                if not path.exists():
                    return f"File does not exist: {file_path}"
                
                if not path.is_file():
                    return f"Path is not a file: {file_path}"
                
                # Read the file
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    # Add to document context
                    self.document_context.add_document(file_path, content)
                    
                    return f"Contents of {file_path}:\n\n{content}"
                except UnicodeDecodeError:
                    return f"Cannot read binary file: {file_path}"
            except Exception as e:
                return f"Error reading file: {str(e)}"
        
        # FileEdit tool for editing files
        @self.mcp.tool()
        async def file_edit_tool(file_path: str, old_text: str, new_text: str, ctx: Context) -> str:
            """Edit a file by replacing text.
            
            Args:
                file_path: Path to the file to edit
                old_text: Text to replace
                new_text: New text to insert
                
            Returns:
                Result of the edit operation
            """
            # Check if file is allowed to be edited
            if not self.permission_manager.is_path_allowed(file_path):
                return f"Error: File not allowed to be edited: {file_path}"
                
            # Check if file edit permission has been granted
            if not self.permission_manager.is_operation_approved(file_path, "edit"):
                # Request permission
                self.permission_manager.approve_operation(file_path, "edit")
                return f"Permission requested to edit file: {file_path}\nPlease approve the edit operation and try again."
            
            try:
                path = Path(file_path)
                
                if not path.exists():
                    return f"File does not exist: {file_path}"
                
                if not path.is_file():
                    return f"Path is not a file: {file_path}"
                
                # Read the file
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    # Check if old_text exists in content
                    if old_text not in content:
                        return f"Text to replace not found in file: {file_path}"
                    
                    # Replace text
                    new_content = content.replace(old_text, new_text)
                    
                    # Write the file
                    with open(path, 'w', encoding='utf-8') as f:
                        _ = f.write(new_content)  # Explicitly ignore the return value
                    
                    # Update in document context
                    self.document_context.update_document(file_path, new_content)
                    
                    return f"Successfully edited file: {file_path}"
                except UnicodeDecodeError:
                    return f"Cannot edit binary file: {file_path}"
            except Exception as e:
                return f"Error editing file: {str(e)}"
        
        # FileWrite tool for creating or overwriting files
        @self.mcp.tool()
        async def file_write_tool(file_path: str, content: str, ctx: Context) -> str:
            """Create or overwrite a file with content.
            
            Args:
                file_path: Path to the file to write
                content: Content to write to the file
                
            Returns:
                Result of the write operation
            """
            # Check if file is allowed to be written
            if not self.permission_manager.is_path_allowed(file_path):
                return f"Error: File not allowed to be written: {file_path}"
                
            # Check if file write permission has been granted
            if not self.permission_manager.is_operation_approved(file_path, "write"):
                # Request permission
                self.permission_manager.approve_operation(file_path, "write")
                return f"Permission requested to write file: {file_path}\nPlease approve the write operation and try again."
            
            try:
                path = Path(file_path)
                
                # Check if parent directory is allowed
                parent_dir = str(path.parent)
                if not self.permission_manager.is_path_allowed(parent_dir):
                    return f"Error: Parent directory not allowed: {parent_dir}"
                
                # Create parent directories if they don't exist
                path.parent.mkdir(parents=True, exist_ok=True)
                
                # Write the file
                with open(path, 'w', encoding='utf-8') as f:
                    _ = f.write(content)  # Explicitly ignore the return value
                
                # Add to document context
                self.document_context.add_document(file_path, content)
                
                return f"Successfully wrote file: {file_path}"
            except Exception as e:
                return f"Error writing file: {str(e)}"
                
        # Script execution tool
        @self.mcp.tool()
        async def script_tool(language: str, script: str, ctx: Context, args: list[str] | None = None, cwd: str | None = None) -> str:
            """Execute a script in the specified language.
            
            Args:
                language: The programming language (python, javascript, etc.)
                script: The script code to execute
                args: Optional command-line arguments
                cwd: Optional working directory
                
            Returns:
                Script execution results
            """
            # Check if the language is supported
            available_languages = self.script_executor.get_available_languages()
            if language not in available_languages:
                return f"Error: Unsupported language: {language}. Supported languages: {', '.join(available_languages)}"
            
            # Check if working directory is allowed
            if cwd and not self.permission_manager.is_path_allowed(cwd):
                return f"Error: Working directory not allowed: {cwd}"
                
            # Check if script execution permission has been granted
            operation = f"execute_{language}"
            script_path = cwd or os.getcwd()
            if not self.permission_manager.is_operation_approved(script_path, operation):
                # Request permission
                self.permission_manager.approve_operation(script_path, operation)
                return f"Permission requested to execute {language} script in {script_path}\nPlease approve the script execution and try again."
            
            # Execute the script
            return_code, stdout, stderr = await self.script_executor.execute_script(
                language,
                script,
                cwd=cwd,
                timeout=30.0,
                args=args
            )
            
            # Format the result
            if return_code != 0:
                return f"Script execution failed with exit code {return_code}:\n{stderr}"
            
            return f"Script execution succeeded:\n\n{stdout}"
            
        # Project analysis tool
        @self.mcp.tool()
        async def project_analyze_tool(project_dir: str, ctx: Context) -> str:
            """Analyze a project directory structure and dependencies.
            
            Args:
                project_dir: Path to the project directory
                
            Returns:
                Analysis of the project
            """
            # Check if directory is allowed
            if not self.permission_manager.is_path_allowed(project_dir):
                return f"Error: Directory not allowed: {project_dir}"
            
            # Set project root
            if not self.project_manager.set_project_root(project_dir):
                return f"Error: Failed to set project root: {project_dir}"
            
            # Analyze project
            analysis: dict[str, Any] = await self.project_manager.analyze_project()
            if "error" in analysis:
                return f"Error analyzing project: {analysis['error']}"
            
            # Generate summary
            summary = self.project_manager.generate_project_summary()
            return summary
        
        # Search and replace tool
        @self.mcp.tool()
        async def search_replace_tool(
            pattern: str, 
            replacement: str, 
            ctx: Context,
            file_pattern: str = "*.py",
            root_dir: str = "."
        ) -> str:
            """Search and replace text across multiple files.
            
            Args:
                pattern: The text pattern to search for
                replacement: The replacement text
                file_pattern: Optional glob pattern to filter files
                root_dir: Optional root directory for the search
                
            Returns:
                Results of the search and replace operation
            """
            # Check if root directory is allowed
            if not self.permission_manager.is_path_allowed(root_dir):
                return f"Error: Root directory not allowed: {root_dir}"
            
            # Ensure file pattern is relative
            if file_pattern.startswith("/") or file_pattern.startswith("\\"):
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
                    return f"No files found matching pattern: {file_pattern} in {root_dir} that can be modified"
                
                # Process files
                results: list[str] = []
                modified_count = 0
                total_replacements = 0
                
                for file in allowed_files:
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
                
                if total_replacements == 0:
                    return f"No occurrences of '{pattern}' found in files matching '{file_pattern}' in {root_dir}"
                
                summary = f"Replaced {total_replacements} occurrences of '{pattern}' with '{replacement}' in {modified_count} files:\n\n"
                return summary + "\n".join(results)
            except Exception as e:
                return f"Error during search and replace: {str(e)}"

    def run(self, transport: str = 'stdio', allowed_paths: list[str] | None = None):
        """Run the MCP server.
        
        Args:
            transport: The transport to use (stdio or sse)
            allowed_paths: list of paths that the server is allowed to access
        """
        # Add allowed paths if provided
        allowed_paths_list = allowed_paths or []
        for path in allowed_paths_list:
            self.permission_manager.add_allowed_path(path)
            self.document_context.add_allowed_path(path)
        
        # Run the server
        transport_type = cast(Literal['stdio', 'sse'], transport)
        self.mcp.run(transport=transport_type)


def main():
    """Run the Claude Code MCP server."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="MCP server implementing Claude Code capabilities"
    )
    
    _ = parser.add_argument(
        "--name",
        default="claude-code",
        help="Name of the MCP server (default: claude-code)"
    )
    
    _ = parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)"
    )
    
    _ = parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)"
    )
    
    args = parser.parse_args()
    
    # Type annotations for args to avoid Any warnings
    name: str = args.name
    transport: str = args.transport
    allowed_paths: list[str] | None = args.allowed_paths
    
    # Create and run the server
    server = ClaudeCodeServer(name=name, allowed_paths=allowed_paths)
    server.run(transport=transport, allowed_paths=allowed_paths or [])


if __name__ == "__main__":
    main()
