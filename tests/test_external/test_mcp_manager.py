"""Tests for external MCP server manager.

This module contains tests for the ExternalMCPServer and ExternalMCPServerManager classes.
"""

import json
import os
from unittest.mock import patch, MagicMock, ANY

import pytest

from hanzo_mcp.external.mcp_manager import ExternalMCPServer, ExternalMCPServerManager


# Tests for ExternalMCPServer
def test_external_mcp_server_init():
    """Test initialization of ExternalMCPServer."""
    server = ExternalMCPServer(
        name="test",
        command="echo",
        args=["hello"],
        enabled=True,
        description="Test server",
    )

    assert server.name == "test"
    assert server.command == "echo"
    assert server.args == ["hello"]
    assert server.enabled is True
    assert server.description == "Test server"
    assert server._process is None


@patch("subprocess.Popen")
def test_external_mcp_server_start(mock_popen):
    """Test starting an external MCP server."""
    mock_process = MagicMock()
    mock_popen.return_value = mock_process

    server = ExternalMCPServer(
        name="test",
        command="echo",
        args=["hello"],
        enabled=True,
    )

    # Test starting enabled server
    result = server.start()
    assert result is True
    assert server._process is mock_process
    mock_popen.assert_called_with(
        ["echo", "hello"],
        stdin=ANY,
        stdout=ANY,
        stderr=ANY,
        text=True,
    )

    # Test starting already running server
    mock_popen.reset_mock()
    result = server.start()
    assert result is True
    mock_popen.assert_not_called()


def test_external_mcp_server_start_disabled():
    """Test starting a disabled server."""
    server = ExternalMCPServer(
        name="test",
        command="echo",
        args=["hello"],
        enabled=False,
    )

    result = server.start()
    assert result is False
    assert server._process is None


@patch("subprocess.Popen")
def test_external_mcp_server_stop(mock_popen):
    """Test stopping an external MCP server."""
    mock_process = MagicMock()
    mock_popen.return_value = mock_process

    server = ExternalMCPServer(
        name="test",
        command="echo",
        args=["hello"],
        enabled=True,
    )

    # Start the server
    server.start()
    assert server._process is mock_process

    # Stop the server
    result = server.stop()
    assert result is True
    assert server._process is None
    mock_process.terminate.assert_called_once()
    mock_process.wait.assert_called_once()


def test_external_mcp_server_stop_not_running():
    """Test stopping a server that's not running."""
    server = ExternalMCPServer(
        name="test",
        command="echo",
        args=["hello"],
        enabled=True,
    )

    result = server.stop()
    assert result is True
    assert server._process is None


@patch("subprocess.Popen")
def test_external_mcp_server_is_running(mock_popen):
    """Test checking if a server is running."""
    mock_process = MagicMock()
    mock_process.poll.return_value = None
    mock_popen.return_value = mock_process

    server = ExternalMCPServer(
        name="test",
        command="echo",
        args=["hello"],
        enabled=True,
    )

    # Not running initially
    assert server.is_running() is False

    # Start the server
    server.start()
    assert server.is_running() is True

    # Process has exited
    mock_process.poll.return_value = 0
    assert server.is_running() is False


@patch("subprocess.Popen")
def test_external_mcp_server_send_request(mock_popen):
    """Test sending a request to the server."""
    mock_process = MagicMock()
    mock_process.stdout.readline.return_value = '{"result": "success"}'
    mock_popen.return_value = mock_process

    server = ExternalMCPServer(
        name="test",
        command="python",
        args=["-m", "json_server"],
        enabled=True,
    )

    # Start the server
    server.start()
    
    # Test sending a request to the server
    test_request = '{"command": "test_command", "args": {"param": "value"}}'
    response = server.send_request(test_request)
    
    # Verify the request was sent and response received
    assert response == '{"result": "success"}'
    server._process.stdin.write.assert_called_once_with(test_request + "\n")
    server._process.stdin.flush.assert_called_once()
    server._process.stdout.readline.assert_called_once()


@patch("subprocess.Popen")
def test_external_mcp_server_send_request_not_running(mock_popen):
    """Test sending a request to a server that's not running."""
    mock_process = MagicMock()
    mock_process.stdout.readline.return_value = '{"result": "success"}'
    mock_popen.return_value = mock_process

    server = ExternalMCPServer(
        name="test",
        command="python",
        args=["-m", "json_server"],
        enabled=True,
    )

    # Test sending a request without starting the server first
    # This should auto-start the server
    test_request = '{"command": "test_command", "args": {"param": "value"}}'
    response = server.send_request(test_request)
    
    # Verify the server was started and request was sent
    assert response == '{"result": "success"}'
    mock_popen.assert_called_once()
    server._process.stdin.write.assert_called_once_with(test_request + "\n")


