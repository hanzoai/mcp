"""MCP server integration for enhanced command execution tools."""

from mcp.server.fastmcp import Context, FastMCP

from mcp_claude_code.enhanced_commands import (CommandResult,
                                               EnhancedCommandExecutor)


def register_command_tools(mcp_server: FastMCP, command_executor: EnhancedCommandExecutor):
    """Register command execution tools with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
        command_executor: The enhanced command executor instance
    """
    # Run Command Tool
    @mcp_server.tool()
    async def run_command(command: str, ctx: Context, cwd: str | None = None) -> str:
        """Execute a shell command.
        
        Args:
            command: The shell command to execute
            cwd: Optional working directory for the command
            
        Returns:
            The output of the command
        """
        # Execute the command
        result: CommandResult = await command_executor.execute_command(
            command=command,
            cwd=cwd,
            timeout=30.0
        )
        
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
        ctx: Context, 
        interpreter: str = "bash",
        cwd: str | None = None
    ) -> str:
        """Execute a script with the specified interpreter.
        
        Args:
            script: The script content to execute
            interpreter: The interpreter to use (bash, python, etc.)
            cwd: Optional working directory
            
        Returns:
            The output of the script
        """
        # Execute the script
        result: CommandResult = await command_executor.execute_script(
            script=script,
            interpreter=interpreter,
            cwd=cwd,
            timeout=30.0
        )
        
        # Format the result
        if result.is_success:
            # For successful scripts, just return stdout unless stderr has content
            if result.stderr:
                return f"Script executed successfully.\n\nSTDOUT:\n{result.stdout}\n\nSTDERR:\n{result.stderr}"
            return result.stdout
        else:
            # For failed scripts, include all available information
            return result.format_output()
    
    # Run Language Script Tool (alternative to run_script with language selection)
    @mcp_server.tool()
    async def run_language_script(
        language: str,
        script: str,
        ctx: Context,
        args: list[str] | None = None,
        cwd: str | None = None
    ) -> str:
        """Execute a script in the specified language.
        
        Args:
            language: The programming language (python, javascript, etc.)
            script: The script code to execute
            args: Optional command-line arguments
            cwd: Optional working directory
            
        Returns:
            Script execution results
        """
        # Execute the script from file
        result: CommandResult = await command_executor.execute_script_from_file(
            script=script,
            language=language,
            cwd=cwd,
            timeout=30.0,
            args=args
        )
        
        # Format the result
        if result.is_success:
            # For successful scripts, include a success message with the output
            output = f"Script executed successfully.\n\n"
            if result.stdout:
                output += f"STDOUT:\n{result.stdout}\n\n"
            if result.stderr:
                output += f"STDERR:\n{result.stderr}"
            return output.strip()
        else:
            # For failed scripts, include all available information
            return result.format_output()
