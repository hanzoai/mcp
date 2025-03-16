"""Tests for the command executor module."""

import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mcp_claude_code.tools.shell.command_executor import CommandExecutor, CommandResult


class TestCommandResult:
    """Test the CommandResult class."""
    
    def test_initialization(self):
        """Test initializing a CommandResult."""
        result = CommandResult(
            return_code=0,
            stdout="Standard output",
            stderr="Standard error",
            error_message=None
        )
        
        assert result.return_code == 0
        assert result.stdout == "Standard output"
        assert result.stderr == "Standard error"
        assert result.error_message is None
    
    def test_is_success(self):
        """Test the is_success property."""
        # Success case
        success = CommandResult(return_code=0)
        assert success.is_success
        
        # Failure case
        failure = CommandResult(return_code=1)
        assert not failure.is_success
    
    def test_format_output_success(self):
        """Test formatting output for successful commands."""
        result = CommandResult(
            return_code=0,
            stdout="Command output",
            stderr=""
        )
        
        formatted = result.format_output()
        assert "Exit code: 0" in formatted
        assert "Command output" in formatted
    
    def test_format_output_failure(self):
        """Test formatting output for failed commands."""
        result = CommandResult(
            return_code=1,
            stdout="Command output",
            stderr="Error message",
            error_message="Execution failed"
        )
        
        formatted = result.format_output()
        assert "Error: Execution failed" in formatted
        assert "Command output" in formatted
        assert "Error message" in formatted
    
    def test_format_output_without_exit_code(self):
        """Test formatting output without including exit code."""
        result = CommandResult(
            return_code=0,
            stdout="Command output",
            stderr=""
        )
        
        formatted = result.format_output(include_exit_code=False)
        assert "Exit code: 0" not in formatted
        assert "Command output" in formatted


