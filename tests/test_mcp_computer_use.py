"""Tests for the MCP computer use interface.

This module contains tests for the integration with the computer-use MCP server.
"""

import json
import os
from unittest.mock import patch, MagicMock, ANY

import pytest

from hanzo_mcp.tools.mcp_manager import MCPServer, MCPServerManager


def test_mcp_server_init():
    """Test initialization of an MCPServer."""
    server = MCPServer(
        name="computer-use",
        command="uvx",
        args=["mcp-server-computer-use"],
        env={"ENV_VAR": "value"},
        description="Provides full computer access"
    )

    assert server.name == "computer-use"
    assert server.command == "uvx"
    assert server.args == ["mcp-server-computer-use"]
    assert server.env == {"ENV_VAR": "value"}
    assert server.description == "Provides full computer access"
    assert server.process is None
    assert server.running is False
    assert server.tools == {}
    assert server.socket_path is None
    assert server.pid is None
    assert server.start_time is None
    assert server.last_error is None


def test_mcp_server_get_full_command():
    """Test getting the full command for an MCPServer."""
    server = MCPServer(
        name="computer-use",
        command="uvx",
        args=["mcp-server-computer-use"],
    )

    full_command = server.get_full_command()
    assert full_command == ["uvx", "mcp-server-computer-use"]


def test_mcp_server_get_env():
    """Test getting the environment variables for an MCPServer."""
    server = MCPServer(
        name="computer-use",
        command="uvx",
        args=["mcp-server-computer-use"],
        env={"CUSTOM_ENV": "value"}
    )

    with patch.dict(os.environ, {"EXISTING_ENV": "existing"}):
        env = server.get_env()
        
        # Check that existing environment variables are preserved
        assert "EXISTING_ENV" in env
        assert env["EXISTING_ENV"] == "existing"
        
        # Check that custom environment variables are added
        assert "CUSTOM_ENV" in env
        assert env["CUSTOM_ENV"] == "value"


def test_mcp_server_to_dict():
    """Test converting an MCPServer to a dictionary."""
    server = MCPServer(
        name="computer-use",
        command="uvx",
        args=["mcp-server-computer-use"],
        description="Provides full computer access"
    )
    
    # Set some additional properties
    server.running = True
    server.pid = 12345
    server.start_time = 1622825822.123
    server.tools = {"tool1": {}, "tool2": {}}
    
    # Convert to dictionary
    server_dict = server.to_dict()
    
    # Verify the dictionary contents
    assert server_dict["name"] == "computer-use"
    assert server_dict["description"] == "Provides full computer access"
    assert server_dict["command"] == "uvx"
    assert server_dict["args"] == ["mcp-server-computer-use"]
    assert server_dict["running"] is True
    assert server_dict["pid"] == 12345
    assert server_dict["start_time"] == 1622825822.123
    assert server_dict["tool_count"] == 2
    assert server_dict["tools"] == ["tool1", "tool2"]


def test_mcp_manager_get_server(mock_mcp_manager):
    """Test getting a server by name."""
    # Test with existing server
    server = mock_mcp_manager.get_server("test_server")
    assert server is not None
    assert server.name == "test_server"
    
    # Test with non-existent server
    server = mock_mcp_manager.get_server("nonexistent")
    assert server is None


def test_mcp_manager_get_servers(mock_mcp_manager):
    """Test getting all servers."""
    servers = mock_mcp_manager.get_servers()
    assert len(servers) == 1
    assert "test_server" in servers


def test_mcp_manager_get_server_info(mock_mcp_manager, mock_mcp_server):
    """Test getting information about a server."""
    # Set up mock to_dict method
    mock_mcp_server.to_dict.return_value = {
        "name": "test_server",
        "description": "Test server",
        "command": "test_command",
        "args": ["arg1", "arg2"],
        "running": False,
        "pid": None,
        "start_time": None,
        "tool_count": 0,
        "tools": []
    }
    
    # Test with existing server
    info = mock_mcp_manager.get_server_info("test_server")
    assert info == mock_mcp_server.to_dict.return_value
    
    # Test with non-existent server
    info = mock_mcp_manager.get_server_info("nonexistent")
    assert "error" in info
    assert info["error"] == "Server not found: nonexistent"


def test_mcp_manager_get_all_server_info(mock_mcp_manager, mock_mcp_server):
    """Test getting information about all servers."""
    # Set up mock to_dict method
    mock_mcp_server.to_dict.return_value = {
        "name": "test_server",
        "description": "Test server",
        "command": "test_command",
        "args": ["arg1", "arg2"],
        "running": False,
        "pid": None,
        "start_time": None,
        "tool_count": 0,
        "tools": []
    }
    
    # Get all server info
    all_info = mock_mcp_manager.get_all_server_info()
    
    # Verify the result
    assert len(all_info) == 1
    assert "test_server" in all_info
    assert all_info["test_server"] == mock_mcp_server.to_dict.return_value


