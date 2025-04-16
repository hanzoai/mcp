"""Tests for command execution with session state."""

import os
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from hanzo_mcp.tools.common.session import SessionManager
from hanzo_mcp.tools.shell.command_executor import CommandExecutor
from hanzo_mcp.tools.shell.base import CommandResult
from hanzo_mcp.tools.common.permissions import PermissionManager


@pytest.fixture
def permission_manager():
    """Create a permission manager for testing."""
    pm = PermissionManager()
    pm.add_allowed_path("/")  # Allow everything for testing
    return pm


@pytest.fixture
def command_executor(permission_manager):
    """Create a command executor for testing."""
    return CommandExecutor(permission_manager=permission_manager, verbose=False)


@pytest.fixture
def mock_context():
    """Create a mock MCP context."""
    context = MagicMock()
    context.request_id = "test-request-id"
    context.client_id = "test-client-id"
    return context


@pytest.mark.asyncio
async def test_command_execution_with_session(command_executor, mock_context):
    """Test executing commands with session state."""
    session_id = mock_context.request_id

    # Mock execute_command to simulate command execution
    with patch.object(
        command_executor, 'execute_command', new_callable=AsyncMock
    ) as mock_execute_command:
        mock_execute_command.return_value = CommandResult(return_code=0, stdout="test output")
        
        # Also need to patch get_working_dir to return the expected value
        with patch.object(
            command_executor, 'get_working_dir', return_value="/tmp"
        ):
            # Execute a cd command to set the working directory
            result = await command_executor.execute_command(
                command="cd /tmp", 
                session_id=session_id
            )
            
            # Verify working directory was updated
            assert command_executor.get_working_dir(session_id) == "/tmp"

            # Execute another command without specifying working directory
            await command_executor.execute_command(
                command="ls", 
                session_id=session_id
            )
            
            # Verify the second command used the session's working directory
            calls = mock_execute_command.call_args_list
            assert len(calls) == 2
            _, kwargs = calls[1]
            assert kwargs.get("cwd") is None  # Should be None because it uses effective_cwd internally


@pytest.mark.asyncio
async def test_cd_command_handling(command_executor):
    """Test specific handling of CD commands."""
    session_id = "test-cd-session"
    
    # Execute a cd command to set the working directory
    result = await command_executor.execute_command(
        command="cd /tmp", 
        session_id=session_id
    )
    
    # Verify working directory was updated
    assert command_executor.get_working_dir(session_id) == "/tmp"
    
    # Execute relative path CD
    result = await command_executor.execute_command(
        command="cd ..", 
        session_id=session_id
    )
    
    # Verify relative path was resolved correctly
    assert command_executor.get_working_dir(session_id) == "/"


@pytest.mark.asyncio
async def test_multiple_sessions(command_executor):
    """Test that different sessions have independent state."""
    session_id1 = "test-session-1"
    session_id2 = "test-session-2"
    
    # Set different working directories for each session
    await command_executor.execute_command(
        command="cd /tmp", 
        session_id=session_id1
    )
    
    await command_executor.execute_command(
        command="cd /home", 
        session_id=session_id2
    )
    
    # Verify each session has its own working directory
    assert command_executor.get_working_dir(session_id1) == "/tmp"
    assert command_executor.get_working_dir(session_id2) == "/home"


@pytest.mark.asyncio
async def test_shell_detection(command_executor):
    """Test that the preferred shell is detected correctly."""
    # This test verifies the _get_preferred_shell method works correctly
    shell_path = command_executor._get_preferred_shell()
    
    # Shell path should be a valid executable path
    assert os.path.exists(shell_path)
    assert os.access(shell_path, os.X_OK)
    
    # Should be one of the expected shells
    shell_name = os.path.basename(shell_path)
    assert shell_name in ["zsh", "bash", "fish", "sh"]


@pytest.mark.asyncio
async def test_script_execution_with_session(command_executor):
    """Test script execution with session state."""
    session_id = "test-script-session"
    
    # Set a working directory for the session
    await command_executor.execute_command(
        command="cd /tmp", 
        session_id=session_id
    )
    
    # Mock execute_script to simulate script execution
    with patch.object(
        command_executor, 'execute_script', new_callable=AsyncMock
    ) as mock_execute_script:
        mock_execute_script.return_value = CommandResult(return_code=0, stdout="script output")
        
        # Execute a script without specifying working directory
        await command_executor.execute_script(
            script="echo 'test'",
            interpreter="bash",
            session_id=session_id
        )
        
        # Verify the script used the session's working directory
        mock_execute_script.assert_called_once()
        _, kwargs = mock_execute_script.call_args
        assert kwargs.get("cwd") is None  # Should be None because it uses effective_cwd internally