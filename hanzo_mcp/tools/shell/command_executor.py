"""Command executor tools for Hanzo MCP.

This module provides tools for executing shell commands and scripts with
comprehensive error handling, permissions checking, and progress tracking.
"""

import asyncio
import base64
import os
import shlex
import sys
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Dict, Optional, final

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.common.session import SessionManager
from hanzo_mcp.tools.shell.base import CommandResult


@final
class CommandExecutor:
    """Command executor tools for Hanzo MCP.

    This class provides tools for executing shell commands and scripts with
    comprehensive error handling, permissions checking, and progress tracking.
    """

    def __init__(
        self, permission_manager: PermissionManager, verbose: bool = False
    ) -> None:
        """Initialize command execution.

        Args:
            permission_manager: Permission manager for access control
            verbose: Enable verbose logging
        """
        self.permission_manager: PermissionManager = permission_manager
        self.verbose: bool = verbose

        # Session management (initialized on first use with session ID)
        self.session_manager: Optional[SessionManager] = None

        # Excluded commands or patterns
        self.excluded_commands: list[str] = ["rm"]

        # Map of supported interpreters with special handling
        self.special_interpreters: Dict[
            str,
            Callable[
                [str, str, str], dict[str, str]], Optional[float | None | None,
                Awaitable[CommandResult],
            ],
        ] = {
            "fish": self._handle_fish_script,
        }

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

    def _get_preferred_shell(self) -> str:
        """Get the best available shell for the current environment.
        
        Tries to find the best shell in this order:
        1. User's SHELL environment variable
        2. zsh
        3. bash
        4. fish
        5. sh (fallback)
        
        Returns:
            Path to the preferred shell
        """
        # First check the SHELL environment variable
        user_shell = os.environ.get("SHELL")
        if user_shell and os.path.exists(user_shell):
            return user_shell
        
        # Try common shells in order of preference
        shell_paths = [
            "/bin/zsh",
            "/usr/bin/zsh",
            "/bin/bash",
            "/usr/bin/bash",
            "/bin/fish",
            "/usr/bin/fish",
            "/bin/sh",
            "/usr/bin/sh",
        ]
        
        for shell_path in shell_paths:
            if os.path.exists(shell_path) and os.access(shell_path, os.X_OK):
                return shell_path
        
        # Fallback to /bin/sh which should exist on most systems
        return "/bin/sh"

    def get_session_manager(self, session_id: str) -> SessionManager:
        """Get the session manager for the given session ID.

        Args:
            session_id: The session ID

        Returns:
            The session manager instance
        """
        return SessionManager.get_instance(session_id)

    def set_working_dir(self, session_id: str, path: str) -> None:
        """Set the current working directory for the session.

        Args:
            session_id: The session ID
            path: The path to set as the current working directory
        """
        session = self.get_session_manager(session_id)
        expanded_path = os.path.expanduser(path)
        session.set_working_dir(Path(expanded_path))

    def get_working_dir(self, session_id: str) -> str:
        """Get the current working directory for the session.

        Args:
            session_id: The session ID

        Returns:
            The current working directory
        """
        session = self.get_session_manager(session_id)
        return str(session.current_working_dir)

    def _log(self, message: str, data: object | None = None) -> None:
        """Log a message if verbose logging is enabled.

        Args:
            message: The message to log
            data: Optional data to include with the message

        Note:
            Always logs to stderr to avoid interfering with stdio transport
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
                print(f"DEBUG: {message}: {data_str}", file=sys.stderr)
            except Exception:
                print(f"DEBUG: {message}: {data}", file=sys.stderr)
        else:
            print(f"DEBUG: {message}", file=sys.stderr)

    def is_command_allowed(self, command: str) -> bool:
        """Check if a command is allowed based on exclusion lists.

        Args:
            command: The command to check

        Returns:
            True if the command is allowed, False otherwise
        """
        # Check for empty commands
        try:
            args: list[str] = shlex.split(command)
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

        return True

    async def execute_command(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
        use_login_shell: bool = True,
        session_id: str | None = None,
    ) -> CommandResult:
        """Execute a shell command with safety checks.

        Args:
            command: The command to execute
            cwd: Optional working directory (if None, uses session's current working directory)
            env: Optional environment variables
            timeout: Optional timeout in seconds
            use_login_shell: Whether to use login shell. default true (loads ~/.zshrc, ~/.bashrc, etc.)
            session_id: Optional session ID for persistent working directory

        Returns:
            CommandResult containing execution results
        """
        self._log(f"Executing command: {command}")

        # Check if the command is allowed
        if not self.is_command_allowed(command):
            return CommandResult(
                return_code=1, error_message=f"Command not allowed: {command}"
            )

        # Use session working directory if no cwd specified and session_id provided
        effective_cwd = cwd
        if session_id and not cwd:
            effective_cwd = self.get_working_dir(session_id)
            self._log(f"Using session working directory: {effective_cwd}")

        # Check if it's a cd command and update session working directory
        if session_id and command.strip().startswith("cd "):
            args = shlex.split(command)
            if len(args) > 1:
                target_dir = args[1]
                # Handle relative paths
                if not os.path.isabs(target_dir):
                    session_cwd = self.get_working_dir(session_id)
                    target_dir = os.path.join(session_cwd, target_dir)
                
                # Expand user paths
                target_dir = os.path.expanduser(target_dir)
                
                # Normalize path
                target_dir = os.path.normpath(target_dir)
                
                if os.path.isdir(target_dir):
                    self.set_working_dir(session_id, target_dir)
                    self._log(f"Updated session working directory: {target_dir}")
                    return CommandResult(return_code=0, stdout="")
                else:
                    return CommandResult(
                        return_code=1, error_message=f"Directory does not exist: {target_dir}"
                    )

        # Check working directory permissions if specified
        if effective_cwd:
            if not os.path.isdir(effective_cwd):
                return CommandResult(
                    return_code=1,
                    error_message=f"Working directory does not exist: {effective_cwd}",
                )

            if not self.permission_manager.is_path_allowed(effective_cwd):
                return CommandResult(
                    return_code=1, error_message=f"Working directory not allowed: {effective_cwd}"
                )

        # Set up environment
        command_env: dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)

        try:
            # Check if command uses shell features like &&, ||, |, etc. or $ for env vars
            shell_operators = ["&&", "||", "|", ";", ">", "<", "$(", "`", "$"]
            needs_shell = any(op in command for op in shell_operators)

            if needs_shell or use_login_shell:
                # Determine which shell to use
                shell_cmd = command

                if use_login_shell:
                    # Try to find the best available shell
                    user_shell = self._get_preferred_shell()
                    shell_basename = os.path.basename(user_shell)

                    self._log(f"Using login shell: {user_shell}")

                    # Wrap command with appropriate shell invocation
                    if shell_basename == "zsh":
                        shell_cmd = f"{user_shell} -l -c '{command}'"
                    elif shell_basename == "bash":
                        shell_cmd = f"{user_shell} -l -c '{command}'"
                    elif shell_basename == "fish":
                        shell_cmd = f"{user_shell} -l -c '{command}'"
                    else:
                        # Default fallback
                        shell_cmd = f"{user_shell} -c '{command}'"
                else:
                    self._log(
                        f"Using shell for command with shell operators: {command}"
                    )

                # Use shell for command execution
                process = await asyncio.create_subprocess_shell(
                    shell_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=command_env,
                )
            else:
                # Split the command into arguments for regular commands
                args: list[str] = shlex.split(command)

                # Create and run the process without shell
                process = await asyncio.create_subprocess_exec(
                    *args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=effective_cwd,
                    env=command_env,
                )

            # Wait for the process to complete with timeout
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), timeout=timeout
                )

                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode("utf-8", errors="replace"),
                    stderr=stderr_bytes.decode("utf-8", errors="replace"),
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated

                return CommandResult(
                    return_code=-1,
                    error_message=f"Command timed out after {timeout} seconds: {command}",
                )
        except Exception as e:
            self._log(f"Command execution error: {str(e)}")
            return CommandResult(
                return_code=1, error_message=f"Error executing command: {str(e)}"
            )

    async def execute_script(
        self,
        script: str,
        interpreter: str = "bash",
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
        use_login_shell: bool = True,
        session_id: str | None = None,
    ) -> CommandResult:
        """Execute a script with the specified interpreter.

        Args:
            script: The script content to execute
            interpreter: The interpreter to use (bash, python, etc.)
            cwd: Optional working directory (if None, uses session's current working directory)
            env: Optional environment variables
            timeout: Optional timeout in seconds
            use_login_shell: Whether to use login shell (loads ~/.zshrc, ~/.bashrc, etc.)
            session_id: Optional session ID for persistent working directory

        Returns:
            CommandResult containing execution results
        """
        self._log(f"Executing script with interpreter: {interpreter}")

        # Use session working directory if no cwd specified and session_id provided
        effective_cwd = cwd
        if session_id and not cwd:
            effective_cwd = self.get_working_dir(session_id)
            self._log(f"Using session working directory: {effective_cwd}")

        # Check working directory permissions if specified
        if effective_cwd:
            if not os.path.isdir(effective_cwd):
                return CommandResult(
                    return_code=1,
                    error_message=f"Working directory does not exist: {effective_cwd}",
                )

            if not self.permission_manager.is_path_allowed(effective_cwd):
                return CommandResult(
                    return_code=1, error_message=f"Working directory not allowed: {effective_cwd}"
                )

        # Check if we need special handling for this interpreter
        interpreter_name = interpreter.split()[0].lower()
        if interpreter_name in self.special_interpreters:
            self._log(f"Using special handler for interpreter: {interpreter_name}")
            special_handler = self.special_interpreters[interpreter_name]
            return await special_handler(interpreter, script, effective_cwd, env, timeout)

        # Regular execution
        return await self._execute_script_with_stdin(
            interpreter, script, effective_cwd, env, timeout, use_login_shell
        )

    async def _execute_script_with_stdin(
        self,
        interpreter: str,
        script: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
        use_login_shell: bool = True,
    ) -> CommandResult:
        """Execute a script by passing it to stdin of the interpreter.

        Args:
            interpreter: The interpreter command
            script: The script content
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            use_login_shell: Whether to use login shell (loads ~/.zshrc, ~/.bashrc, etc.)

        Returns:
            CommandResult containing execution results
        """
        # Set up environment
        command_env: dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)

        try:
            # Determine if we should use a login shell
            if use_login_shell:
                # Try to find the best available shell
                user_shell = self._get_preferred_shell()
                
                self._log(f"Using login shell for interpreter: {user_shell}")

                # Create command that pipes script to interpreter through login shell
                shell_cmd = f"{user_shell} -l -c '{interpreter}'"

                # Create and run the process with shell
                process = await asyncio.create_subprocess_shell(
                    shell_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=command_env,
                )
            else:
                # Parse the interpreter command to get arguments
                interpreter_parts = shlex.split(interpreter)

                # Create and run the process normally
                process = await asyncio.create_subprocess_exec(
                    *interpreter_parts,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=command_env,
                )

            # Wait for the process to complete with timeout
            try:
                script_bytes: bytes = script.encode("utf-8")
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(script_bytes), timeout=timeout
                )

                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode("utf-8", errors="replace"),
                    stderr=stderr_bytes.decode("utf-8", errors="replace"),
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated

                return CommandResult(
                    return_code=-1,
                    error_message=f"Script execution timed out after {timeout} seconds",
                )
        except Exception as e:
            self._log(f"Script execution error: {str(e)}")
            return CommandResult(
                return_code=1, error_message=f"Error executing script: {str(e)}"
            )

    async def _handle_fish_script(
        self,
        interpreter: str,
        script: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
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
        command_env: dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)

        try:
            # Base64 encode the script to avoid stdin issues with Fish
            base64_script = base64.b64encode(script.encode("utf-8")).decode("utf-8")

            # Create a command that decodes the script and pipes it to fish
            command = f'{interpreter} -c "echo {base64_script} | base64 -d | fish"'
            self._log(f"Fish command: {command}")

            # Create and run the process
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=command_env,
            )

            # Wait for the process to complete with timeout
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), timeout=timeout
                )

                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode("utf-8", errors="replace"),
                    stderr=stderr_bytes.decode("utf-8", errors="replace"),
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated

                return CommandResult(
                    return_code=-1,
                    error_message=f"Fish script execution timed out after {timeout} seconds",
                )
        except Exception as e:
            self._log(f"Fish script execution error: {str(e)}")
            return CommandResult(
                return_code=1, error_message=f"Error executing Fish script: {str(e)}"
            )

    async def execute_script_from_file(
        self,
        script: str,
        language: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
        args: list[str] | None = None,
        use_login_shell: bool = True,
        session_id: str | None = None,
    ) -> CommandResult:
        """Execute a script by writing it to a temporary file and executing it.

        This is useful for languages where the script is too complex or long
        to pass via stdin, or for languages that have limitations with stdin.

        Args:
            script: The script content
            language: The script language (determines file extension and interpreter)
            cwd: Optional working directory (if None, uses session's current working directory)
            env: Optional environment variables
            timeout: Optional timeout in seconds
            args: Optional command-line arguments
            use_login_shell: Whether to use login shell. default true (loads ~/.zshrc, ~/.bashrc, etc.)
            session_id: Optional session ID for persistent working directory

        Returns:
            CommandResult containing execution results
        """
        # Use session working directory if no cwd specified and session_id provided
        effective_cwd = cwd
        if session_id and not cwd:
            effective_cwd = self.get_working_dir(session_id)
            self._log(f"Using session working directory: {effective_cwd}")
        # Language to interpreter mapping
        language_map: dict[str, dict[str, str]] = {
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
                error_message=f"Unsupported language: {language}. Supported languages: {', '.join(language_map.keys())}",
            )

        # Get language info
        language_info = language_map[language]
        command = language_info["command"]
        extension = language_info["extension"]

        # Set up environment
        command_env: dict[str, str] = os.environ.copy()
        if env:
            command_env.update(env)

        # Create a temporary file for the script
        with tempfile.NamedTemporaryFile(
            suffix=extension, mode="w", delete=False
        ) as temp:
            temp_path = temp.name
            _ = temp.write(script)  # Explicitly ignore the return value

        try:
            # Determine if we should use a login shell
            if use_login_shell:
                # Try to find the best available shell
                user_shell = self._get_preferred_shell()
                
                self._log(f"Using login shell for script execution: {user_shell}")

                # Build the command including args
                cmd = f"{command} {temp_path}"
                if args:
                    cmd += " " + " ".join(args)

                # Create command that runs script through login shell
                shell_cmd = f"{user_shell} -l -c '{cmd}'"

                self._log(f"Executing script from file with login shell: {shell_cmd}")

                # Create and run the process with shell
                process = await asyncio.create_subprocess_shell(
                    shell_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=command_env,
                )
            else:
                # Build command arguments
                cmd_args = [command, temp_path]
                if args:
                    cmd_args.extend(args)

                self._log(f"Executing script from file with: {' '.join(cmd_args)}")

                # Create and run the process normally
                process = await asyncio.create_subprocess_exec(
                    *cmd_args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=effective_cwd,
                    env=command_env,
                )

            # Wait for the process to complete with timeout
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), timeout=timeout
                )

                return CommandResult(
                    return_code=process.returncode or 0,
                    stdout=stdout_bytes.decode("utf-8", errors="replace"),
                    stderr=stderr_bytes.decode("utf-8", errors="replace"),
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated

                return CommandResult(
                    return_code=-1,
                    error_message=f"Script execution timed out after {timeout} seconds",
                )
        except Exception as e:
            self._log(f"Script file execution error: {str(e)}")
            return CommandResult(
                return_code=1, error_message=f"Error executing script: {str(e)}"
            )
        finally:
            # Clean up temporary file
            try:
                os.unlink(temp_path)
            except Exception as e:
                self._log(f"Error cleaning up temporary file: {str(e)}")

    def get_available_languages(self) -> list[str]:
        """Get a list of available script languages.

        Returns:
            List of supported language names
        """
        # Use the same language map as in execute_script_from_file method
        language_map = {
            "python": {"command": "python", "extension": ".py"},
            "javascript": {"command": "node", "extension": ".js"},
            "typescript": {"command": "ts-node", "extension": ".ts"},
            "bash": {"command": "bash", "extension": ".sh"},
            "fish": {"command": "fish", "extension": ".fish"},
            "ruby": {"command": "ruby", "extension": ".rb"},
            "php": {"command": "php", "extension": ".php"},
            "perl": {"command": "perl", "extension": ".pl"},
            "r": {"command": "Rscript", "extension": ".R"},
        }
        return list(language_map.keys())

    # Legacy method to keep backwards compatibility with tests
    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register command execution tools with the MCP server.
        
        Legacy method for backwards compatibility with existing tests.
        New code should use the modular tool classes instead.

        Args:
            mcp_server: The FastMCP server instance
        """
        # Run Command Tool - keep original method names for test compatibility
        @mcp_server.tool()
        async def run_command(
            command: str,
            cwd: str,
            ctx: MCPContext,
            use_login_shell: bool = True,
        ) -> str:
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("run_command")
            await tool_ctx.info(f"Executing command: {command}")

            # Use request_id as session_id for persistent working directory
            session_id = ctx.request_id

            # Run validations and execute
            result = await self.execute_command(
                command, 
                cwd, 
                timeout=30.0, 
                use_login_shell=use_login_shell,
                session_id=session_id
            )
            
            if result.is_success:
                return result.stdout
            else:
                return result.format_output()
                
        # Run Script Tool
        @mcp_server.tool()
        async def run_script(
            script: str,
            cwd: str,
            ctx: MCPContext,
            interpreter: str = "bash",
            use_login_shell: bool = True,
        ) -> str:
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("run_script")
            
            # Use request_id as session_id for persistent working directory
            session_id = ctx.request_id
            
            # Execute the script
            result = await self.execute_script(
                script=script,
                interpreter=interpreter,
                cwd=cwd,
                timeout=30.0,
                use_login_shell=use_login_shell,
                session_id=session_id,
            )
            
            if result.is_success:
                return result.stdout
            else:
                return result.format_output()
                
        # Script tool for executing scripts in various languages
        @mcp_server.tool()
        async def script_tool(
            language: str,
            script: str,
            cwd: str,
            ctx: MCPContext,
            args: list[str] | None = None,
            use_login_shell: bool = True,
        ) -> str:
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("script_tool")
            
            # Use request_id as session_id for persistent working directory
            session_id = ctx.request_id
            
            # Execute the script
            result = await self.execute_script_from_file(
                script=script,
                language=language,
                cwd=cwd,
                timeout=30.0,
                args=args,
                use_login_shell=use_login_shell,
                session_id=session_id
            )
            
            if result.is_success:
                return result.stdout
            else:
                return result.format_output()
