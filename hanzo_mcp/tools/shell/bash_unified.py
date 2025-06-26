"""Bash/Shell tool for command execution."""

import os
import platform
from pathlib import Path
from typing import Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.shell.base_process import BaseScriptTool
from mcp.server import FastMCP


class BashTool(BaseScriptTool):
    """Tool for running shell commands."""
    
    name = "bash"
    
    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        server.tool(name=self.name, description=self.description)(self.call)
    
    async def call(self, **kwargs) -> str:
        """Call the tool with arguments."""
        return await self.run(None, **kwargs)
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run shell commands. Actions: run (default), background.

Usage:
bash "ls -la"
bash --action background "python server.py"
bash "git status && git diff"
bash --action background "npm run dev" --cwd ./frontend"""
    
    @override
    def get_interpreter(self) -> str:
        """Get the shell interpreter."""
        if platform.system() == "Windows":
            return "cmd.exe"
        
        # Check for user's preferred shell from environment
        shell = os.environ.get("SHELL", "/bin/bash")
        
        # Extract just the shell name from the path
        shell_name = os.path.basename(shell)
        
        # Check if it's a supported shell and the config file exists
        if shell_name == "zsh":
            # Check for .zshrc
            zshrc_path = Path.home() / ".zshrc"
            if zshrc_path.exists():
                return shell  # Use full path to zsh
        elif shell_name == "fish":
            # Check for fish config
            fish_config = Path.home() / ".config" / "fish" / "config.fish"
            if fish_config.exists():
                return shell  # Use full path to fish
        
        # Default to bash if no special shell config found
        return "bash"
    
    @override
    def get_script_flags(self) -> list[str]:
        """Get interpreter flags."""
        if platform.system() == "Windows":
            return ["/c"]
        return ["-c"]
    
    @override
    def get_tool_name(self) -> str:
        """Get the tool name."""
        if platform.system() == "Windows":
            return "shell"
        
        # Return the actual shell being used
        interpreter = self.get_interpreter()
        return os.path.basename(interpreter)
    
    @override
    async def run(
        self,
        ctx: MCPContext,
        command: str,
        action: str = "run",
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        timeout: Optional[int] = None,
    ) -> str:
        """Run a shell command.
        
        Args:
            ctx: MCP context
            command: Shell command to execute
            action: Action to perform (run, background)
            cwd: Working directory
            env: Environment variables
            timeout: Command timeout in seconds
            
        Returns:
            Command output or process info
        """
        # Prepare working directory
        work_dir = Path(cwd).resolve() if cwd else Path.cwd()
        
        if action == "background":
            result = await self.execute_background(
                command,
                cwd=work_dir,
                env=env
            )
            return (
                f"Started command in background\n"
                f"Process ID: {result['process_id']}\n"
                f"PID: {result['pid']}\n"
                f"Log file: {result['log_file']}\n"
                f"Command: {command}"
            )
        else:
            # Default to sync execution
            output = await self.execute_sync(
                command,
                cwd=work_dir,
                env=env,
                timeout=timeout or 120  # Default 2 minute timeout
            )
            return output if output else "Command completed successfully (no output)"


# Create tool instance
bash_tool = BashTool()