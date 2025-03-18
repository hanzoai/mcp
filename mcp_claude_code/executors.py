"""Script execution system for the MCP Claude Code server."""

import asyncio
import os
import tempfile
from typing import final

from mcp_claude_code.tools.common.permissions import PermissionManager


@final
class ScriptExecutor:
    """Executes scripts in various languages with proper sandboxing."""

    def __init__(self, permission_manager: PermissionManager) -> None:
        """Initialize the script executor.

        Args:
            permission_manager: The permission manager for checking permissions
        """
        self.permission_manager: PermissionManager = permission_manager

        # Map of supported languages to their interpreters/compilers
        self.language_map: dict[str, dict[str, str]] = {
            "python": {
                "command": "python",
                "file_extension": ".py",
                "comment_prefix": "#",
            },
            "javascript": {
                "command": "node",
                "file_extension": ".js",
                "comment_prefix": "//",
            },
            "typescript": {
                "command": "ts-node",
                "file_extension": ".ts",
                "comment_prefix": "//",
            },
            "bash": {
                "command": "bash",
                "file_extension": ".sh",
                "comment_prefix": "#",
            },
            "ruby": {
                "command": "ruby",
                "file_extension": ".rb",
                "comment_prefix": "#",
            },
            "php": {
                "command": "php",
                "file_extension": ".php",
                "comment_prefix": "//",
            },
            "perl": {
                "command": "perl",
                "file_extension": ".pl",
                "comment_prefix": "#",
            },
            "r": {
                "command": "Rscript",
                "file_extension": ".R",
                "comment_prefix": "#",
            },
        }

    def get_available_languages(self) -> list[str]:
        """Get a list of available script languages.

        Returns:
            List of supported language names
        """
        return list(self.language_map.keys())

    async def is_language_installed(self, language: str) -> bool:
        """Check if the required interpreter/compiler is installed.

        Args:
            language: The language to check

        Returns:
            True if the language is supported and installed, False otherwise
        """
        if language not in self.language_map:
            return False

        command: str = self.language_map[language]["command"]

        try:
            # Try to execute the command with --version or -v
            process = await asyncio.create_subprocess_exec(
                command,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            _ = await process.communicate()
            return process.returncode == 0
        except Exception:
            try:
                # Some commands use -v instead
                process = await asyncio.create_subprocess_exec(
                    command,
                    "-v",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )

                _ = await process.communicate()
                return process.returncode == 0
            except Exception:
                return False

    async def execute_script(
        self,
        language: str,
        script: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
        args: list[str] | None = None,
    ) -> tuple[int, str, str]:
        """Execute a script in the specified language.

        Args:
            language: The programming language to use
            script: The script content to execute
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            args: Optional command-line arguments

        Returns:
            A tuple of (return_code, stdout, stderr)
        """
        # Check if language is supported
        if language not in self.language_map:
            return (
                1,
                "",
                f"Error: Unsupported language: {language}. Supported languages: {', '.join(self.language_map.keys())}",
            )

        # Check if working directory is allowed
        if cwd and not self.permission_manager.is_path_allowed(cwd):
            return (1, "", f"Error: Working directory not allowed: {cwd}")

        # Set up environment
        script_env: dict[str, str] = os.environ.copy()
        if env:
            script_env.update(env)

        try:
            # Create a temporary file for the script
            language_info: dict[str, str] = self.language_map[language]
            file_extension: str = language_info["file_extension"]
            command: str = language_info["command"]

            with tempfile.NamedTemporaryFile(
                suffix=file_extension, mode="w", delete=False
            ) as temp:
                temp_path: str = temp.name
                temp.write(script)

            try:
                # Build command arguments
                cmd_args: list[str] = [command, temp_path]
                if args:
                    cmd_args.extend(args)

                # Create and run the process
                process = await asyncio.create_subprocess_exec(
                    *cmd_args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=script_env,
                )

                # Wait for the process to complete with timeout
                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        process.communicate(), timeout=timeout
                    )

                    return (
                        process.returncode or 0,
                        stdout_bytes.decode("utf-8", errors="replace"),
                        stderr_bytes.decode("utf-8", errors="replace"),
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
                        f"Error: Script execution timed out after {timeout} seconds",
                    )
            finally:
                # Clean up temporary file
                os.unlink(temp_path)
        except Exception as e:
            return (1, "", f"Error executing script: {str(e)}")

    async def execute_script_inline(
        self,
        language: str,
        script: str,
        timeout: float | None = 60.0,
    ) -> tuple[int, str, str]:
        """Execute a script directly without creating a temporary file.

        This method is useful for short scripts that don't need file I/O.

        Args:
            language: The programming language to use
            script: The script content to execute
            timeout: Optional timeout in seconds

        Returns:
            A tuple of (return_code, stdout, stderr)
        """
        # Check if language is supported
        if language not in self.language_map:
            return (
                1,
                "",
                f"Error: Unsupported language: {language}. Supported languages: {', '.join(self.language_map.keys())}",
            )

        # Get language info
        language_info: dict[str, str] = self.language_map[language]
        command: str = language_info["command"]

        try:
            # Create and run the process
            process = await asyncio.create_subprocess_exec(
                command,
                "-c" if command == "python" else "-e",
                script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Wait for the process to complete with timeout
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), timeout=timeout
                )

                return (
                    process.returncode or 0,
                    stdout_bytes.decode("utf-8", errors="replace"),
                    stderr_bytes.decode("utf-8", errors="replace"),
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
                    f"Error: Script execution timed out after {timeout} seconds",
                )
        except Exception as e:
            return (1, "", f"Error executing script: {str(e)}")