def test_mcp_manager_add_server(mock_mcp_manager):
    """Test adding a new server."""
    with patch.object(mock_mcp_manager, "save_config") as mock_save_config:
        # Add a new server
        result = mock_mcp_manager.add_server(
            name="new_server",
            command="new_command",
            args=["arg1", "arg2"],
            description="New server",
            save=True
        )
        
        # Verify the result
        assert result is True
        assert "new_server" in mock_mcp_manager.servers
        assert mock_mcp_manager.servers["new_server"].name == "new_server"
        assert mock_mcp_manager.servers["new_server"].command == "new_command"
        assert mock_mcp_manager.servers["new_server"].args == ["arg1", "arg2"]
        assert mock_mcp_manager.servers["new_server"].description == "New server"
        mock_save_config.assert_called_once()
        
        # Try to add a server with an existing name
        mock_save_config.reset_mock()
        result = mock_mcp_manager.add_server(
            name="test_server",
            command="another_command",
            args=[],
            save=True
        )
        
        # Verify the result
        assert result is False
        mock_save_config.assert_not_called()


def test_mcp_manager_remove_server(mock_mcp_manager, mock_mcp_server):
    """Test removing a server."""
    with patch.object(mock_mcp_manager, "save_config") as mock_save_config:
        # Test with a running server
        mock_mcp_server.running = True
        
        # Mock the stop_server method
        with patch.object(mock_mcp_manager, "stop_server") as mock_stop_server:
            mock_stop_server.return_value = {"success": True, "message": "Stopped server"}
            
            # Store the initial state of servers
            initial_servers = mock_mcp_manager.servers.copy()
            
            # Remove the server
            result = mock_mcp_manager.remove_server(
                name="test_server",
                save=True
            )
            
            # Verify the result
            assert result is True
            assert "test_server" not in mock_mcp_manager.servers
            mock_stop_server.assert_called_once_with("test_server")
            mock_save_config.assert_called_once()
            
            # Restore the server for other tests
            mock_mcp_manager.servers = initial_servers
            
            # Test with a non-existent server
            mock_save_config.reset_mock()
            mock_stop_server.reset_mock()
            result = mock_mcp_manager.remove_server(
                name="nonexistent",
                save=True
            )
            
            # Verify the result
            assert result is False
            mock_stop_server.assert_not_called()
            mock_save_config.assert_not_called()


@patch("subprocess.Popen")
def test_mcp_manager_start_server(mock_popen, mock_mcp_manager, mock_mcp_server):
    """Test starting a server."""
    # Set up mock process
    mock_process = MagicMock()
    mock_popen.return_value = mock_process
    mock_process.pid = 12345
    
    # Test starting an existing server
    mock_mcp_server.running = False
    mock_mcp_server.process = None
    mock_mcp_server.get_full_command.return_value = ["test_command", "arg1", "arg2"]
    mock_mcp_server.get_env.return_value = {"ENV_VAR": "value"}
    
    result = mock_mcp_manager.start_server("test_server")
    
    # Verify the result
    assert result["success"] is True
    assert "pid" in result
    assert result["pid"] == 12345
    mock_popen.assert_called_once_with(
        ["test_command", "arg1", "arg2"],
        env={"ENV_VAR": "value"},
        stdout=ANY,
        stderr=ANY,
        text=True,
        bufsize=1,
        universal_newlines=True
    )
    
    # Test starting an already running server
    mock_popen.reset_mock()
    mock_mcp_server.running = True
    
    result = mock_mcp_manager.start_server("test_server")
    
    # Verify the result
    assert result["success"] is True
    assert "already running" in result["message"].lower()
    mock_popen.assert_not_called()
    
    # Test starting a non-existent server
    mock_popen.reset_mock()
    
    result = mock_mcp_manager.start_server("nonexistent")
    
    # Verify the result
    assert result["success"] is False
    assert "server not found" in result["error"].lower()
    mock_popen.assert_not_called()


@patch("os.kill")
def test_mcp_manager_stop_server(mock_kill, mock_mcp_manager, mock_mcp_server):
    """Test stopping a server."""
    # Test stopping a running server
    mock_mcp_server.running = True
    mock_mcp_server.pid = 12345
    mock_process = MagicMock()
    mock_mcp_server.process = mock_process
    
    with patch("platform.system", return_value="Linux"):
        result = mock_mcp_manager.stop_server("test_server")
        
        # Verify the result
        assert result["success"] is True
        mock_kill.assert_called_once()
        mock_process.wait.assert_called_once()
        assert mock_mcp_server.process is None
        assert mock_mcp_server.running is False
        assert mock_mcp_server.pid is None
        assert mock_mcp_server.tools == {}
    
    # Test stopping a server that's not running
    mock_kill.reset_mock()
    mock_mcp_server.running = False
    mock_mcp_server.process = None
    
    result = mock_mcp_manager.stop_server("test_server")
    
    # Verify the result
    assert result["success"] is True
    assert "not running" in result["message"].lower()
    mock_kill.assert_not_called()
    
    # Test stopping a non-existent server
    mock_kill.reset_mock()
    
    result = mock_mcp_manager.stop_server("nonexistent")
    
    # Verify the result
    assert result["success"] is False
    assert "server not found" in result["error"].lower()
    mock_kill.assert_not_called()


