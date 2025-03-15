"""Enhanced command execution system for the MCP Claude Code server.

This module provides improved command and script execution capabilities for the MCP Claude
Code server, based on techniques from mcp-server-commands.
"""

import asyncio
import base64
import os
import shlex
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, final

from mcp_claude_code.permissions import PermissionManager


@final
class CommandResult:
    """Represents the result of a command execution."""

    def __init__(
        self,
        return_code: int = 0,
        stdout: str = "",
        stderr: str = "",
        error_message: Optional[str] = None
    ):
        """Initialize a command result.
        
        Args:
            return_code: The command's return code (0 for success)
            stdout: Standard output from the command
            stderr: Standard error from the command
            error_message: Optional error message for failure cases
        """
        self.return_code: int = return_code
        self.stdout: str = stdout
        self.stderr: str = stderr
        self.error_message: Optional[str] = error_message
    
    @property
    def is_success(self) -> bool:
        """Check if the command executed successfully.
        
        Returns:
            True if the command succeeded, False otherwise
        """
        return self.return_code == 0
    
    def format_output(self, include_exit_code: bool = True) -> str:
        """Format the command output as a string.
        
        Args:
            include_exit_code: Whether to include the exit code in the output
            
        Returns:
            Formatted output string
        """
        result_parts: List[str] = []
        
        # Add error message if present
        if self.error_message:
            result_parts.append(f"Error: {self.error_message}")
            
        # Add exit code if requested and not zero (for non-errors)
        if include_exit_code and (self.return_code != 0 or not self.error_message):
            result_parts.append(f"Exit code: {self.return_code}")
            
        # Add stdout if present
        if self.stdout:
            result_parts.append(f"STDOUT:\n{self.stdout}")
            
        # Add stderr if present
        if self.stderr:
            result_parts.append(f"STDERR:\n{self.stderr}")
            
        # Join with newlines
        return "\n\n".join(result_parts)


