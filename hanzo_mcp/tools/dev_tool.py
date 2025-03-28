"""Consolidated development tool for Hanzo MCP.

This module provides a unified interface for all development operations,
including file operations, command execution, project analysis,
notebook operations, and vector store operations.
"""

import os
import json
import logging
import shutil
import tempfile
import asyncio
from pathlib import Path
from typing import Any, Dict, List, Optional, Union, cast

from mcp.server.fastmcp import FastMCP
from hanzo_mcp.tools.common.context import DocumentContext, ToolContext, create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.common.validation import validate_parameters
from hanzo_mcp.tools.filesystem.file_operations import FileOperations
from hanzo_mcp.tools.shell.command_executor import CommandExecutor
from hanzo_mcp.tools.project.analysis import ProjectAnalyzer, ProjectManager
from hanzo_mcp.tools.jupyter.notebook_operations import JupyterNotebookTools
from hanzo_mcp.tools.cursor_rules import CursorRulesHandler
from hanzo_mcp.tools.mcp_manager import MCPServerManager
from hanzo_mcp.tools.llm_file_manager import LLMFileManager
# Conditional import for vector store manager
try:
    from hanzo_mcp.tools.vector.store_manager import VectorStoreManager
    has_vector_store = True
except ImportError:
    has_vector_store = False
    VectorStoreManager = None

logger = logging.getLogger(__name__)


class DevTool:
    """Consolidated development tool for Hanzo MCP.
    
    This tool provides a unified interface for all development operations,
    focusing on functionality rather than implementation details.
    """
    
    def __init__(
        self,
        document_context: DocumentContext,
        permission_manager: PermissionManager,
        command_executor: CommandExecutor,
        project_manager: ProjectManager,
        project_analyzer: ProjectAnalyzer,
        vector_store_manager: Optional[VectorStoreManager] = None
    ):
        """Initialize the dev tool.
        
        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
            command_executor: Command executor for running shell commands
            project_manager: Project manager for tracking projects
            project_analyzer: Project analyzer for analyzing project structure
            vector_store_manager: Optional vector store manager for embedding and search
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        self.command_executor = command_executor
        self.project_manager = project_manager
        self.project_analyzer = project_analyzer
        self.vector_store_manager = vector_store_manager
        
        # Initialize component tools
        self.file_ops = FileOperations(document_context, permission_manager)
        self.jupyter_tools = JupyterNotebookTools(document_context, permission_manager)
        
        # Initialize cursor rules handler
        self.cursor_rules_handler = CursorRulesHandler(permission_manager)
        
        # Initialize MCP server manager
        self.mcp_manager = MCPServerManager()
        
        # Initialize LLM file manager
        self.llm_file_manager = LLMFileManager(permission_manager)
        
        # Create find-replace script file
        self._setup_find_replace_script()
    
    def _setup_find_replace_script(self):
        """Set up the find-replace script file."""
        # Create script in user's home directory
        home_dir = os.path.expanduser("~")
        script_dir = os.path.join(home_dir, ".hanzo", "scripts")
        os.makedirs(script_dir, exist_ok=True)
        
        script_path = os.path.join(script_dir, "find_replace.sh")
        script_content = """#!/bin/bash

# Find and replace text in files recursively.
#
# A couple of notes:
# 1. LC_ALL causes this pattern to ignore unicode characters -- but that's fine
#    in the general case I care about. This is an issue on macOS because it
#    employs multibyte-on-demand UTF-8 encoding. More info here:
#    http://stackoverflow.com/a/23584470/641766
# 2. sed -i.bak is a trick to make sed in-place work on both linux and mac.
#    More info: http://stackoverflow.com/a/22084103/641766
find_replace_recursive() {
    local pattern="$1"
    local numproc
    # Override order: FIND_REPLACE_NUM_PROC > NUM_PROC > auto-detect > default (4)
    if [ -n "$FIND_REPLACE_NUM_PROC" ]; then
        numproc="$FIND_REPLACE_NUM_PROC"
    elif [ -n "$NUM_PROC" ]; then
        numproc="$NUM_PROC"
    elif command -v nproc >/dev/null 2>&1; then
        numproc=$(nproc)
    elif [ "$(uname)" = "Darwin" ]; then
        numproc=$(sysctl -n hw.ncpu)
    else
        numproc=4
    fi
    # Validate pattern
    local err
    err=$(echo | sed -e "$pattern" 2>&1 | tail -n 1)
    [ -n "$err" ] && { echo "invalid pattern: ${err:3}"; return; }
    [ -z "$pattern" ] && { echo "usage: find-replace-recursive s/find/replace/g"; return; }
    # Find text files, ignoring hidden paths and common binary/build dirs,
    # then perform in-place replacement using multiple processes.
    LC_ALL=C find . -type f \\
        ! -path '*/.*' \\
        ! -path '*/node_modules/*' \\
        ! -path '*/out/*' \\
        ! -path '*/dist/*' \\
        ! -path '*/build/*' \\
        -exec grep -Iq . {} \\; -print0 | \\
        xargs -0 -P "$numproc" sed -i.sedbak "$pattern"
    # Remove sed backup files
    find . -name '*.sedbak' -print0 | xargs -0 -P "$numproc" rm -f
    find . -name '.*.sedbak' -print0 | xargs -0 -P "$numproc" rm -f
}

