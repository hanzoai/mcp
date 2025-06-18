"""Tests for the command executor module."""

import os
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

if TYPE_CHECKING:
    from hanzo_mcp.tools.common.permissions import PermissionManager

from hanzo_mcp.tools.shell.command_executor import CommandExecutor, CommandResult
import asyncio


class TestCommandResult:
    """Test the CommandResult class."""

    def test_initialization(self) -> None:
        """Test initializing a CommandResult."""
        result = CommandResult(
            return_code=0,
            stdout="Standard output",
            stderr="Standard error",
            error_message=None,
        )

        assert result.return_code == 0
        assert result.stdout == "Standard output"
        assert result.stderr == "Standard error"
        assert result.error_message is None

    def test_is_success(self) -> None:
        """Test the is_success property."""
        # Success case
        success = CommandResult(return_code=0)
        assert success.is_success

        # Failure case
        failure = CommandResult(return_code=1)
        assert not failure.is_success

    def test_format_output_success(self) -> None:
        """Test formatting output for successful commands."""
        result = CommandResult(return_code=0, stdout="Command output", stderr="")

        formatted = result.format_output()
        assert "Exit code: 0" in formatted
        assert "Command output" in formatted

    def test_format_output_failure(self) -> None:
        """Test formatting output for failed commands."""
        result = CommandResult(
            return_code=1,
            stdout="Command output",
            stderr="Error message",
            error_message="Execution failed",
        )

        formatted = result.format_output()
        assert "Error: Execution failed" in formatted
        assert "Command output" in formatted
        assert "Error message" in formatted

    def test_format_output_without_exit_code(self) -> None:
        """Test formatting output without including exit code."""
        result = CommandResult(return_code=0, stdout="Command output", stderr="")

        formatted = result.format_output(include_exit_code=False)
        assert "Exit code: 0" not in formatted
        assert "Command output" in formatted


