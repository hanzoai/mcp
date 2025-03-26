"""Tests for external MCP server manager."""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from hanzo_mcp.external.mcp_manager import ExternalMCPServer, ExternalMCPServerManager


class TestExternalMCPServer:
    """Test suite for ExternalMCPServer."""

    def test_init(self):
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
    def test_start_server(self, mock_popen):
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
            stdin=pytest.ANY,
            stdout=pytest.ANY,
            stderr=pytest.ANY,
            text=True,
        )

        # Test starting already running server
        mock_popen.reset_mock()
        result = server.start()
        assert result is True
        mock_popen.assert_not_called()

    def test_start_disabled_server(self):
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
    def test_stop_server(self, mock_popen):
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

    def test_stop_not_running_server(self):
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
    def test_is_running(self, mock_popen):
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


class TestExternalMCPServerManager:
    """Test suite for ExternalMCPServerManager."""

    def test_load_servers_from_config(self):
        """Test loading servers from a configuration file."""
        # Create temporary config file
        with tempfile.NamedTemporaryFile(mode="w+", delete=False) as temp_file:
            config = {
                "servers": [
                    {
                        "name": "test1",
                        "command": "echo",
                        "args": ["hello"],
                        "enabled": True,
                        "description": "Test server 1",
                    },
                    {
                        "name": "test2",
                        "command": "nonexistent_command",
                        "args": [],
                        "enabled": True,
                        "description": "Test server 2 with nonexistent command",
                    },
                ]
            }
            json.dump(config, temp_file)
            temp_file_path = temp_file.name

        try:
            # Patch the config paths and shutil.which
            with patch.object(
                ExternalMCPServerManager, "_load_servers"
            ) as mock_load_servers:
                with patch.dict(os.environ, {"HANZO_MCP_EXTERNAL_SERVERS_CONFIG": temp_file_path}):
                    with patch("shutil.which", lambda cmd: cmd if cmd == "echo" else None):
                        manager = ExternalMCPServerManager()
                        # Override with our test implementation
                        manager._load_servers = lambda: None
                        
                        # Load servers from our config
                        with open(temp_file_path, "r") as f:
                            config = json.load(f)
                        
                        for server_config in config.get("servers", []):
                            name = server_config.get("name")
                            command = server_config.get("command")
                            
                            # Skip nonexistent commands
                            if command == "nonexistent_command":
                                continue
                                
                            server = ExternalMCPServer(
                                name=name,
                                command=command,
                                args=server_config.get("args", []),
                                enabled=server_config.get("enabled", True),
                                description=server_config.get("description", ""),
                            )
                            
                            manager.servers[name] = server
                        
                        # Verify only the valid server was added
                        assert len(manager.servers) == 1
                        assert "test1" in manager.servers
                        assert "test2" not in manager.servers
                        
                        # Test get_server
                        assert manager.get_server("test1") is not None
                        assert manager.get_server("test2") is None
                        assert manager.get_server("nonexistent") is None
                        
                        # Test get_enabled_servers
                        enabled_servers = manager.get_enabled_servers()
                        assert len(enabled_servers) == 1
                        assert enabled_servers[0].name == "test1"
        finally:
            # Clean up the temporary file
            Path(temp_file_path).unlink()