# Execute the function with the provided arguments
cd "$2" && find_replace_recursive "$1"
"""
        # Write script if it doesn't exist or is different
        if not os.path.exists(script_path) or open(script_path, 'r').read() != script_content:
            with open(script_path, 'w') as f:
                f.write(script_content)
            os.chmod(script_path, 0o755)  # Make executable
        
        self.find_replace_script = script_path
            
    async def register_tools(self, mcp_server: FastMCP) -> None:
        """Register all dev tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        #
        # File Operations
        #
        
        @mcp_server.tool("dev")
        async def dev(
            ctx: Any, 
            operation: str,
            **kwargs
        ) -> str:
            """Universal development tool for all project operations.
            
            This tool provides a unified interface for all development operations,
            including file operations, command execution, project analysis,
            notebook operations, and vector store operations.
            
            Args:
                operation: The operation to perform
                **kwargs: Additional arguments specific to the operation
                
            Returns:
                Operation result as JSON or text
            """
            tool_ctx = create_tool_context(ctx)
            
            # Track the operation for context and output
            tool_ctx.current_operation = operation
            
            # Validate operation
            operations = {
                # File operations
                "read": self._read,
                "write": self._write,
                "edit": self._edit,
                "directory_tree": self._directory_tree,
                "get_file_info": self._get_file_info,
                "search_content": self._search_content,
                "find_replace": self._find_replace,
                
                # Command operations
                "run_command": self._run_command,
                "run_script": self._run_script,
                
                # Project operations
                "analyze_project": self._analyze_project,
                
                # Jupyter operations
                "jupyter_read": self._jupyter_read,
                "jupyter_edit": self._jupyter_edit,
                
                # Vector operations (if enabled)
                "vector_search": self._vector_search,
                "vector_index": self._vector_index,
                "vector_list": self._vector_list,
                "vector_delete": self._vector_delete,
                
                # Cursor Rules operations
                "rule_check": self._rule_check,
                
                # MCP Server operations
                "run_mcp": self._run_mcp,
                
                # LLM.md operations
                "llm_read": self._llm_read,
                "llm_update": self._llm_update,
                "llm_append": self._llm_append,
            }
            
            if operation not in operations:
                return await tool_ctx.error(
                    f"Unknown operation: {operation}. "
                    f"Available operations: {', '.join(sorted(operations.keys()))}"
                )
            
            # Store operation parameters for context and output
            tool_ctx.operation_params = kwargs
            
            # Call the appropriate method
            return await operations[operation](tool_ctx, **kwargs)
    
    #
    # File Operations
    #
    
    async def _read(self, tool_ctx: ToolContext, paths: Union[str, List[str]]) -> str:
        """Read file(s) content.
        
        Args:
            tool_ctx: Tool context
            paths: Single path or list of paths to read
            
        Returns:
            File content(s)
        """
        return await self.file_ops.read_files(tool_ctx, paths)
    
    async def _write(self, tool_ctx: ToolContext, path: str, content: str) -> str:
        """Write content to a file.
        
        Args:
            tool_ctx: Tool context
            path: Path to write to
            content: Content to write
            
        Returns:
            Result of the write operation
        """
        return await self.file_ops.write_file(tool_ctx, path, content)
    
    async def _edit(self, tool_ctx: ToolContext, path: str, edits: List[Dict[str, str]], dry_run: bool = False) -> str:
        """Edit a file with line-based edits.
        
        Args:
            tool_ctx: Tool context
            path: Path to edit
            edits: List of edit operations (oldText/newText pairs)
            dry_run: Whether to perform a dry run
            
        Returns:
            Result of the edit operation
        """
        return await self.file_ops.edit_file(tool_ctx, path, edits, dry_run)
    
    async def _directory_tree(
        self, 
        tool_ctx: ToolContext, 
        path: str, 
        depth: int = 3, 
        include_filtered: bool = False
    ) -> str:
        """Get a directory tree.
        
        Args:
            tool_ctx: Tool context
            path: Path to get tree for
            depth: Maximum depth
            include_filtered: Whether to include filtered directories
            
        Returns:
            Directory tree
        """
        return await self.file_ops.directory_tree(tool_ctx, path, depth, include_filtered)
    
    async def _get_file_info(self, tool_ctx: ToolContext, path: str) -> str:
        """Get file information.
        
        Args:
            tool_ctx: Tool context
            path: Path to get info for
            
        Returns:
            File information
        """
        return await self.file_ops.get_file_info(tool_ctx, path)
    
    async def _search_content(
        self, 
        tool_ctx: ToolContext, 
        pattern: str, 
        path: str, 
        file_pattern: str = "*"
    ) -> str:
        """Search for content in files.
        
        Args:
            tool_ctx: Tool context
            pattern: Pattern to search for
            path: Path to search in
            file_pattern: File pattern to match
            
        Returns:
            Search results
        """
        return await self.file_ops.search_content(tool_ctx, pattern, path, file_pattern)
    
    async def _find_replace(
        self, 
        tool_ctx: ToolContext, 
        pattern: str, 
        path: str, 
        dry_run: bool = True
    ) -> str:
        """Find and replace content in files recursively.
        
        Args:
            tool_ctx: Tool context
            pattern: Sed pattern to use (e.g., "s/foo/bar/g")
            path: Directory to perform replacement in
            dry_run: Whether to perform a dry run
            
        Returns:
            Result of the find and replace operation
        """
        # Validate parameters
        validate_parameters(tool_ctx, {
            "pattern": pattern,
            "path": path
        })
        
        # Check permissions
        if not self.permission_manager.is_path_allowed(path):
            return await tool_ctx.error(f"Path not allowed: {path}")
        
        if not os.path.isdir(path):
            return await tool_ctx.error(f"Path is not a directory: {path}")
        
        # Validate pattern by running a test
        try:
            # Run a quick validation using echo and sed
            cmd = f"echo test | sed -e '{pattern}' > /dev/null"
            result = await self.command_executor.run_command(tool_ctx, cmd, "/tmp")
            if "invalid" in result.lower():
                return await tool_ctx.error(f"Invalid pattern: {pattern}")
        except Exception as e:
            return await tool_ctx.error(f"Error validating pattern: {str(e)}")
        
        # If dry run, list files that would be affected
        if dry_run:
            # Use grep to find files that match the pattern
            try:
                cmd = f"""cd "{path}" && LC_ALL=C find . -type f \\
                    ! -path '*/.*' \\
                    ! -path '*/node_modules/*' \\
                    ! -path '*/out/*' \\
                    ! -path '*/dist/*' \\
                    ! -path '*/build/*' \\
                    -exec grep -Iq . {{}} \\; \\
                    -exec grep -l "{pattern.split('/')[1]}" {{}} \\;"""
                
                result = await self.command_executor.run_command(tool_ctx, cmd, "/tmp")
                
                # Format the results
                files = result.strip().split("\n")
                files = [f.strip() for f in files if f.strip()]
                
                return await tool_ctx.success(
                    f"Found {len(files)} files that would be affected by find-replace operation",
                    {
                        "pattern": pattern,
                        "path": path,
                        "affected_files": files
                    }
                )
            except Exception as e:
                return await tool_ctx.error(f"Error during dry run: {str(e)}")
        
        # Perform the replacement using the script
        try:
            cmd = f'bash "{self.find_replace_script}" "{pattern}" "{path}"'
            result = await self.command_executor.run_command(tool_ctx, cmd, "/tmp")
            
            # Check for errors
            if "invalid pattern" in result:
                return await tool_ctx.error(f"Invalid pattern: {pattern}")
            
            return await tool_ctx.success(
                f"Successfully performed find-replace operation with pattern: {pattern}",
                {
                    "pattern": pattern,
                    "path": path,
                    "result": result
                }
            )
        except Exception as e:
            return await tool_ctx.error(f"Error during find-replace operation: {str(e)}")
    
    #
    # Command Operations
    #
    
    async def _run_command(
        self, 
        tool_ctx: ToolContext, 
        command: str, 
        cwd: str, 
        use_login_shell: bool = True
    ) -> str:
        """Run a shell command.
        
        Args:
            tool_ctx: Tool context
            command: Command to run
            cwd: Working directory
            use_login_shell: Whether to use a login shell
            
        Returns:
            Command output
        """
        return await self.command_executor.run_command(tool_ctx, command, cwd, use_login_shell)
    
    async def _run_script(
        self, 
        tool_ctx: ToolContext, 
        script: str, 
        cwd: str, 
        interpreter: str = "bash", 
        use_login_shell: bool = True
    ) -> str:
        """Run a script.
        
        Args:
            tool_ctx: Tool context
            script: Script content
            cwd: Working directory
            interpreter: Script interpreter
            use_login_shell: Whether to use a login shell
            
        Returns:
            Script output
        """
        return await self.command_executor.run_script(tool_ctx, script, cwd, interpreter, use_login_shell)
    
    #
    # Project Operations
    #
    
    async def _analyze_project(self, tool_ctx: ToolContext, project_dir: str) -> str:
        """Analyze a project directory structure and dependencies.
        
        Args:
            tool_ctx: Tool context
            project_dir: Path to the project directory
            
        Returns:
            Project analysis
        """
        # Call the project analyzer's analyze_project method
        # First check if the directory exists and is allowed
        if not os.path.isdir(project_dir):
            return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
        
        if not self.permission_manager.is_path_allowed(project_dir):
            return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
        
        # Perform the analysis
        try:
            result = await self.project_analyzer.analyze_project_directory(project_dir)
            return await tool_ctx.success(
                f"Successfully analyzed project: {project_dir}",
                result
            )
        except Exception as e:
            return await tool_ctx.error(f"Error analyzing project: {str(e)}")
    
    #
    # Jupyter Operations
    #
    
    async def _jupyter_read(self, tool_ctx: ToolContext, path: str) -> str:
        """Read a Jupyter notebook.
        
        Args:
            tool_ctx: Tool context
            path: Path to the notebook
            
        Returns:
            Notebook content
        """
        return await self.jupyter_tools.read_notebook(tool_ctx, path)
    
    async def _jupyter_edit(
        self, 
        tool_ctx: ToolContext, 
        path: str, 
        cell_number: int, 
        new_source: str, 
        cell_type: Optional[str] = None, 
        edit_mode: str = "replace"
    ) -> str:
        """Edit a Jupyter notebook.
        
        Args:
            tool_ctx: Tool context
            path: Path to the notebook
            cell_number: Cell number to edit
            new_source: New source code
            cell_type: Cell type (code or markdown)
            edit_mode: Edit mode (replace, insert, or delete)
            
        Returns:
            Edit result
        """
        return await self.jupyter_tools.edit_notebook(
            tool_ctx, path, cell_number, new_source, cell_type, edit_mode
        )
    
    #
    # Cursor Rules Operations
    #
    
    async def _rule_check(
        self, 
        tool_ctx: ToolContext, 
        query: str,
        project_dir: Optional[str] = None,
        include_preinstalled: bool = True,
        detailed: bool = False
    ) -> str:
        """Check for cursor rules matching a query.
        
        Args:
            tool_ctx: Tool context
            query: Search query (technology or focus)
            project_dir: Optional project directory to search in
            include_preinstalled: Whether to include pre-installed rules
            detailed: Whether to include detailed rule content
            
        Returns:
            Matching rules information
        """
        # Validate parameters
        validate_parameters(tool_ctx, {"query": query})
        
        # Validate project_dir if provided
        if project_dir:
            if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
                return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
            
            if not self.permission_manager.is_path_allowed(project_dir):
                return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
        
        await tool_ctx.info(f"Searching for cursor rules matching query: {query}")
        
        # Search for matching rules
        matching_rules = self.cursor_rules_handler.search_rules(
            query=query,
            project_dir=project_dir,
            include_preinstalled=include_preinstalled
        )
        
        # Process results
        if not matching_rules:
            return await tool_ctx.info(f"No cursor rules found matching query: {query}")
        
        # Format results
        result = {
            "query": query,
            "count": len(matching_rules),
            "rules": []
        }
        
        for rule in matching_rules:
            if detailed:
                # Include full rule content if detailed view requested
                result["rules"].append({
                    "path": rule.get("path", ""),
                    "filename": rule.get("filename", ""),
                    "technologies": rule.get("technologies", []),
                    "focus": rule.get("focus", []),
                    "frontmatter": rule.get("frontmatter", {}),
                    "content": rule.get("content", "")
                })
            else:
                # Just include a summary
                result["rules"].append(self.cursor_rules_handler.get_rule_summary(rule))
        
        return await tool_ctx.success(
            f"Found {len(matching_rules)} cursor rules matching query: {query}",
            result
        )
    
    #
    # LLM.md Operations
    #
    
    async def _llm_read(self, tool_ctx: ToolContext, project_dir: Optional[str] = None) -> str:
        """Read LLM.md content.
        
        Args:
            tool_ctx: Tool context
            project_dir: Project directory (optional, otherwise uses cached content)
            
        Returns:
            LLM.md content
        """
        # If project_dir is provided, load from that location
        if project_dir:
            # Validate the path
            if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
                return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
            
            if not self.permission_manager.is_path_allowed(project_dir):
                return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
            
            # Initialize LLM.md for the project
            success, content, created = self.llm_file_manager.initialize_for_project(project_dir)
            
            if not success:
                return await tool_ctx.error(f"Failed to initialize LLM.md: {content}")
            
            if created:
                return await tool_ctx.success(
                    f"Created new LLM.md file in: {project_dir}",
                    {"content": content, "created": True}
                )
            else:
                return await tool_ctx.success(
                    f"Loaded LLM.md from: {project_dir}",
                    {"content": content, "created": False}
                )
        
        # If no project_dir provided, use cached content
        content = self.llm_file_manager.get_llm_md_content()
        
        if not content:
            return await tool_ctx.error(
                "No LLM.md content available. Please provide a project_dir or initialize LLM.md first."
            )
        
        return await tool_ctx.success(
            "Retrieved LLM.md content",
            {"content": content}
        )
    
    async def _llm_update(self, tool_ctx: ToolContext, content: str) -> str:
        """Update LLM.md content.
        
        Args:
            tool_ctx: Tool context
            content: New content
            
        Returns:
            Result of the update operation
        """
        # Validate parameters
        validate_parameters(tool_ctx, {"content": content})
        
        # Update the content
        success, message = self.llm_file_manager.update_llm_md(content)
        
        if not success:
            return await tool_ctx.error(message)
        
        return await tool_ctx.success(
            "Updated LLM.md content",
            {"message": message}
        )
    
    async def _llm_append(self, tool_ctx: ToolContext, section: str, content: str) -> str:
        """Append a section to LLM.md.
        
        Args:
            tool_ctx: Tool context
            section: Section title
            content: Section content
            
        Returns:
            Result of the append operation
        """
        # Validate parameters
        validate_parameters(tool_ctx, {"section": section, "content": content})
        
        # Append the section
        success, message = self.llm_file_manager.append_to_llm_md(section, content)
        
        if not success:
            return await tool_ctx.error(message)
        
        return await tool_ctx.success(
            f"Appended section '{section}' to LLM.md",
            {"message": message}
        )
    
    async def _run_mcp(
        self,
        tool_ctx: ToolContext,
        subcommand: str,
        server_name: Optional[str] = None,
        **kwargs
    ) -> str:
        """Run MCP server operations.
        
        Args:
            tool_ctx: Tool context
            subcommand: The subcommand to run (list, start, stop, restart, info, add, remove)
            server_name: The name of the server to operate on (for server-specific operations)
            **kwargs: Additional arguments for specific subcommands
            
        Returns:
            Operation result
        """
        # Validate parameters
        valid_subcommands = ["list", "start", "stop", "restart", "info", "add", "remove"]
        
        if subcommand not in valid_subcommands:
            return await tool_ctx.error(
                f"Invalid subcommand: {subcommand}. "  
                f"Valid subcommands: {', '.join(valid_subcommands)}"
            )
        
        # Handle each subcommand
        if subcommand == "list":
            return await self._run_mcp_list(tool_ctx)
        elif subcommand == "info":
            return await self._run_mcp_info(tool_ctx, server_name)
        elif subcommand == "start":
            return await self._run_mcp_start(tool_ctx, server_name)
        elif subcommand == "stop":
            return await self._run_mcp_stop(tool_ctx, server_name)
        elif subcommand == "restart":
            return await self._run_mcp_restart(tool_ctx, server_name)
        elif subcommand == "add":
            return await self._run_mcp_add(tool_ctx, **kwargs)
        elif subcommand == "remove":
            return await self._run_mcp_remove(tool_ctx, server_name)
        
        return await tool_ctx.error(f"Unhandled subcommand: {subcommand}")
    
    async def _run_mcp_list(self, tool_ctx: ToolContext) -> str:
        """List all MCP servers.
        
        Args:
            tool_ctx: Tool context
            
        Returns:
            List of servers
        """
        servers_info = self.mcp_manager.get_all_server_info()
        
        if not servers_info:
            return await tool_ctx.info("No MCP servers configured")
        
        return await tool_ctx.success(
            f"Found {len(servers_info)} MCP servers",
            {
                "servers": servers_info,
                "running": sum(1 for s in servers_info.values() if s.get("running", False)),
                "total_tools": sum(s.get("tool_count", 0) for s in servers_info.values())
            }
        )
    
    async def _run_mcp_info(self, tool_ctx: ToolContext, server_name: str) -> str:
        """Get information about an MCP server.
        
        Args:
            tool_ctx: Tool context
            server_name: The name of the server
            
        Returns:
            Server information
        """
        if not server_name:
            return await tool_ctx.error("Server name is required for info subcommand")
        
        server_info = self.mcp_manager.get_server_info(server_name)
        
        if "error" in server_info:
            return await tool_ctx.error(server_info["error"])
        
        return await tool_ctx.success(
            f"Server information for {server_name}",
            server_info
        )
    
    async def _run_mcp_start(self, tool_ctx: ToolContext, server_name: Optional[str]) -> str:
        """Start MCP server(s).
        
        Args:
            tool_ctx: Tool context
            server_name: The name of the server to start (or None for all)
            
        Returns:
            Start result
        """
        if server_name:
            # Start a specific server
            result = self.mcp_manager.start_server(server_name)
            
            if not result.get("success", False):
                return await tool_ctx.error(
                    result.get("error", f"Failed to start server: {server_name}")
                )
            
            return await tool_ctx.success(
                result.get("message", f"Started server: {server_name}"),
                result
            )
        else:
            # Start all servers
            results = self.mcp_manager.start_all_servers()
            success_count = sum(1 for r in results.values() if r.get("success", False))
            
            return await tool_ctx.success(
                f"Started {success_count}/{len(results)} MCP servers",
                {"results": results}
            )
    
    async def _run_mcp_stop(self, tool_ctx: ToolContext, server_name: Optional[str]) -> str:
        """Stop MCP server(s).
        
        Args:
            tool_ctx: Tool context
            server_name: The name of the server to stop (or None for all)
            
        Returns:
            Stop result
        """
        if server_name:
            # Stop a specific server
            result = self.mcp_manager.stop_server(server_name)
            
            if not result.get("success", False):
                return await tool_ctx.error(
                    result.get("error", f"Failed to stop server: {server_name}")
                )
            
            return await tool_ctx.success(
                result.get("message", f"Stopped server: {server_name}"),
                result
            )
        else:
            # Stop all servers
            results = self.mcp_manager.stop_all_servers()
            success_count = sum(1 for r in results.values() if r.get("success", False))
            
            return await tool_ctx.success(
                f"Stopped {success_count}/{len(results)} MCP servers",
                {"results": results}
            )
    
    async def _run_mcp_restart(self, tool_ctx: ToolContext, server_name: Optional[str]) -> str:
        """Restart MCP server(s).
        
        Args:
            tool_ctx: Tool context
            server_name: The name of the server to restart (or None for all)
            
        Returns:
            Restart result
        """
        # First stop the server(s)
        if server_name:
            stop_result = self.mcp_manager.stop_server(server_name)
            if not stop_result.get("success", False):
                return await tool_ctx.error(
                    stop_result.get("error", f"Failed to stop server: {server_name}")
                )
        else:
            self.mcp_manager.stop_all_servers()
        
        # Wait a moment for servers to fully stop
        await asyncio.sleep(1)
        
        # Then start the server(s)
        if server_name:
            start_result = self.mcp_manager.start_server(server_name)
            if not start_result.get("success", False):
                return await tool_ctx.error(
                    start_result.get("error", f"Failed to start server: {server_name}")
                )
            
            return await tool_ctx.success(
                f"Restarted server: {server_name}",
                {
                    "stop_result": stop_result,
                    "start_result": start_result
                }
            )
        else:
            start_results = self.mcp_manager.start_all_servers()
            success_count = sum(1 for r in start_results.values() if r.get("success", False))
            
            return await tool_ctx.success(
                f"Restarted {success_count}/{len(start_results)} MCP servers",
                {"results": start_results}
            )
    
    async def _run_mcp_add(
        self, 
        tool_ctx: ToolContext, 
        name: Optional[str] = None,
        command: Optional[str] = None,
        args: Optional[List[str]] = None,
        env: Optional[Dict[str, str]] = None,
        description: Optional[str] = None,
        **kwargs
    ) -> str:
        """Add a new MCP server.
        
        Args:
            tool_ctx: Tool context
            name: The name of the server
            command: The command to run the server
            args: The arguments for the command
            env: Environment variables for the server
            description: Description of the server
            
        Returns:
            Add result
        """
        if not name:
            return await tool_ctx.error("Server name is required")
        
        if not command:
            return await tool_ctx.error("Command is required")
        
        # Add the server
        success = self.mcp_manager.add_server(
            name=name,
            command=command,
            args=args or [],
            env=env or {},
            description=description or f"MCP server: {name}",
            save=True
        )
        
        if not success:
            return await tool_ctx.error(f"Failed to add server: {name}")
        
        return await tool_ctx.success(
            f"Added server: {name}",
            {
                "name": name,
                "command": command,
                "args": args or [],
                "description": description or f"MCP server: {name}"
            }
        )
    
    async def _run_mcp_remove(self, tool_ctx: ToolContext, server_name: str) -> str:
        """Remove an MCP server.
        
        Args:
            tool_ctx: Tool context
            server_name: The name of the server to remove
            
        Returns:
            Remove result
        """
        if not server_name:
            return await tool_ctx.error("Server name is required")
        
        # Remove the server
        success = self.mcp_manager.remove_server(server_name, save=True)
        
        if not success:
            return await tool_ctx.error(f"Failed to remove server: {server_name}")
        
        return await tool_ctx.success(f"Removed server: {server_name}")
    
    #
    # Vector Operations
    #
    
    async def _vector_search(
        self, 
        tool_ctx: ToolContext, 
        query_text: str, 
        project_dir: str,
        n_results: int = 10,
        where_metadata: Optional[Dict[str, Any]] = None,
        where_document: Optional[Dict[str, str]] = None
    ) -> str:
        """Search the vector store.
        
        Args:
            tool_ctx: Tool context
            query_text: Query text
            project_dir: Project directory
            n_results: Number of results
            where_metadata: Metadata filter
            where_document: Document filter
            
        Returns:
            Search results
        """
        if self.vector_store_manager is None:
            return await tool_ctx.error("Vector store is not enabled")
        
        # Call the vector store manager's search method
        # Validate parameters
        validate_parameters(tool_ctx, {
            "query_text": query_text,
            "project_dir": project_dir
        })
        
        # Check if project directory exists and is allowed
        if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
            return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
        
        if not self.permission_manager.is_path_allowed(project_dir):
            return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
        
        # Get the client and collection
        try:
            client = self.vector_store_manager._get_client(project_dir)
            collection = client.get_collection(
                name="project_files",
                embedding_function=self.vector_store_manager._embedding_function
            )
        except ValueError:
            return await tool_ctx.error(
                f"No vector index found for project: {project_dir}. "
                f"Please index the project first with the vector_index operation."
            )
        
        # Perform the search
        try:
            results = collection.query(
                query_texts=[query_text],
                n_results=n_results,
                where=where_metadata,
                where_document=where_document,
                include=["documents", "metadatas", "distances"]
            )
            
            # Format the results
            formatted_results = []
            for i, (doc, metadata, distance) in enumerate(zip(
                results["documents"][0],
                results["metadatas"][0],
                results["distances"][0]
            )):
                filepath = metadata["filepath"]
                chunk_index = metadata["chunk_index"]
                similarity = 1.0 - min(distance / 2.0, 1.0)  # Convert distance to similarity
                
                formatted_results.append({
                    "rank": i + 1,
                    "filepath": filepath,
                    "chunk_index": chunk_index,
                    "similarity": f"{similarity:.2f}",
                    "metadata": metadata,
                    "snippet": doc[:200] + "..." if len(doc) > 200 else doc
                })
            
            return await tool_ctx.success(
                f"Found {len(formatted_results)} results for query: {query_text}",
                {
                    "query": query_text,
                    "project_dir": project_dir,
                    "results": formatted_results
                }
            )
        
        except Exception as e:
            return await tool_ctx.error(f"Error searching vector store: {str(e)}")
    
    async def _vector_index(
        self, 
        tool_ctx: ToolContext, 
        path: str, 
        recursive: bool = True, 
        file_pattern: Optional[str] = None
    ) -> str:
        """Index a file or directory in the vector store.
        
        Args:
            tool_ctx: Tool context
            path: Path to index
            recursive: Whether to index recursively
            file_pattern: File pattern to match
            
        Returns:
            Indexing result
        """
        if self.vector_store_manager is None:
            return await tool_ctx.error("Vector store is not enabled")
        
        # Validate parameters
        validate_parameters(tool_ctx, {"path": path})
        
        # Check if path exists and is allowed
        if not os.path.exists(path):
            return await tool_ctx.error(f"Path does not exist: {path}")
        
        if not self.permission_manager.is_path_allowed(path):
            return await tool_ctx.error(f"Path is not allowed: {path}")
        
        # Get the project directory (parent directory of the path)
        project_dir = os.path.abspath(path if os.path.isdir(path) else os.path.dirname(path))
        
        await tool_ctx.info(f"Indexing {path} (project: {project_dir})")
        
        # Get the collection for this project
        collection = self.vector_store_manager._get_collection(project_dir)
        
        # Index the path
        if os.path.isdir(path):
            indexed_files = await self.vector_store_manager._index_directory(
                collection, 
                path, 
                tool_ctx, 
                recursive, 
                file_pattern
            )
            return await tool_ctx.success(
                f"Indexed {indexed_files} files from directory: {path}"
            )
        else:
            indexed_chunks = await self.vector_store_manager._read_and_index_file(collection, path, tool_ctx)
            return await tool_ctx.success(
                f"Indexed {indexed_chunks} chunks from file: {path}"
            )
    
    async def _vector_list(self, tool_ctx: ToolContext, project_dir: str) -> str:
        """List indexed documents in the vector store.
        
        Args:
            tool_ctx: Tool context
            project_dir: Project directory
            
        Returns:
            List of indexed documents
        """
        if self.vector_store_manager is None:
            return await tool_ctx.error("Vector store is not enabled")
        
        # Validate parameters
        validate_parameters(tool_ctx, {"project_dir": project_dir})
        
        # Check if project directory exists and is allowed
        if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
            return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
        
        if not self.permission_manager.is_path_allowed(project_dir):
            return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
        
        # Get the client and collection
        try:
            client = self.vector_store_manager._get_client(project_dir)
            collection = client.get_collection(
                name="project_files",
                embedding_function=self.vector_store_manager._embedding_function
            )
        except ValueError:
            return await tool_ctx.error(
                f"No vector index found for project: {project_dir}. "
                f"Please index the project first with the vector_index operation."
            )
        
        # Get all documents
        try:
            results = collection.get(include=["metadatas"])
            
            # Summarize files by counting chunks
            file_summary = {}
            for metadata in results["metadatas"]:
                filepath = metadata["filepath"]
                if filepath not in file_summary:
                    file_summary[filepath] = {
                        "chunks": 0,
                        "extension": metadata["file_extension"]
                    }
                file_summary[filepath]["chunks"] += 1
            
            # Format the results
            formatted_results = []
            for filepath, info in file_summary.items():
                formatted_results.append({
                    "filepath": filepath,
                    "chunks": info["chunks"],
                    "extension": info["extension"]
                })
            
            # Sort by filepath
            formatted_results.sort(key=lambda x: x["filepath"])
            
            return await tool_ctx.success(
                f"Found {len(formatted_results)} indexed files in project: {project_dir}",
                {
                    "project_dir": project_dir,
                    "indexed_files": formatted_results,
                    "total_chunks": len(results["metadatas"])
                }
            )
        
        except Exception as e:
            return await tool_ctx.error(f"Error listing vector store content: {str(e)}")
    
    async def _vector_delete(
        self, 
        tool_ctx: ToolContext, 
        project_dir: str, 
        filepath: Optional[str] = None
    ) -> str:
        """Delete documents from the vector store.
        
        Args:
            tool_ctx: Tool context
            project_dir: Project directory
            filepath: File path to delete
            
        Returns:
            Deletion result
        """
        if self.vector_store_manager is None:
            return await tool_ctx.error("Vector store is not enabled")
        
        # Validate parameters
        validate_parameters(tool_ctx, {"project_dir": project_dir})
        
        # Check if project directory exists and is allowed
        if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
            return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
        
        if not self.permission_manager.is_path_allowed(project_dir):
            return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
        
        # Get the client and collection
        try:
            client = self.vector_store_manager._get_client(project_dir)
            collection = client.get_collection(
                name="project_files",
                embedding_function=self.vector_store_manager._embedding_function
            )
        except ValueError:
            return await tool_ctx.error(f"No vector index found for project: {project_dir}")
        
        # Delete documents
        try:
            if filepath:
                # Check if filepath is allowed
                if not self.permission_manager.is_path_allowed(filepath):
                    return await tool_ctx.error(f"File path is not allowed: {filepath}")
                
                # Delete specific file
                collection.delete(where={"filepath": filepath})
                return await tool_ctx.success(f"Deleted entries for file: {filepath}")
            else:
                # Delete all documents in the collection
                collection.delete()
                return await tool_ctx.success(f"Deleted all entries for project: {project_dir}")
        
        except Exception as e:
            return await tool_ctx.error(f"Error deleting from vector store: {str(e)}")
