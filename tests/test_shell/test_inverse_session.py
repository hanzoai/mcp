"""Tests for the inverse of session behavior - commands without session state."""

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


@pytest.mark.asyncio
async def test_stateless_commands(command_executor):
    """Test that commands without session_id don't maintain state."""
    # Execute a command to set the working directory
    result1 = await command_executor.execute_command(
        command="cd /tmp"
        # No session_id provided - should be stateless
    )
    
    # Should fall back to the current working directory
    cwd = os.getcwd()
    
    # Execute another command 
    with patch.object(
        command_executor, '_execute_script_with_stdin', new_callable=AsyncMock
    ) as mock_execute:
        mock_execute.return_value = CommandResult(return_code=0, stdout="test output")
        
        result2 = await command_executor.execute_script(
            script="echo hello",
            interpreter="bash"
            # No session_id provided - should be stateless
        )
        
        # Verify the working directory is the explicitly provided one or falls back to cwd
        mock_execute.assert_called_once()
        args, kwargs = mock_execute.call_args
        assert kwargs.get("cwd") is None or kwargs.get("cwd") == cwd  # Should use current working directory 


@pytest.mark.asyncio
async def test_different_sessions_independence(command_executor):
    """Test that different sessions don't affect each other."""
    # Session 1 - set working directory to /tmp
    await command_executor.execute_command(
        command="cd /tmp",
        session_id="session1"
    )
    
    # Session 2 - set working directory to /var
    await command_executor.execute_command(
        command="cd /var",
        session_id="session2"
    )
    
    # Session 3 - no commands yet
    
    # Verify session 1 is in /tmp
    assert command_executor.get_working_dir("session1") == "/tmp"
    
    # Verify session 2 is in /var
    assert command_executor.get_working_dir("session2") == "/var"
    
    # Verify session 3 defaults to current directory
    assert command_executor.get_working_dir("session3") == os.getcwd()


@pytest.mark.asyncio
async def test_reset_session(command_executor):
    """Test resetting a session back to initial state."""
    # Note the initial directory
    original_dir = os.getcwd()
    
    # Set up a session with a working directory
    session_id = "reset-test-session"
    await command_executor.execute_command(
        command="cd /tmp",
        session_id=session_id
    )
    
    # Verify working directory was changed
    assert command_executor.get_working_dir(session_id) == "/tmp"
    
    # Reset the session
    session = SessionManager.get_instance(session_id)
    session.reset_working_dir()
    
    # Verify it's back to the initial directory
    assert command_executor.get_working_dir(session_id) == original_dir


@pytest.mark.asyncio  
async def test_nonexistent_directory(command_executor):
    """Test trying to CD to a nonexistent directory."""
    session_id = "nonexistent-dir-session"
    
    # Try to CD to a nonexistent directory
    result = await command_executor.execute_command(
        command="cd /path/that/does/not/exist",
        session_id=session_id
    )
    
    # Should fail with an error
    assert result.return_code != 0
    assert "does not exist" in result.error_message or "not allowed" in result.error_message
    
    # Working directory should remain unchanged (should be current directory)
    assert command_executor.get_working_dir(session_id) == os.getcwd()