"""Tests for the Meta MCP Server module."""

import os
import asyncio
import tempfile
import json
from unittest.mock import MagicMock, patch, AsyncMock

import pytest

from hanzo_mcp.meta_mcp import MetaMCPServer
from hanzo_mcp.server import HanzoMCPServer
from hanzo_mcp.tools.mcp_manager import MCPServerManager


class TestMetaMCPServer:
    """Test the MetaMCPServer class."""

    @pytest.fixture
    async def meta_server(self):
        """Create a MetaMCPServer instance for testing."""
        # Mock the HanzoMCPServer class
        with patch("hanzo_mcp.meta_mcp.HanzoMCPServer") as mock_mcp_server_class, \
             patch("hanzo_mcp.meta_mcp.MCPServerManager") as mock_manager_class, \
             patch("hanzo_mcp.meta_mcp.MCPOrchestrator") as mock_orchestrator_class, \
             patch("asyncio.create_task") as mock_create_task:
            
            # Mock server instance
            mock_server = MagicMock()
            mock_mcp_server_class.return_value = mock_server
            
            # Mock orchestrator
            mock_orchestrator = MagicMock()
            mock_server.mcp_orchestrator = mock_orchestrator
            
            # Mock server manager
            mock_manager = MagicMock()
            mock_manager_class.return_value = mock_manager
            
            # Mock create_task to return a completed future
            mock_future = asyncio.Future()
            mock_future.set_result(None)
            mock_create_task.return_value = mock_future
            
            # Create the meta server
            meta_server = MetaMCPServer(
                name="test-meta",
                allowed_paths=["/test/path"],
                auto_start_sub_mcps=False  # Disable auto-start to simplify testing
            )
            
            # Add mocks for easier testing
            meta_server._mock_server = mock_server
            meta_server._mock_manager = mock_manager
            meta_server._mock_orchestrator = mock_orchestrator
            
            yield meta_server
    
    def test_initialization(self, meta_server):
        """Test initializing the MetaMCPServer."""
        # Verify the meta server was created with the correct properties
        assert meta_server.name == "test-meta"
        assert meta_server.allowed_paths == ["/test/path"]
        assert meta_server.auto_start_sub_mcps is False
        
        # Verify the main server was initialized
        assert meta_server.main_server is meta_server._mock_server
        
        # Verify the server manager was initialized
        assert meta_server.server_manager is meta_server._mock_manager
    
    def test_init_main_server(self, meta_server):
        """Test initializing the main MCP server."""
        # The main server should already be initialized in the fixture
        from hanzo_mcp.meta_mcp import HanzoMCPServer
        
        HanzoMCPServer.assert_called_once_with(
            name="test-meta",
            allowed_paths=["/test/path"],
            enable_external_servers=True
        )
    
    def test_apply_sub_mcp_configs(self, meta_server):
        """Test applying sub-MCP configurations."""
        # Set up test configurations
        meta_server.sub_mcps_config = {
            "test-sub-mcp": {
                "command": "echo",
                "args": ["hello", "world"],
                "env": {"TEST": "value"},
                "description": "Test sub-MCP server"
            }
        }
        
        # Mock get_server to return None (server doesn't exist)
        meta_server.server_manager.get_server.return_value = None
        
        # Apply configurations
        meta_server._apply_sub_mcp_configs()
        
        # Verify add_server was called with the correct arguments
        meta_server.server_manager.add_server.assert_called_once_with(
            name="test-sub-mcp",
            command="echo",
            args=["hello", "world"],
            env={"TEST": "value"},
            description="Test sub-MCP server",
            save=True
        )
        
        # Now test updating an existing server
        # Mock get_server to return a server
        mock_server = MagicMock()
        meta_server.server_manager.get_server.return_value = mock_server
        
        # Reset the add_server mock
        meta_server.server_manager.add_server.reset_mock()
        
        # Apply configurations again
        meta_server._apply_sub_mcp_configs()
        
        # Verify add_server was not called
        meta_server.server_manager.add_server.assert_not_called()
        
        # Verify server properties were updated
        assert mock_server.command == "echo"
        assert mock_server.args == ["hello", "world"]
        assert mock_server.env == {"TEST": "value"}
        assert mock_server.description == "Test sub-MCP server"
    
    @pytest.mark.asyncio
    async def test_start_sub_mcps(self, meta_server):
        """Test starting sub-MCP servers."""
        # Set up test servers
        mock_server1 = MagicMock()
        mock_server1.name = "test-server-1"
        mock_server2 = MagicMock()
        mock_server2.name = "test-server-2"
        
        # Mock get_servers to return the test servers
        meta_server.server_manager.get_servers.return_value = {
            "test-server-1": mock_server1,
            "test-server-2": mock_server2
        }
        
        # Mock _is_server_enabled to return True for all servers
        meta_server._is_server_enabled = MagicMock(return_value=True)
        
        # Mock start_server
        meta_server.server_manager.start_server.return_value = {"success": True}
        
        # Start sub-MCP servers
        await meta_server._start_sub_mcps()
        
        # Verify start_server was called for both servers
        assert meta_server.server_manager.start_server.call_count == 2
        meta_server.server_manager.start_server.assert_any_call("test-server-1")
        meta_server.server_manager.start_server.assert_any_call("test-server-2")
    
    def test_is_server_enabled(self, meta_server):
        """Test checking if a server is enabled."""
        # Test server with explicit enabled=true
        mock_server = MagicMock()
        mock_server.name = "test-server-1"
        meta_server.sub_mcps_config = {
            "test-server-1": {
                "enabled": "true"
            }
        }
        
        assert meta_server._is_server_enabled(mock_server) is True
        
        # Test server with explicit enabled=false
        meta_server.sub_mcps_config = {
            "test-server-1": {
                "enabled": "false"
            }
        }
        
        assert meta_server._is_server_enabled(mock_server) is False
        
        # Test server with enabled=auto and auto_enable_env set
        meta_server.sub_mcps_config = {
            "test-server-1": {
                "enabled": "auto",
                "auto_enable_env": "TEST_ENV_VAR"
            }
        }
        
        # Test with environment variable not set
        with patch.dict(os.environ, {}, clear=True):
            assert meta_server._is_server_enabled(mock_server) is False
        
        # Test with environment variable set
        with patch.dict(os.environ, {"TEST_ENV_VAR": "value"}, clear=True):
            assert meta_server._is_server_enabled(mock_server) is True
        
        # Test server with enabled=auto and env value set
        meta_server.sub_mcps_config = {
            "test-server-1": {
                "enabled": "auto"
            }
        }
        mock_server.env = {"API_KEY": "value"}
        
        assert meta_server._is_server_enabled(mock_server) is True
        
        # Test server with enabled=auto and env value not set
        mock_server.env = {"API_KEY": ""}
        
        assert meta_server._is_server_enabled(mock_server) is False
        
        # Test server with no config
        meta_server.sub_mcps_config = {}
        
        assert meta_server._is_server_enabled(mock_server) is False
    
    @pytest.mark.asyncio
    async def test_start(self, meta_server):
        """Test starting the Meta MCP Server."""
        # Mock _start_sub_mcps
        meta_server._start_sub_mcps = AsyncMock()
        
        # Start the server
        await meta_server.start()
        
        # Verify _start_sub_mcps was called
        meta_server._start_sub_mcps.assert_called_once()
    
    def test_run(self, meta_server):
        """Test running the Meta MCP Server."""
        # Mock the main server's run method
        meta_server.main_server.run = MagicMock()
        
        # Run the server
        meta_server.run(transport="stdio", allowed_paths=["/additional/path"])
        
        # Verify additional paths were added
        assert "/additional/path" in meta_server.allowed_paths
        meta_server.main_server.permission_manager.add_allowed_path.assert_called_with("/additional/path")
        meta_server.main_server.document_context.add_allowed_path.assert_called_with("/additional/path")
        
        # Verify the main server's run method was called
        meta_server.main_server.run.assert_called_once_with(
            transport="stdio",
            allowed_paths=meta_server.allowed_paths
        )
    
    def test_cleanup(self, meta_server):
        """Test cleaning up resources."""
        # Run cleanup
        meta_server.cleanup()
        
        # Verify the main server's cleanup method was called
        meta_server.main_server.cleanup.assert_called_once()
        
        # Verify stop_all_servers was called
        meta_server.server_manager.stop_all_servers.assert_called_once()
    
    def test_get_server_status(self, meta_server):
        """Test getting server status."""
        # Mock get_all_server_info
        meta_server.server_manager.get_all_server_info.return_value = {
            "test-server-1": {"name": "test-server-1", "running": True},
            "test-server-2": {"name": "test-server-2", "running": False}
        }
        
        # Get status
        status = meta_server.get_server_status()
        
        # Verify status object has the correct structure
        assert "main_server" in status
        assert status["main_server"]["name"] == "test-meta"
        assert status["main_server"]["allowed_paths"] == ["/test/path"]
        assert status["main_server"]["running"] is True
        
        assert "sub_mcps" in status
        assert "test-server-1" in status["sub_mcps"]
        assert "test-server-2" in status["sub_mcps"]
    
    @pytest.mark.asyncio
    async def test_restart_server(self, meta_server):
        """Test restarting a server."""
        # Mock get_server
        mock_server = MagicMock()
        meta_server.server_manager.get_server.return_value = mock_server
        
        # Mock stop_server and start_server
        meta_server.server_manager.stop_server.return_value = {"success": True}
        meta_server.server_manager.start_server.return_value = {"success": True}
        
        # Test restarting an existing server
        result = await meta_server.restart_server("test-server")
        
        # Verify get_server was called
        meta_server.server_manager.get_server.assert_called_once_with("test-server")
        
        # Verify stop_server and start_server were called
        meta_server.server_manager.stop_server.assert_called_once_with("test-server")
        meta_server.server_manager.start_server.assert_called_once_with("test-server")
        
        # Verify result
        assert result["success"] is True
        
        # Test restarting a non-existent server
        meta_server.server_manager.get_server.return_value = None
        meta_server.server_manager.get_server.reset_mock()
        meta_server.server_manager.stop_server.reset_mock()
        meta_server.server_manager.start_server.reset_mock()
        
        result = await meta_server.restart_server("non-existent-server")
        
        # Verify get_server was called
        meta_server.server_manager.get_server.assert_called_once_with("non-existent-server")
        
        # Verify stop_server and start_server were not called
        meta_server.server_manager.stop_server.assert_not_called()
        meta_server.server_manager.start_server.assert_not_called()
        
        # Verify result
        assert result["success"] is False
        assert "error" in result
    
    def test_get_available_tools(self, meta_server):
        """Test getting available tools."""
        # Mock get_available_tools
        meta_server.orchestrator.get_available_tools.return_value = {
            "test-server-1.tool1": {"name": "tool1", "server": "test-server-1"},
            "test-server-2.tool2": {"name": "tool2", "server": "test-server-2"}
        }
        
        # Get available tools
        tools = meta_server.get_available_tools()
        
        # Verify get_available_tools was called
        meta_server.orchestrator.get_available_tools.assert_called_once()
        
        # Verify tools were returned
        assert "test-server-1.tool1" in tools
        assert "test-server-2.tool2" in tools


