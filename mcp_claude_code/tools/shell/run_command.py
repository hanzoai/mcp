"""Run command tool implementation.

This module provides the RunCommandTool for running shell commands.
"""

import os
from typing import Any, final

from mcp.server.fastmcp import Context as MCPContext

from mcp_claude_code.tools.common.context import create_tool_context
from mcp_claude_code.tools.shell.base import ShellBaseTool
from mcp_claude_code.tools.shell.command_executor import CommandExecutor


@final
class RunCommandTool(ShellBaseTool):
    """Tool for executing shell commands."""
    
    def __init__(self, permission_manager: Any, command_executor: CommandExecutor) -> None:
        """Initialize the run command tool.
        
        Args:
            permission_manager: Permission manager for access control
            command_executor: Command executor for running commands
        """
        super().__init__(permission_manager)
        self.command_executor: CommandExecutor = command_executor
        
    @property
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "run_command"
        
    @property
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return """Execute a shell command.

Args:
    command: The shell command to execute
    cwd: Working directory for the command

    use_login_shell: Whether to use login shell (loads ~/.zshrc, ~/.bashrc, etc.)

Returns:
    The output of the command
"""
        
    @property
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.
        
        Returns:
            Parameter specifications
        """
        return {
            "properties": {
                "command": {
                    "title": "Command",
                    "type": "string"
                },
                "cwd": {
                    "title": "Cwd",
                    "type": "string"
                },
                "use_login_shell": {
                    "default": True,
                    "title": "Use Login Shell",
                    "type": "boolean"
                }
            },
            "required": ["command", "cwd"],
            "title": "run_commandArguments",
            "type": "object"
        }
        
    @property
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return ["command", "cwd"]
    
    async def prepare_tool_context(self, ctx: MCPContext) -> Any:
        """Create and prepare the tool context.
        
        Args:
            ctx: MCP context
            
        Returns:
            Prepared tool context
        """
        tool_ctx = create_tool_context(ctx)
        tool_ctx.set_tool_info(self.name)
        return tool_ctx
        
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.
        
        Args:
            ctx: MCP context
            **params: Tool parameters
            
        Returns:
            Tool result
        """
        tool_ctx = await self.prepare_tool_context(ctx)
        
        # Extract parameters
        command = params.get("command")
        cwd = params.get("cwd")
        use_login_shell = params.get("use_login_shell", True)
        
        # Validate required parameters
        if not command:
            await tool_ctx.error("Parameter 'command' is required but was None")
            return "Error: Parameter 'command' is required but was None"
            
        if command.strip() == "":
            await tool_ctx.error("Parameter 'command' cannot be empty")
            return "Error: Parameter 'command' cannot be empty"
            
        if not cwd:
            await tool_ctx.error("Parameter 'cwd' is required but was None")
            return "Error: Parameter 'cwd' is required but was None"
            
        if cwd.strip() == "":
            await tool_ctx.error("Parameter 'cwd' cannot be empty")
            return "Error: Parameter 'cwd' cannot be empty"
        
        await tool_ctx.info(f"Executing command: {command}")
        
        # Check if command is allowed
        if not self.command_executor.is_command_allowed(command):
            await tool_ctx.error(f"Command not allowed: {command}")
            return f"Error: Command not allowed: {command}"
            
        # Check if working directory is allowed
        if not self.is_path_allowed(cwd):
            await tool_ctx.error(f"Working directory not allowed: {cwd}")
            return f"Error: Working directory not allowed: {cwd}"
            
        # Check if working directory exists
        if not os.path.isdir(cwd):
            await tool_ctx.error(f"Working directory does not exist: {cwd}")
            return f"Error: Working directory does not exist: {cwd}"
            
        # Execute the command
        result = await self.command_executor.execute_command(
            command, 
            cwd=cwd, 
            timeout=30.0, 
            use_login_shell=use_login_shell
        )
        
        # Report result
        if result.is_success:
            await tool_ctx.info("Command executed successfully")
        else:
            await tool_ctx.error(f"Command failed with exit code {result.return_code}")
            
        # Format the result
        if result.is_success:
            # For successful commands, just return stdout unless stderr has content
            if result.stderr:
                return f"Command executed successfully.\n\nSTDOUT:\n{result.stdout}\n\nSTDERR:\n{result.stderr}"
            return result.stdout
        else:
            # For failed commands, include all available information
            return result.format_output()