@final
class EnhancedCommandExecutor:
    """Executes shell commands and scripts with improved error handling and shell support."""
    
    def __init__(
        self, 
        permission_manager: PermissionManager,
        verbose: bool = False
    ) -> None:
        """Initialize the command executor with permission management.
        
        Args:
            permission_manager: The permission manager to check path access and operations
            verbose: Enable verbose logging
        """
        self.permission_manager: PermissionManager = permission_manager
        self.verbose: bool = verbose
        
        # Excluded commands or patterns
        self.excluded_commands: List[str] = []
        self.excluded_patterns: List[str] = []
        
        # Add default exclusions
        self._add_default_exclusions()
        
        # Map of supported interpreters with special handling
        self.special_interpreters: Dict[str, str] = {
            "fish": self._handle_fish_script,
        }
    
    def _add_default_exclusions(self) -> None:
        """Add default exclusions for potentially dangerous commands and patterns."""
        # Potentially dangerous commands
        dangerous_commands: List[str] = [
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
        dangerous_patterns: List[str] = [
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
    
    def _log(self, message: str, data: Any = None) -> None:
        """Log a message if verbose logging is enabled.
        
        Args:
            message: The message to log
            data: Optional data to include with the message
        """
        if not self.verbose:
            return
            
        if data is not None:
            try:
                import json
                if isinstance(data, (dict, list)):
                    data_str = json.dumps(data)
                else:
                    data_str = str(data)
                print(f"DEBUG: {message}: {data_str}", file=os.sys.stderr)
            except Exception:
                print(f"DEBUG: {message}: {data}", file=os.sys.stderr)
        else:
            print(f"DEBUG: {message}", file=os.sys.stderr)
    
    def is_command_allowed(self, command: str) -> bool:
        """Check if a command is allowed based on exclusion lists.
        
        Args:
            command: The command to check
            
        Returns:
            True if the command is allowed, False otherwise
        """
        # Check for empty commands
        try:
            args: List[str] = shlex.split(command)
        except ValueError as e:
            self._log(f"Command parsing error: {e}")
            return False
            
        if not args:
            return False
        
        base_command: str = args[0]
        
        # Check if base command is in exclusion list
        if base_command in self.excluded_commands:
            self._log(f"Command rejected (in exclusion list): {base_command}")
            return False
        
        # Check excluded patterns
        for pattern in self.excluded_patterns:
            if pattern in command:
                self._log(f"Command rejected (contains excluded pattern): {pattern}")
                return False
        
        return True
    
    async def execute_command(
        self, 
        command: str, 
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = 60.0,
    ) -> CommandResult:
        """Execute a shell command with safety checks.
        
        Args:
            command: The command to execute
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            
        Returns:
            CommandResult containing execution results
        """
        self._log(f"Executing command: {command}")
        
        # Check if the command is allowed
        if not self.is_command_allowed(command):
            return CommandResult(
                return_code=1,
                error_message=f"Command not allowed: {command}"
            )
        
        # Check working directory permissions if specified
        if cwd:
            if not os.path.isdir(cwd):
                return CommandResult(
                    return_code=1,
                    error_message=f"Working directory does not exist: {cwd}"
                )
                
            if not self.permission_manager.is_path_allowed(cwd):
                return CommandResult(
                    return_code=1,
                    error_message=f"Working directory not allowed: {cwd}"
                )
        
        # Set up environment
        command_env: Dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)
        
        try:
            # Split the command into arguments
            args: List[str] = shlex.split(command)
            
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
                
                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode('utf-8', errors='replace'),
                    stderr=stderr_bytes.decode('utf-8', errors='replace')
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated
                
                return CommandResult(
                    return_code=-1,
                    error_message=f"Command timed out after {timeout} seconds: {command}"
                )
        except Exception as e:
            self._log(f"Command execution error: {str(e)}")
            return CommandResult(
                return_code=1,
                error_message=f"Error executing command: {str(e)}"
            )
    
    async def execute_script(
        self, 
        script: str,
        interpreter: str = "bash",
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = 60.0,
    ) -> CommandResult:
        """Execute a script with the specified interpreter.
        
        Args:
            script: The script content to execute
            interpreter: The interpreter to use (bash, python, etc.)
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            
        Returns:
            CommandResult containing execution results
        """
        self._log(f"Executing script with interpreter: {interpreter}")
        
        # Check working directory permissions if specified
        if cwd:
            if not os.path.isdir(cwd):
                return CommandResult(
                    return_code=1,
                    error_message=f"Working directory does not exist: {cwd}"
                )
                
            if not self.permission_manager.is_path_allowed(cwd):
                return CommandResult(
                    return_code=1,
                    error_message=f"Working directory not allowed: {cwd}"
                )
        
        # Check if we need special handling for this interpreter
        interpreter_name = interpreter.split()[0].lower()
        if interpreter_name in self.special_interpreters:
            self._log(f"Using special handler for interpreter: {interpreter_name}")
            special_handler = self.special_interpreters[interpreter_name]
            return await special_handler(interpreter, script, cwd, env, timeout)
        
        # Regular execution
        return await self._execute_script_with_stdin(interpreter, script, cwd, env, timeout)
    
    async def _execute_script_with_stdin(
        self,
        interpreter: str,
        script: str,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = 60.0,
    ) -> CommandResult:
        """Execute a script by passing it to stdin of the interpreter.
        
        Args:
            interpreter: The interpreter command
            script: The script content
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            
        Returns:
            CommandResult containing execution results
        """
        # Set up environment
        command_env: Dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)
        
        try:
            # Parse the interpreter command to get arguments
            interpreter_parts = shlex.split(interpreter)
            
            # Create and run the process
            process = await asyncio.create_subprocess_exec(
                *interpreter_parts,
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
                
                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode('utf-8', errors='replace'),
                    stderr=stderr_bytes.decode('utf-8', errors='replace')
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated
                
                return CommandResult(
                    return_code=-1,
                    error_message=f"Script execution timed out after {timeout} seconds"
                )
        except Exception as e:
            self._log(f"Script execution error: {str(e)}")
            return CommandResult(
                return_code=1,
                error_message=f"Error executing script: {str(e)}"
            )
    
    async def _handle_fish_script(
        self,
        interpreter: str,
        script: str,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = 60.0,
    ) -> CommandResult:
        """Special handler for Fish shell scripts.
        
        The Fish shell has issues with piped input in some contexts, so we use
        a workaround that base64 encodes the script and decodes it in the pipeline.
        
        Args:
            interpreter: The fish interpreter command
            script: The fish script content
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            
        Returns:
            CommandResult containing execution results
        """
        self._log("Using Fish shell workaround")
        
        # Set up environment
        command_env: Dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)
        
        try:
            # Base64 encode the script to avoid stdin issues with Fish
            base64_script = base64.b64encode(script.encode('utf-8')).decode('utf-8')
            
            # Create a command that decodes the script and pipes it to fish
            command = f"{interpreter} -c \"echo {base64_script} | base64 -d | fish\""
            self._log(f"Fish command: {command}")
            
            # Create and run the process
            process = await asyncio.create_subprocess_shell(
                command,
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
                
                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode('utf-8', errors='replace'),
                    stderr=stderr_bytes.decode('utf-8', errors='replace')
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated
                
                return CommandResult(
                    return_code=-1,
                    error_message=f"Fish script execution timed out after {timeout} seconds"
                )
        except Exception as e:
            self._log(f"Fish script execution error: {str(e)}")
            return CommandResult(
                return_code=1,
                error_message=f"Error executing Fish script: {str(e)}"
            )
    
    async def execute_script_from_file(
        self,
        script: str,
        language: str,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = 60.0,
        args: Optional[List[str]] = None,
    ) -> CommandResult:
        """Execute a script by writing it to a temporary file and executing it.
        
        This is useful for languages where the script is too complex or long
        to pass via stdin, or for languages that have limitations with stdin.
        
        Args:
            script: The script content
            language: The script language (determines file extension and interpreter)
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            args: Optional command-line arguments
            
        Returns:
            CommandResult containing execution results
        """
        # Language to interpreter mapping
        language_map: Dict[str, Dict[str, str]] = {
            "python": {
                "command": "python",
                "extension": ".py",
            },
            "javascript": {
                "command": "node",
                "extension": ".js",
            },
            "typescript": {
                "command": "ts-node",
                "extension": ".ts",
            },
            "bash": {
                "command": "bash",
                "extension": ".sh",
            },
            "fish": {
                "command": "fish",
                "extension": ".fish",
            },
            "ruby": {
                "command": "ruby",
                "extension": ".rb",
            },
            "php": {
                "command": "php",
                "extension": ".php",
            },
            "perl": {
                "command": "perl",
                "extension": ".pl",
            },
            "r": {
                "command": "Rscript",
                "extension": ".R",
            },
        }
        
        # Check if the language is supported
        if language not in language_map:
            return CommandResult(
                return_code=1,
                error_message=f"Unsupported language: {language}. Supported languages: {', '.join(language_map.keys())}"
            )
        
        # Get language info
        language_info = language_map[language]
        command = language_info["command"]
        extension = language_info["extension"]
        
        # Set up environment
        command_env: Dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)
        
        # Create a temporary file for the script
        with tempfile.NamedTemporaryFile(suffix=extension, mode='w', delete=False) as temp:
            temp_path = temp.name
            temp.write(script)
        
        try:
            # Build command arguments
            cmd_args = [command, temp_path]
            if args:
                cmd_args.extend(args)
            
            self._log(f"Executing script from file with: {' '.join(cmd_args)}")
            
            # Create and run the process
            process = await asyncio.create_subprocess_exec(
                *cmd_args,
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
                
                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode('utf-8', errors='replace'),
                    stderr=stderr_bytes.decode('utf-8', errors='replace')
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated
                
                return CommandResult(
                    return_code=-1,
                    error_message=f"Script execution timed out after {timeout} seconds"
                )
        except Exception as e:
            self._log(f"Script file execution error: {str(e)}")
            return CommandResult(
                return_code=1,
                error_message=f"Error executing script: {str(e)}"
            )
        finally:
            # Clean up temporary file
            try:
                os.unlink(temp_path)
            except Exception as e:
                self._log(f"Error cleaning up temporary file: {str(e)}")