class TestCommandExecutor:
    """Test the CommandExecutor class."""
    
    @pytest.fixture
    def executor(self, permission_manager):
        """Create a CommandExecutor instance for testing."""
        return CommandExecutor(permission_manager)
    
    def test_initialization(self, permission_manager):
        """Test initializing CommandExecutor."""
        executor = CommandExecutor(permission_manager)
        
        assert executor.permission_manager is permission_manager
        assert not executor.verbose
        assert isinstance(executor.excluded_commands, list)
        assert isinstance(executor.excluded_patterns, list)
        
        # Verify default exclusions were added
        assert "rm" in executor.excluded_commands
        assert "sudo" in executor.excluded_commands
        assert ">" in executor.excluded_patterns
    
    def test_allow_command(self, executor):
        """Test allowing a command."""
        # First verify command is excluded
        assert "rm" in executor.excluded_commands
        
        # Allow the command
        executor.allow_command("rm")
        
        # Verify command is no longer excluded
        assert "rm" not in executor.excluded_commands
    
    def test_deny_command(self, executor):
        """Test denying a command."""
        # Add a new command to denied list
        executor.deny_command("custom_command")
        
        # Verify command is excluded
        assert "custom_command" in executor.excluded_commands
    
    def test_is_command_allowed(self, executor):
        """Test checking if a command is allowed."""
        # Allowed command
        assert executor.is_command_allowed("echo Hello")
        
        # Excluded base command
        assert not executor.is_command_allowed("rm -rf /")
        
        # Command with excluded pattern
        assert not executor.is_command_allowed("ls | grep test")
        
        # Empty command
        assert not executor.is_command_allowed("")
    
    @pytest.mark.asyncio
    async def test_execute_command_allowed(self, executor, temp_dir):
        """Test executing an allowed command."""
        # Create a test file
        test_file = os.path.join(temp_dir, "test_exec.txt")
        with open(test_file, 'w') as f:
            f.write("test content")
        
        # Execute a command
        result = await executor.execute_command(f"cat {test_file}", cwd=temp_dir)
        
        # Verify result
        assert result.is_success
        assert "test content" in result.stdout
        assert result.stderr == ""
    
    @pytest.mark.asyncio
    async def test_execute_command_not_allowed(self, executor):
        """Test executing a command that is not allowed."""
        # Try an excluded command
        result = await executor.execute_command("rm test.txt")
        
        # Verify result
        assert not result.is_success
        assert "Command not allowed" in result.error_message
    
    @pytest.mark.asyncio
    async def test_execute_command_with_invalid_cwd(self, executor):
        """Test executing a command with an invalid working directory."""
        # Try with non-existent directory
        result = await executor.execute_command("ls", cwd="/nonexistent/dir")
        
        # Verify result
        assert not result.is_success
        assert "Working directory does not exist" in result.error_message
    
    @pytest.mark.asyncio
    async def test_execute_command_with_timeout(self, executor):
        """Test command execution with timeout."""
        # Execute a command that sleeps
        result = await executor.execute_command("sleep 5", timeout=0.1)
        
        # Verify result
        assert not result.is_success
        assert "Command timed out" in result.error_message
    
    @pytest.mark.asyncio
    async def test_execute_script(self, executor, temp_dir):
        """Test executing a script."""
        # Mock the _execute_script_with_stdin method
        with patch.object(executor, "_execute_script_with_stdin") as mock_execute:
            mock_execute.return_value = CommandResult(0, "Script output", "")
            
            # Execute script
            script = "echo 'test'"
            result = await executor.execute_script(script, "bash", cwd=temp_dir)
            
            # Verify method was called correctly
            mock_execute.assert_called_once_with("bash", script, temp_dir, None, 60.0)
            
            # Verify result
            assert result.is_success
            assert "Script output" in result.stdout
    
    @pytest.mark.asyncio
    async def test_handle_fish_script(self, executor, temp_dir):
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
    async def test_execute_script_from_file(self, executor, temp_dir):
        """Test executing a script from a temporary file."""
        # Patch asyncio.create_subprocess_exec
        with patch("asyncio.create_subprocess_exec") as mock_subprocess:
            # Setup mock process
            mock_process = AsyncMock()
            mock_process.returncode = 0
            mock_process.communicate = AsyncMock(return_value=(b"Python output", b""))
            mock_subprocess.return_value = mock_process
            
            # Execute Python script
            script = "print('Hello, world!')"
            result = await executor.execute_script_from_file(
                script=script,
                language="python",
                cwd=temp_dir
            )
            
            # Verify subprocess was called with python
            mock_subprocess.assert_called_once()
            assert mock_subprocess.call_args[0][0] == "python"
            
            # Verify result
            assert result.is_success
            assert "Python output" in result.stdout
    
    def test_get_available_languages(self, executor):
        """Test getting available script languages."""
        languages = executor.get_available_languages()
        
        assert isinstance(languages, list)
        assert "python" in languages
        assert "javascript" in languages
        assert "bash" in languages
    
    @pytest.mark.asyncio
    async def test_register_tools(self, executor):
        """Test registering command execution tools."""
        mock_server = MagicMock()
        tools = {}
        
        def mock_decorator(func):
            tools[func.__name__] = func
            return func
            
        mock_server.tool = mock_decorator
        
        # Register tools
        executor.register_tools(mock_server)
        
        # Verify tools were registered
        assert "run_command" in tools
        assert "run_script" in tools
        assert "script_tool" in tools
        
        # Test run_command tool
        with patch.object(executor, "execute_command") as mock_execute:
            mock_execute.return_value = CommandResult(0, "Command output", "")
            
            # Create mock context
            mock_context = AsyncMock()
            mock_tool_ctx = AsyncMock()
            
            with patch("mcp_claude_code.tools.shell.command_executor.create_tool_context", return_value=mock_tool_ctx):
                # Call the run_command tool
                result = await tools["run_command"]("echo test", mock_context)
                
                # Verify execution and result
                mock_execute.assert_called_once()
                assert "Command output" in result