class TestCommandExecutor:
    """Test the CommandExecutor class."""

    @pytest.fixture
    def executor(self, permission_manager: "PermissionManager") -> CommandExecutor:
        """Create a CommandExecutor instance for testing."""
        return CommandExecutor(permission_manager)

    def test_initialization(self, permission_manager: "PermissionManager") -> None:
        """Test initializing CommandExecutor."""
        executor = CommandExecutor(permission_manager)

        assert executor.permission_manager is permission_manager
        assert not executor.verbose
        assert isinstance(executor.excluded_commands, list)

    def test_deny_command(self, executor: CommandExecutor) -> None:
        """Test denying a command."""
        # Add a new command to denied list
        executor.deny_command("custom_command")

        # Verify command is excluded
        assert "custom_command" in executor.excluded_commands

    def test_is_command_allowed(self, executor: CommandExecutor) -> None:
        """Test checking if a command is allowed."""
        # Allowed command
        assert executor.is_command_allowed("echo Hello")

        # Excluded base command
        assert not executor.is_command_allowed("rm -rf /")

        # Command with excluded pattern
        assert executor.is_command_allowed("ls | grep test")

        # Empty command
        assert not executor.is_command_allowed("")

    @pytest.mark.asyncio
    async def test_execute_command_allowed(
        self, executor: CommandExecutor, temp_dir: str
    ) -> None:
        """Test executing an allowed command."""
        # Create a test file
        test_file = os.path.join(temp_dir, "test_exec.txt")
        with open(test_file, "w") as f:
            f.write("test content")

        # Execute a command
        result: CommandResult = await executor.execute_command(
            f"cat {test_file}", cwd=temp_dir
        )

        # Verify result
        assert result.is_success
        assert "test content" in result.stdout
        assert result.stderr == ""

    @pytest.mark.asyncio
    async def test_execute_command_not_allowed(self, executor: CommandExecutor) -> None:
        """Test executing a command that is not allowed."""
        # Try an excluded command
        result = await executor.execute_command("rm test.txt")

        # Verify result
        assert not result.is_success
        assert "Command not allowed" in result.error_message

    @pytest.mark.asyncio
    async def test_execute_command_with_invalid_cwd(
        self, executor: CommandExecutor
    ) -> None:
        """Test executing a command with an invalid working directory."""
        # Try with non-existent directory
        result = await executor.execute_command("ls", cwd="/nonexistent/dir")

        # Verify result
        assert not result.is_success
        assert "Working directory does not exist" in result.error_message

    @pytest.mark.asyncio
    async def test_execute_command_with_timeout(
        self, executor: CommandExecutor
    ) -> None:
        """Test command execution with timeout."""
        # Execute a command that sleeps
        result = await executor.execute_command("sleep 5", timeout=0.1)

        # Verify result
        assert not result.is_success
        assert "Command timed out" in result.error_message

    @pytest.mark.asyncio
    async def test_execute_script(
        self, executor: CommandExecutor, temp_dir: str
    ) -> None:
        """Test executing a script."""
        # Mock the _execute_script_with_stdin method
        with patch.object(executor, "_execute_script_with_stdin") as mock_execute:
            mock_execute.return_value = CommandResult(0, "Script output", "")

            # Execute script
            script = "echo 'test'"
            result = await executor.execute_script(script, "bash", cwd=temp_dir)

            # Verify some method was called to execute the script
            mock_execute.assert_called_once()

            # Verify result
            assert result.is_success
            assert "Script output" in result.stdout

    @pytest.mark.asyncio
    async def test_handle_fish_script(
        self, executor: CommandExecutor, temp_dir: str
    ) -> None:
        """Test special handling for Fish shell scripts."""
        # Patch asyncio.create_subprocess_shell
        with patch("asyncio.create_subprocess_shell") as mock_subprocess:
            # Setup mock process
            mock_process = AsyncMock()
            mock_process.returncode = 0
            mock_process.communicate = AsyncMock(return_value=(b"Fish output", b""))
            mock_subprocess.return_value = mock_process

            # Execute Fish script
            script = "echo 'test'"
            result = await executor._handle_fish_script("fish", script, temp_dir)

            # Verify subprocess was called
            mock_subprocess.assert_called_once()
            assert "fish" in mock_subprocess.call_args[0][0]

            # Verify result
            assert result.is_success
            assert "Fish output" in result.stdout

    @pytest.mark.asyncio
    async def test_execute_script_from_file(
        self, executor: CommandExecutor, temp_dir: str
    ) -> None:
        """Test executing a script from a temporary file."""
        # Patch asyncio.create_subprocess_exec
        with patch("asyncio.create_subprocess_shell") as mock_subprocess:
            # Setup mock process
            mock_process = AsyncMock()
            mock_process.returncode = 0
            mock_process.communicate = AsyncMock(return_value=(b"Python output", b""))
            mock_subprocess.return_value = mock_process

            # Execute Python script
            script = "print('Hello, world!')"
            result = await executor.execute_script_from_file(
                script=script, language="python", cwd=temp_dir
            )

            # Verify subprocess was called with python
            mock_subprocess.assert_called_once()
            assert "python" in mock_subprocess.call_args[0][0]

            # Verify result
            assert result.is_success
            assert "Python output" in result.stdout

    def test_get_available_languages(self, executor: CommandExecutor) -> None:
        """Test getting available script languages."""
        languages = executor.get_available_languages()

        assert isinstance(languages, list)
        assert "python" in languages
        assert "javascript" in languages
        assert "bash" in languages

    @pytest.mark.asyncio
    async def test_execute_command_with_cd(
        self, executor: CommandExecutor, temp_dir: str
    ) -> None:
        """Test executing a command that combines cd with another command."""
        # Create a test file in the temp directory
        test_file = os.path.join(temp_dir, "test_exec.txt")
        with open(test_file, "w") as f:
            f.write("test content")

        # The command string that combines cd and cat
        combined_command = f"cd {temp_dir} && cat test_exec.txt"

        # Execute the command
        result: CommandResult = await executor.execute_command(combined_command)

        # Verify result
        assert result.is_success
        assert "test content" in result.stdout
        assert result.stderr == ""

        # Test with a non-existent directory
        bad_command = "cd /nonexistent/dir && ls"
        result = await executor.execute_command(bad_command)

        # Command should fail because of the cd to non-existent directory
        assert not result.is_success
        assert result.return_code != 0  # Specific error code depends on the shell

    @pytest.mark.asyncio
    async def test_execute_command_with_env_vars(
        self, executor: CommandExecutor
    ) -> None:
        """Test executing a command with environment variables."""
        # Execute a command that echoes an environment variable
        result: CommandResult = await executor.execute_command("echo $PATH")

        # Verify result - $PATH should be expanded
        assert result.is_success
        # PATH should contain directories separated by colons
        assert ":" in result.stdout
        # The output should not just be the literal string "$PATH"
        assert result.stdout.strip() != "$PATH"

    # CommandExecutor no longer has register_tools method in new architecture
    # Tools are now registered through register_shell_tools function
    # @pytest.mark.asyncio
    # async def test_register_tools(self, executor: CommandExecutor) -> None:
    #     """Test registering command execution tools."""
    #     # This test is no longer applicable as tools are registered 
    #     # through the hanzo_mcp.tools.shell.register_shell_tools function
    #     pass