class TestMain:
    """Test the main function."""
    
    def test_main_with_args(self):
        """Test main with command line arguments."""
        with patch("argparse.ArgumentParser.parse_args") as mock_parse_args, \
             patch("hanzo_mcp.meta_mcp.MetaMCPServer") as mock_meta_server_class, \
             patch("signal.signal") as mock_signal, \
             patch("os.path.exists") as mock_exists:
            
            # Mock args
            mock_args = MagicMock()
            mock_args.name = "test-meta"
            mock_args.transport = "stdio"
            mock_args.allowed_paths = ["/test/path"]
            mock_args.config = None
            mock_args.disable_proxy_tools = False
            mock_args.disable_auto_start = False
            mock_parse_args.return_value = mock_args
            
            # Mock meta server
            mock_meta_server = MagicMock()
            mock_meta_server_class.return_value = mock_meta_server
            
            # Run main
            from hanzo_mcp.meta_mcp import main
            main()
            
            # Verify MetaMCPServer was created with the correct arguments
            mock_meta_server_class.assert_called_once_with(
                name="test-meta",
                allowed_paths=["/test/path"],
                mcp_config={},
                sub_mcps_config={},
                enable_proxy_tools=True,
                auto_start_sub_mcps=True
            )
            
            # Verify run was called
            mock_meta_server.run.assert_called_once_with(
                transport="stdio",
                allowed_paths=["/test/path"]
            )
            
            # Verify signal handlers were registered
            assert mock_signal.call_count == 2
    
    def test_main_with_config(self):
        """Test main with a configuration file."""
        with patch("argparse.ArgumentParser.parse_args") as mock_parse_args, \
             patch("hanzo_mcp.meta_mcp.MetaMCPServer") as mock_meta_server_class, \
             patch("signal.signal") as mock_signal, \
             patch("os.path.exists") as mock_exists, \
             patch("builtins.open", new_callable=MagicMock) as mock_open:
            
            # Mock args
            mock_args = MagicMock()
            mock_args.name = "test-meta"
            mock_args.transport = "stdio"
            mock_args.allowed_paths = ["/test/path"]
            mock_args.config = "/test/config.json"
            mock_args.disable_proxy_tools = False
            mock_args.disable_auto_start = False
            mock_parse_args.return_value = mock_args
            
            # Mock exists
            mock_exists.return_value = True
            
            # Mock open to return a file-like object
            mock_file = MagicMock()
            mock_open.return_value.__enter__.return_value = mock_file
            
            # Mock json.load
            test_config = {
                "mcp": {"name": "config-meta"},
                "sub_mcps": {
                    "test-server-1": {
                        "command": "echo",
                        "args": ["hello"]
                    }
                }
            }
            
            with patch("json.load") as mock_json_load:
                mock_json_load.return_value = test_config
                
                # Mock meta server
                mock_meta_server = MagicMock()
                mock_meta_server_class.return_value = mock_meta_server
                
                # Run main
                from hanzo_mcp.meta_mcp import main
                main()
                
                # Verify MetaMCPServer was created with the correct arguments
                mock_meta_server_class.assert_called_once_with(
                    name="test-meta",
                    allowed_paths=["/test/path"],
                    mcp_config={"name": "config-meta"},
                    sub_mcps_config={
                        "test-server-1": {
                            "command": "echo",
                            "args": ["hello"]
                        }
                    },
                    enable_proxy_tools=True,
                    auto_start_sub_mcps=True
                )