def test_mcp_manager_start_all_servers(mock_mcp_manager):
    """Test starting all servers."""
    # Add another server
    mock_mcp_manager.servers["another_server"] = MagicMock()
    
    # Mock the start_server method
    with patch.object(mock_mcp_manager, "start_server") as mock_start_server:
        mock_start_server.side_effect = lambda name: {"success": True, "message": f"Started {name}"}
        
        # Start all servers
        results = mock_mcp_manager.start_all_servers()
        
        # Verify the results
        assert len(results) == 2
        assert "test_server" in results
        assert "another_server" in results
        assert mock_start_server.call_count == 2


def test_mcp_manager_stop_all_servers(mock_mcp_manager, mock_mcp_server):
    """Test stopping all running servers."""
    # Set up first server as running
    mock_mcp_server.running = True
    
    # Add another server that's not running
    not_running_server = MagicMock()
    not_running_server.running = False
    mock_mcp_manager.servers["not_running_server"] = not_running_server
    
    # Mock the stop_server method
    with patch.object(mock_mcp_manager, "stop_server") as mock_stop_server:
        mock_stop_server.side_effect = lambda name: {"success": True, "message": f"Stopped {name}"}
        
        # Stop all servers
        results = mock_mcp_manager.stop_all_servers()
        
        # Verify the results
        assert len(results) == 1
        assert "test_server" in results
        assert "not_running_server" not in results
        mock_stop_server.assert_called_once_with("test_server")


def test_mcp_manager_get_available_tools(mock_mcp_manager, mock_mcp_server):
    """Test getting all available tools from running servers."""
    # Set up first server as running with tools
    mock_mcp_server.running = True
    mock_mcp_server.tools = {
        "tool1": {"name": "tool1", "description": "Tool 1"},
        "tool2": {"name": "tool2", "description": "Tool 2"}
    }
    
    # Add another server that's not running
    not_running_server = MagicMock()
    not_running_server.running = False
    not_running_server.tools = {"tool3": {"name": "tool3", "description": "Tool 3"}}
    mock_mcp_manager.servers["not_running_server"] = not_running_server
    
    # Get available tools
    tools = mock_mcp_manager.get_available_tools()
    
    # Verify the results
    assert len(tools) == 2
    assert "test_server.tool1" in tools
    assert "test_server.tool2" in tools
    assert "not_running_server.tool3" not in tools
    assert tools["test_server.tool1"]["server"] == "test_server"
    assert tools["test_server.tool1"]["name"] == "tool1"
    assert tools["test_server.tool1"]["definition"] == {"name": "tool1", "description": "Tool 1"}


def test_mcp_manager_register_server_tools(mock_mcp_manager, mock_mcp_server):
    """Test registering tools for a server."""
    # Define tools to register
    tools = {
        "tool1": {"name": "tool1", "description": "Tool 1"},
        "tool2": {"name": "tool2", "description": "Tool 2"}
    }
    
    # Register tools for an existing server
    result = mock_mcp_manager.register_server_tools("test_server", tools)
    
    # Verify the result
    assert result["success"] is True
    assert result["tool_count"] == 2
    assert mock_mcp_server.tools == tools
    
    # Test registering tools for a non-existent server
    result = mock_mcp_manager.register_server_tools("nonexistent", tools)
    
    # Verify the result
    assert result["success"] is False
    assert "server not found" in result["error"].lower()


# Integration tests for computer-use server specifically

@pytest.fixture
def computer_use_server():
    """Create a computer-use server for testing."""
    return MCPServer(
        name="computer-use",
        command="uvx",
        args=["mcp-server-computer-use"],
        env={},
        description="Provides full computer access"
    )


@patch("subprocess.Popen")
def test_computer_use_server_start(mock_popen, computer_use_server):
    """Test starting the computer-use server."""
    # Set up mock process
    mock_process = MagicMock()
    mock_popen.return_value = mock_process
    mock_process.pid = 12345
    
    manager = MCPServerManager(auto_load=False)
    manager.servers = {"computer-use": computer_use_server}
    
    # Start the server
    result = manager.start_server("computer-use")
    
    # Verify the result
    assert result["success"] is True
    assert computer_use_server.running is True
    assert computer_use_server.pid == 12345
    
    # Check that the command was correctly formed
    mock_popen.assert_called_once_with(
        ["uvx", "mcp-server-computer-use"],
        env=ANY,
        stdout=ANY,
        stderr=ANY,
        text=True,
        bufsize=1,
        universal_newlines=True
    )


@patch("os.kill")
def test_computer_use_server_stop(mock_kill, computer_use_server):
    """Test stopping the computer-use server."""
    computer_use_server.running = True
    computer_use_server.pid = 12345
    mock_process = MagicMock()
    computer_use_server.process = mock_process
    
    manager = MCPServerManager(auto_load=False)
    manager.servers = {"computer-use": computer_use_server}
    
    with patch("platform.system", return_value="Linux"):
        result = manager.stop_server("computer-use")
        
        # Verify the result
        assert result["success"] is True
        mock_kill.assert_called_once()
        assert computer_use_server.running is False
        assert computer_use_server.pid is None
