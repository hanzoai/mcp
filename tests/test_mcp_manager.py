"""Tests for the MCP Manager module."""

import os
import json
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from hanzo_mcp.tools.mcp_manager import MCPServerManager, MCPServer


class TestMCPServerManager:
    """Test the MCPServerManager class."""

    @pytest.fixture
    def manager(self):
        """Create an MCPServerManager instance for testing."""
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = os.path.join(temp_dir, "mcp_servers.json")
            
            # Create a manager with a test config path
            manager = MCPServerManager()
            manager.config_path = config_path
            
            # Return the manager
            yield manager
    
    def test_initialization(self, manager):
        """Test initializing the manager."""
        # Initially, there should be no servers
        assert not manager.servers
        
        # Save the default config
        manager.save_config()
        
        # Make sure the config file was created
        assert os.path.exists(manager.config_path)
    
    def test_add_server(self, manager):
        """Test adding a server."""
        # Add a server
        result = manager.add_server(
            name="test-server",
            command="echo",
            args=["hello", "world"],
            env={"TEST": "value"},
            description="Test server",
            save=True
        )
        
        # Verify the result
        assert result
        
        # Verify the server was added
        assert "test-server" in manager.servers
        assert manager.servers["test-server"].name == "test-server"
        assert manager.servers["test-server"].command == "echo"
        assert manager.servers["test-server"].args == ["hello", "world"]
        assert manager.servers["test-server"].env == {"TEST": "value"}
        assert manager.servers["test-server"].description == "Test server"
        
        # Verify the config was saved and has the test server
        assert os.path.exists(manager.config_path)
        
        # Get the server info directly
        server_info = manager.get_server_info("test-server")
        assert server_info["name"] == "test-server"
        assert server_info["command"] == "echo"
    
    def test_get_server_info(self, manager):
        """Test getting server info."""
        # Add a server
        manager.add_server(
            name="test-server",
            command="echo",
            args=["hello"],
            description="Test server"
        )
        
        # Get server info
        info = manager.get_server_info("test-server")
        
        # Verify the info
        assert info["name"] == "test-server"
        assert info["command"] == "echo"
        assert info["args"] == ["hello"]
        assert info["description"] == "Test server"
        assert not info["running"]
    
    def test_remove_server(self, manager):
        """Test removing a server."""
        # Add a server
        manager.add_server(
            name="test-server",
            command="echo",
            args=["hello"],
            save=False
        )
        
        # Verify the server was added
        assert "test-server" in manager.servers
        
        # Remove the server
        result = manager.remove_server("test-server", save=True)
        
        # Verify the result
        assert result
        
        # Verify the server was removed
        assert "test-server" not in manager.servers
    
    def test_start_stop_server(self, manager):
        """Test starting and stopping a server."""
        # Mock the subprocess.Popen method
        with patch("subprocess.Popen") as mock_popen:
            # Configure the mock
            mock_process = MagicMock()
            mock_process.pid = 12345
            mock_popen.return_value = mock_process
            
            # Add a server
            manager.add_server(
                name="test-server",
                command="echo",
                args=["hello"],
                save=False
            )
            
            # Start the server
            result = manager.start_server("test-server")
            
            # Verify the result
            assert result["success"]
            assert result["pid"] == 12345
            
            # Verify the server state
            assert manager.servers["test-server"].running
            assert manager.servers["test-server"].pid == 12345
            
            # Stop the server
            with patch("os.kill") as mock_kill:
                result = manager.stop_server("test-server")
                
                # Verify the result
                assert result["success"]
                
                # Verify the server state
                assert not manager.servers["test-server"].running
                assert manager.servers["test-server"].pid is None
