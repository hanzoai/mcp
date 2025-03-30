"""Command-line interface for the Hanzo Code Tool.

This module provides a CLI and stdio interface for editing and interacting with code,
allowing it to be used directly from the command line or as an interface
for AI development environments like Claude Desktop.
"""

import argparse
import asyncio
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Union, cast

from hanzo_mcp.tools.common.context import DocumentContext, create_tool_context, SimpleToolContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.shell.command_executor import CommandExecutor
from hanzo_mcp.tools.project.analysis import ProjectAnalyzer, ProjectManager
from hanzo_mcp.tools.llm_file_manager import LLMFileManager
from hanzo_mcp.tools.dev_tool import DevTool

# Conditional import for vector store manager
try:
    from hanzo_mcp.tools.vector.store_manager import VectorStoreManager
    has_vector_store = True
except ImportError:
    has_vector_store = False
    VectorStoreManager = None
    
# Conditional import for tree-sitter components
try:
    from hanzo_mcp.tools.symbols.tree_sitter_manager import TreeSitterManager
    has_tree_sitter = True
except ImportError:
    has_tree_sitter = False
    TreeSitterManager = None


class HanzoCodeCLI:
    """CLI for the Hanzo Code Tool."""
    
    def __init__(
        self,
        allowed_paths: List[str] = None,
        project_dir: Optional[str] = None,
        verbose: bool = False
    ):
        """Initialize the CLI.
        
        Args:
            allowed_paths: List of allowed paths for operations
            project_dir: Project directory to work in
            verbose: Whether to enable verbose output
        """
        self.verbose = verbose
        
        # Set up allowed paths
        if allowed_paths is None:
            allowed_paths = [os.getcwd()]
            
        if project_dir and project_dir not in allowed_paths:
            allowed_paths.append(project_dir)
            
        # Initialize permission manager
        self.permission_manager = PermissionManager()
        for path in allowed_paths:
            self.permission_manager.add_allowed_path(path)
            
        self.document_context = DocumentContext()
        self.project_manager = ProjectManager()
        self.project_analyzer = ProjectAnalyzer()
        self.command_executor = CommandExecutor(self.permission_manager)
        self.llm_file_manager = LLMFileManager(self.permission_manager)
        
        # Initialize vector store manager if available
        if has_vector_store:
            self.vector_store_manager = VectorStoreManager(self.permission_manager)
        else:
            self.vector_store_manager = None
            
        # Initialize tree-sitter manager if available
        if has_tree_sitter:
            self.tree_sitter_manager = TreeSitterManager()
        else:
            self.tree_sitter_manager = None
            
        # Initialize DevTool
        self.dev_tool = DevTool(
            document_context=self.document_context,
            permission_manager=self.permission_manager,
            command_executor=self.command_executor,
            project_manager=self.project_manager,
            project_analyzer=self.project_analyzer,
            vector_store_manager=self.vector_store_manager,
            tree_sitter_manager=self.tree_sitter_manager
        )
        
        # Create tool context for CLI operations
        self.tool_context = SimpleToolContext()
        
    async def execute_operation(
        self,
        operation: str,
        args: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Execute a DevTool operation.
        
        Args:
            operation: The operation to execute
            args: Arguments for the operation
            
        Returns:
            Operation result
        """
        # Map operations to DevTool methods
        operations = {
            # File operations
            "read": self.dev_tool._read,
            "write": self.dev_tool._write,
            "edit": self.dev_tool._edit,
            "directory_tree": self.dev_tool._directory_tree,
            "get_file_info": self.dev_tool._get_file_info,
            "search_content": self.dev_tool._search_content,
            "find_replace": self.dev_tool._find_replace,
            
            # Command operations
            "run_command": self.dev_tool._run_command,
            "run_script": self.dev_tool._run_script,
            
            # Project operations
            "analyze_project": self.dev_tool._analyze_project,
            
            # Jupyter operations
            "jupyter_read": self.dev_tool._jupyter_read,
            "jupyter_edit": self.dev_tool._jupyter_edit,
            
            # Vector operations (if enabled)
            "vector_search": self.dev_tool._vector_search,
            "vector_index": self.dev_tool._vector_index,
            "vector_list": self.dev_tool._vector_list,
            "vector_delete": self.dev_tool._vector_delete,
            
            # Cursor Rules operations
            "rule_check": self.dev_tool._rule_check,
            
            # MCP Server operations
            "run_mcp": self.dev_tool._run_mcp,
            
            # LLM.md operations
            "llm_read": self.dev_tool._llm_read,
            "llm_update": self.dev_tool._llm_update,
            "llm_append": self.dev_tool._llm_append,
            
            # Symbol operations (if tree-sitter is available)
            "symbol_find": self.dev_tool._symbol_find,
            "symbol_references": self.dev_tool._symbol_references,
            "ast_explore": self.dev_tool._ast_explore,
            "ast_query": self.dev_tool._ast_query,
            "symbolic_search": self.dev_tool._symbolic_search,
        }
        
        if operation not in operations:
            available_ops = sorted(operations.keys())
            return {
                "success": False,
                "error": f"Unknown operation: {operation}",
                "available_operations": available_ops
            }
        
        # Reset tool context for this operation
        self.tool_context = SimpleToolContext()
        self.tool_context.current_operation = operation
        self.tool_context.operation_params = args
        
        # Call the operation
        try:
            result_str = await operations[operation](self.tool_context, **args)
            result = json.loads(result_str)
            return result
        except Exception as e:
            if self.verbose:
                traceback.print_exc()
            
            return {
                "success": False,
                "error": f"Error executing operation {operation}: {str(e)}"
            }

    async def process_stdin_command(self) -> None:
        """Process a command from stdin.
        
        Reads a JSON command from stdin, executes it, and writes the result to stdout.
        Format: {"operation": "<operation_name>", "args": {...}}
        """
        try:
            # Read a single line from stdin
            command_str = sys.stdin.readline().strip()
            
            if not command_str:
                # No input, return empty result
                sys.stdout.write(json.dumps({"success": False, "error": "No input provided"}) + "\n")
                sys.stdout.flush()
                return
            
            # Parse command
            try:
                command = json.loads(command_str)
            except json.JSONDecodeError:
                sys.stdout.write(json.dumps({"success": False, "error": "Invalid JSON input"}) + "\n")
                sys.stdout.flush()
                return
            
            # Validate command structure
            if not isinstance(command, dict) or "operation" not in command:
                sys.stdout.write(json.dumps({"success": False, "error": "Missing required 'operation' field"}) + "\n")
                sys.stdout.flush()
                return
            
            # Get operation and args
            operation = command.get("operation")
            args = command.get("args", {})
            
            # Execute operation
            result = await self.execute_operation(operation, args)
            
            # Write result to stdout
            sys.stdout.write(json.dumps(result) + "\n")
            sys.stdout.flush()
            
        except Exception as e:
            if self.verbose:
                traceback.print_exc()
            
            sys.stdout.write(json.dumps({"success": False, "error": f"Error processing command: {str(e)}"}) + "\n")
            sys.stdout.flush()

    async def stdio_mode(self) -> None:
        """Run in stdio mode, processing commands from stdin."""
        if self.verbose:
            sys.stderr.write("Running in stdio mode\n")
            sys.stderr.flush()
        
        while True:
            await self.process_stdin_command()

    async def run_cli_command(self, operation: str, args: Dict[str, Any]) -> int:
        """Run a CLI command.
        
        Args:
            operation: The operation to execute
            args: Arguments for the operation
            
        Returns:
            Exit code (0 for success, non-zero for error)
        """
        result = await self.execute_operation(operation, args)
        
        if result.get("success", False) is False:
            print(json.dumps(result, indent=2))
            return 1
        
        print(json.dumps(result, indent=2))
        return 0


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.
    
    Returns:
        Parsed arguments
    """
    parser = argparse.ArgumentParser(
        description="Hanzo Code Tool CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run in stdio mode (default)
  hanzo-code

  # List a directory tree
  hanzo-code directory_tree --path /path/to/project

  # Read a file
  hanzo-code read --paths /path/to/file.py

  # Run a command
  hanzo-code run_command --command "ls -la" --cwd /path/to/dir

  # Analyze a project
  hanzo-code analyze_project --project_dir /path/to/project
        """
    )
    
    # Global options
    parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)",
    )
    
    parser.add_argument(
        "--project-dir",
        dest="project_dir",
        help="Set the project directory",
    )
    
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Enable verbose output",
    )
    
    # Create subparsers for operations
    subparsers = parser.add_subparsers(dest="operation", help="Operation to perform")
    
    # File operations
    read_parser = subparsers.add_parser("read", help="Read file(s)")
    read_parser.add_argument("--paths", nargs="+", required=True, help="File path(s) to read")
    
    write_parser = subparsers.add_parser("write", help="Write to a file")
    write_parser.add_argument("--path", required=True, help="File path to write to")
    write_parser.add_argument("--content", required=True, help="Content to write")
    
    edit_parser = subparsers.add_parser("edit", help="Edit a file")
    edit_parser.add_argument("--path", required=True, help="File path to edit")
    edit_parser.add_argument("--edits", required=True, help="JSON string of edits (list of oldText/newText pairs)")
    edit_parser.add_argument("--dry-run", action="store_true", help="Perform a dry run")
    
    tree_parser = subparsers.add_parser("directory_tree", help="Get directory tree")
    tree_parser.add_argument("--path", required=True, help="Directory path to get tree for")
    tree_parser.add_argument("--depth", type=int, default=3, help="Maximum depth")
    tree_parser.add_argument("--include-filtered", action="store_true", help="Include filtered directories")
    
    info_parser = subparsers.add_parser("get_file_info", help="Get file information")
    info_parser.add_argument("--path", required=True, help="File path to get info for")
    
    search_parser = subparsers.add_parser("search_content", help="Search for content in files")
    search_parser.add_argument("--pattern", required=True, help="Pattern to search for")
    search_parser.add_argument("--path", required=True, help="Path to search in")
    search_parser.add_argument("--file-pattern", default="*", help="File pattern to match")
    
    find_replace_parser = subparsers.add_parser("find_replace", help="Find and replace content in files")
    find_replace_parser.add_argument("--pattern", required=True, help="Sed pattern to use (e.g., s/foo/bar/g)")
    find_replace_parser.add_argument("--path", required=True, help="Directory to perform replacement in")
    find_replace_parser.add_argument("--dry-run", action="store_true", help="Perform a dry run")
    
    # Command operations
    run_cmd_parser = subparsers.add_parser("run_command", help="Run a shell command")
    run_cmd_parser.add_argument("--command", required=True, help="Command to run")
    run_cmd_parser.add_argument("--cwd", required=True, help="Working directory")
    run_cmd_parser.add_argument("--use-login-shell", action="store_true", default=True, help="Use login shell")
    
    run_script_parser = subparsers.add_parser("run_script", help="Run a script")
    run_script_parser.add_argument("--script", required=True, help="Script content")
    run_script_parser.add_argument("--cwd", required=True, help="Working directory")
    run_script_parser.add_argument("--interpreter", default="bash", help="Script interpreter")
    run_script_parser.add_argument("--use-login-shell", action="store_true", default=True, help="Use login shell")
    
    # Project operations
    analyze_parser = subparsers.add_parser("analyze_project", help="Analyze a project")
    analyze_parser.add_argument("--project-dir", required=True, help="Project directory")
    
    # Default to stdio mode if no operation is specified
    parser.set_defaults(operation=None)
    
    return parser.parse_args()


async def main_async() -> int:
    """Main async entry point.
    
    Returns:
        Exit code
    """
    args = parse_args()
    
    # Initialize CLI
    cli = HanzoCodeCLI(
        allowed_paths=args.allowed_paths,
        project_dir=args.project_dir,
        verbose=args.verbose
    )
    
    # Run in stdio mode if no operation is specified
    if args.operation is None:
        await cli.stdio_mode()
        return 0
    
    # Convert args to dict for operation
    args_dict = vars(args)
    
    # Remove global options
    for opt in ["allowed_paths", "project_dir", "verbose", "operation"]:
        if opt in args_dict:
            del args_dict[opt]
    
    # Special handling for edits in edit operation
    if args.operation == "edit" and "edits" in args_dict:
        try:
            args_dict["edits"] = json.loads(args_dict["edits"])
        except json.JSONDecodeError:
            print(f"Error: Invalid JSON in --edits parameter")
            return 1
    
    # Run CLI command
    return await cli.run_cli_command(args.operation, args_dict)


def main() -> int:
    """Main entry point.
    
    Returns:
        Exit code
    """
    loop = asyncio.get_event_loop()
    try:
        return loop.run_until_complete(main_async())
    except KeyboardInterrupt:
        print("Operation interrupted by user")
        return 130
    finally:
        loop.close()


if __name__ == "__main__":
    sys.exit(main())
