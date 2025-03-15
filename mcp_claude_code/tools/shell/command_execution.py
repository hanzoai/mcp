"""Command execution tools for MCP Claude Code.

This module provides tools for executing shell commands and scripts.
"""

import os
from typing import final

from mcp.server.fastmcp import Context as MCPContext, FastMCP

from mcp_claude_code.enhanced_commands import CommandResult, EnhancedCommandExecutor
from mcp_claude_code.executors import ScriptExecutor
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.common.context import ToolContext, create_tool_context


@final
class CommandExecution:
    """Command execution tools for MCP Claude Code."""
    
    def __init__(self, 
                 command_executor: EnhancedCommandExecutor,
                 script_executor: ScriptExecutor,
                 permission_manager: PermissionManager) -> None:
        """Initialize command execution.
        
        Args:
            command_executor: Enhanced command executor for running shell commands
            script_executor: Script executor for running scripts in various languages
            permission_manager: Permission manager for access control
        """
        self.command_executor: EnhancedCommandExecutor = command_executor
        self.script_executor: ScriptExecutor = script_executor
        self.permission_manager: PermissionManager = permission_manager
    
    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register command execution tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        # Run Command Tool
        @mcp_server.tool()
        async def run_command(command: str, ctx: MCPContext, cwd: str | None = None) -> str:
            """Execute a shell command.
            
            Args:
                command: The shell command to execute
                ctx: MCP context for logging and progress tracking
                cwd: Optional working directory for the command
                
            Returns:
                The output of the command
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("run_command")
            tool_ctx.info(f"Executing command: {command}")
            
            # Check if command is allowed
            if not self.command_executor.is_command_allowed(command):
                tool_ctx.error(f"Command not allowed: {command}")
                return f"Error: Command not allowed: {command}"
            
            # Check if working directory is allowed
            if cwd and not self.permission_manager.is_path_allowed(cwd):
                tool_ctx.error(f"Working directory not allowed: {cwd}")
                return f"Error: Working directory not allowed: {cwd}"
                
            # Execute the command
            result: CommandResult = await self.command_executor.execute_command(
                command, 
                cwd=cwd,
                timeout=30.0
            )
            
            # Report result
            if result.is_success:
                tool_ctx.info(f"Command executed successfully")
            else:
                tool_ctx.error(f"Command failed with exit code {result.return_code}")
            
            # Format the result
            if result.is_success:
                # For successful commands, just return stdout unless stderr has content
                if result.stderr:
                    return f"Command executed successfully.\n\nSTDOUT:\n{result.stdout}\n\nSTDERR:\n{result.stderr}"
                return result.stdout
            else:
                # For failed commands, include all available information
                return result.format_output()
        
        # Run Script Tool
        @mcp_server.tool()
        async def run_script(
            script: str, 
            ctx: MCPContext, 
            interpreter: str = "bash",
            cwd: str | None = None
        ) -> str:
            """Execute a script with the specified interpreter.
            
            Args:
                script: The script content to execute
                ctx: MCP context for logging and progress tracking
                interpreter: The interpreter to use (bash, python, etc.)
                cwd: Optional working directory
                
            Returns:
                The output of the script
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("run_script")
            tool_ctx.info(f"Executing script with interpreter: {interpreter}")
            
            # Check working directory permissions if specified
            if cwd:
                if not os.path.isdir(cwd):
                    tool_ctx.error(f"Working directory does not exist: {cwd}")
                    return f"Error: Working directory does not exist: {cwd}"
                    
                if not self.permission_manager.is_path_allowed(cwd):
                    tool_ctx.error(f"Working directory not allowed: {cwd}")
                    return f"Error: Working directory not allowed: {cwd}"
            
            # Execute the script
            result: CommandResult = await self.command_executor.execute_script(
                script=script,
                interpreter=interpreter,
                cwd=cwd,
                timeout=30.0
            )
            
            # Report result
            if result.is_success:
                tool_ctx.info(f"Script executed successfully")
            else:
                tool_ctx.error(f"Script execution failed with exit code {result.return_code}")
            
            # Format the result
            if result.is_success:
                # For successful scripts, just return stdout unless stderr has content
                if result.stderr:
                    return f"Script executed successfully.\n\nSTDOUT:\n{result.stdout}\n\nSTDERR:\n{result.stderr}"
                return result.stdout
            else:
                # For failed scripts, include all available information
                return result.format_output()
        
        # Script tool for executing scripts in various languages
        @mcp_server.tool()
        async def script_tool(
            language: str, 
            script: str, 
            ctx: MCPContext, 
            args: list[str] | None = None, 
            cwd: str | None = None
        ) -> str:
            """Execute a script in the specified language.
            
            Args:
                language: The programming language (python, javascript, etc.)
                script: The script code to execute
                ctx: MCP context for logging and progress tracking
                args: Optional command-line arguments
                cwd: Optional working directory
                
            Returns:
                Script execution results
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("script_tool")
            tool_ctx.info(f"Executing {language} script")
            
            # Check if the language is supported
            available_languages = self.script_executor.get_available_languages()
            if language not in available_languages:
                tool_ctx.error(f"Unsupported language: {language}")
                return f"Error: Unsupported language: {language}. Supported languages: {', '.join(available_languages)}"
            
            # Check if working directory is allowed
            if cwd and not self.permission_manager.is_path_allowed(cwd):
                tool_ctx.error(f"Working directory not allowed: {cwd}")
                return f"Error: Working directory not allowed: {cwd}"
                
            # Check if script execution permission has been granted
            operation = f"execute_{language}"
            script_path = cwd or os.getcwd()
            if not self.permission_manager.is_operation_approved(script_path, operation):
                # Request permission
                tool_ctx.info(f"Requesting permission to execute {language} script in {script_path}")
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
            
            # Report result
            if return_code == 0:
                tool_ctx.info(f"{language} script executed successfully")
            else:
                tool_ctx.error(f"{language} script execution failed with exit code {return_code}")
            
            # Format the result
            if return_code != 0:
                return f"Script execution failed with exit code {return_code}:\n{stderr}"
            
            return f"Script execution succeeded:\n\n{stdout}"
