"""Command execution system for the MCP Claude Code server."""

import asyncio
import os
import shlex
from typing import final

from mcp_claude_code.permissions import PermissionManager


@final
class CommandExecutor:
    """Executes shell commands with proper permissions and safety checks."""
    
    def __init__(self, permission_manager: PermissionManager) -> None:
        """Initialize the command executor with permission management.
        
        Args:
            permission_manager: The permission manager to check path access and operations
        """
        self.permission_manager: PermissionManager = permission_manager
        
        # Excluded commands or patterns
        self.excluded_commands: list[str] = []
        self.excluded_patterns: list[str] = []
        
        # Add default exclusions
        self._add_default_exclusions()
    
    def _add_default_exclusions(self) -> None:
        """Add default exclusions for potentially dangerous commands and patterns."""
        # Potentially dangerous commands
        dangerous_commands: list[str] = [
            "rm", "rmdir", "mv", "cp", 
            "dd", "mkfs", "fdisk", "format",
            "chmod", "chown", "chgrp",
            "sudo", "su", "passwd", "mkpasswd",
            "ssh", "scp", "sftp", "ftp", 
            "curl", "wget",
            "nc", "netcat",
            "mount", "umount",
            "apt", "apt-get", "yum", "dnf", "brew",
            "systemctl", "service",
        ]
        
        self.excluded_commands.extend(dangerous_commands)
        
        # Dangerous patterns
        dangerous_patterns: list[str] = [
            ">", ">>",  # Redirection
            "|", "&", "&&", "||",  # Pipes and control operators
            ";",  # Command separator
            "`", "$(", "$((",  # Command substitution
            "<(", ">(", "<<<",  # Process substitution and here documents
        ]
        
        self.excluded_patterns.extend(dangerous_patterns)
    
    def allow_command(self, command: str) -> None:
        """Allow a specific command that might otherwise be excluded.
        
        Args:
            command: The command to allow
        """
        if command in self.excluded_commands:
            self.excluded_commands.remove(command)
    
    def deny_command(self, command: str) -> None:
        """Deny a specific command, adding it to the excluded list.
        
        Args:
            command: The command to deny
        """
        if command not in self.excluded_commands:
            self.excluded_commands.append(command)
    
    def is_command_allowed(self, command: str) -> bool:
        """Check if a command is allowed based on exclusion lists.
        
        Args:
            command: The command to check
            
        Returns:
            True if the command is allowed, False otherwise
        """
        # Check for empty commands
        args: list[str] = shlex.split(command)
        if not args:
            return False
        
        base_command: str = args[0]
        
        # Check if base command is in exclusion list
        if base_command in self.excluded_commands:
            return False
        
        # Check excluded patterns
        for pattern in self.excluded_patterns:
            if pattern in command:
                return False
        
        return True
    
    async def execute_command(
        self, 
        command: str, 
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
    ) -> tuple[int, str, str]:
        """Execute a shell command with safety checks.
        
        Args:
            command: The command to execute
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            
        Returns:
            A tuple of (return_code, stdout, stderr)
        """
        # Check if the command is allowed
        if not self.is_command_allowed(command):
            return (
                1, 
                "", 
                f"Error: Command not allowed: {command}"
            )
        
        # Check working directory permissions if specified
        if cwd and not self.permission_manager.is_path_allowed(cwd):
            return (
                1, 
                "", 
                f"Error: Working directory not allowed: {cwd}"
            )
        
        # Set up environment
        command_env: dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)
        
        try:
            # Split the command into arguments
            args: list[str] = shlex.split(command)
            
            # Create and run the process
            process = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=command_env
            )
            
            # Wait for the process to complete with timeout
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), 
                    timeout=timeout
                )
                
                return (
                    process.returncode or 0,
                    stdout_bytes.decode('utf-8', errors='replace'),
                    stderr_bytes.decode('utf-8', errors='replace')
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated
                
                return (
                    -1, 
                    "", 
                    f"Error: Command timed out after {timeout} seconds: {command}"
                )
        except Exception as e:
            return (
                1, 
                "", 
                f"Error executing command: {str(e)}"
            )
    
    async def execute_script(
        self, 
        script: str,
        interpreter: str = "bash",
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
    ) -> tuple[int, str, str]:
        """Execute a script with the specified interpreter.
        
        Args:
            script: The script content to execute
            interpreter: The interpreter to use (bash, python, etc.)
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            
        Returns:
            A tuple of (return_code, stdout, stderr)
        """
        # Check working directory permissions if specified
        if cwd and not self.permission_manager.is_path_allowed(cwd):
            return (
                1, 
                "", 
                f"Error: Working directory not allowed: {cwd}"
            )
        
        # Set up environment
        command_env: dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)
        
        try:
            # Create and run the process
            process = await asyncio.create_subprocess_exec(
                interpreter,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=command_env
            )
            
            # Wait for the process to complete with timeout
            try:
                script_bytes: bytes = script.encode('utf-8')
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(script_bytes), 
                    timeout=timeout
                )
                
                return (
                    process.returncode or 0,
                    stdout_bytes.decode('utf-8', errors='replace'),
                    stderr_bytes.decode('utf-8', errors='replace')
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated
                
                return (
                    -1, 
                    "", 
                    f"Error: Script execution timed out after {timeout} seconds"
                )
        except Exception as e:
            return (
                1, 
                "", 
                f"Error executing script: {str(e)}"
            )