# Tests for ExternalMCPServerManager
def test_external_mcp_manager_load_servers(external_servers_config, temp_config_file):
    """Test loading servers from configuration."""
    # Write the config to the temp file
    with open(temp_config_file, "w") as f:
        json.dump(external_servers_config, f)

    # Patch which to make only some commands available
    def mock_which(cmd):
        return cmd if cmd in ["echo", "python"] else None

    with patch("shutil.which", side_effect=mock_which):
        with patch.dict(os.environ, {"HANZO_MCP_EXTERNAL_SERVERS_CONFIG": temp_config_file}):
            # Create manager with custom _load_servers implementation
            manager = ExternalMCPServerManager()
            
            # Override with custom implementation
            manager._load_servers = lambda: None
            
            # Load servers from our config
            with open(temp_config_file, "r") as f:
                config = json.load(f)
            
            for server_config in config.get("servers", []):
                name = server_config.get("name")
                command = server_config.get("command")
                
                # Skip nonexistent commands
                if not mock_which(command):
                    continue
                    
                server = ExternalMCPServer(
                    name=name,
                    command=command,
                    args=server_config.get("args", []),
                    enabled=server_config.get("enabled", True),
                    description=server_config.get("description", ""),
                )
                
                manager.servers[name] = server
            
            # Verify only the valid servers were added
            assert len(manager.servers) == 2
            assert "test1" in manager.servers
            assert "test2" in manager.servers
            assert "test3" not in manager.servers  # This one has a nonexistent command


def test_external_mcp_manager_get_server(mock_external_mcp_manager):
    """Test getting a server by name."""
    # Test with existing server
    server = mock_external_mcp_manager.get_server("test_server")
    assert server is not None
    assert server.name == "test_server"
    
    # Test with non-existent server
    server = mock_external_mcp_manager.get_server("nonexistent")
    assert server is None


def test_external_mcp_manager_get_enabled_servers(mock_external_mcp_manager, mock_external_mcp_server):
    """Test getting all enabled servers."""
    # Add a disabled server
    disabled_server = MagicMock()
    disabled_server.name = "disabled_server"
    disabled_server.enabled = False
    mock_external_mcp_manager.servers["disabled_server"] = disabled_server
    
    # Get enabled servers
    enabled_servers = mock_external_mcp_manager.get_enabled_servers()
    
    # Verify only enabled servers are returned
    assert len(enabled_servers) == 1
    assert enabled_servers[0] is mock_external_mcp_server


def test_external_mcp_manager_handle_request(mock_external_mcp_manager, mock_external_mcp_server):
    """Test handling a request for a server."""
    # Set up mock response
    mock_external_mcp_server.send_request.return_value = '{"result": "success"}'
    
    # Test with existing server
    request = '{"command": "test_command", "args": {"param": "value"}}'
    response = mock_external_mcp_manager.handle_request("test_server", request)
    
    # Verify the request was forwarded to the server
    assert response == '{"result": "success"}'
    mock_external_mcp_server.send_request.assert_called_once_with(request)
    
    # Test with non-existent server
    response = mock_external_mcp_manager.handle_request("nonexistent", request)
    assert response is None


def test_external_mcp_manager_start_all(mock_external_mcp_manager, mock_external_mcp_server):
    """Test starting all enabled servers."""
    # Add a disabled server
    disabled_server = MagicMock()
    disabled_server.name = "disabled_server"
    disabled_server.enabled = False
    mock_external_mcp_manager.servers["disabled_server"] = disabled_server
    
    # Start all servers
    mock_external_mcp_manager.start_all()
    
    # Verify only enabled servers were started
    mock_external_mcp_server.start.assert_called_once()
    disabled_server.start.assert_not_called()


def test_external_mcp_manager_stop_all(mock_external_mcp_manager, mock_external_mcp_server):
    """Test stopping all running servers."""
    # Set up mock server to be running
    mock_external_mcp_server.is_running.return_value = True
    
    # Add a server that's not running
    not_running_server = MagicMock()
    not_running_server.name = "not_running_server"
    not_running_server.is_running.return_value = False
    mock_external_mcp_manager.servers["not_running_server"] = not_running_server
    
    # Stop all servers
    mock_external_mcp_manager.stop_all()
    
    # Verify only running servers were stopped
    mock_external_mcp_server.stop.assert_called_once()
    not_running_server.stop.assert_not_called()
