"""Tests for ComputerUseInterface.

This module contains tests for the ComputerUseInterface class.
"""

import json
from unittest.mock import patch, MagicMock, ANY, AsyncMock

import pytest

from hanzo_mcp.tools.computer_use import ComputerUseInterface
from hanzo_mcp.tools.mcp_manager import MCPServer, MCPServerManager


@pytest.fixture
def mock_computer_use_server():
    """Create a mock computer-use server for testing."""
    server = MagicMock(spec=MCPServer)
    server.name = "computer-use"
    server.command = "uvx"
    server.args = ["mcp-server-computer-use"]
    server.enabled = True
    server.description = "Provides full computer access"
    server.process = MagicMock()
    server.running = True
    server.tools = {
        "open_application": {"name": "open_application", "params": {"name": "string"}},
        "screenshot": {"name": "screenshot", "params": {}},
        "file_explorer": {"name": "file_explorer", "params": {"path": "string"}},
        "clipboard_get": {"name": "clipboard_get", "params": {}},
        "clipboard_set": {"name": "clipboard_set", "params": {"text": "string"}}
    }
    return server


@pytest.fixture
def mock_computer_use_manager(mock_computer_use_server):
    """Create a mock MCPServerManager for testing the computer-use interface."""
    manager = MagicMock(spec=MCPServerManager)
    manager.servers = {"computer-use": mock_computer_use_server}
    manager.get_server.return_value = mock_computer_use_server
    manager.is_server_running.return_value = True
    manager.start_server.return_value = {"success": True, "message": "Started server"}
    manager.stop_server.return_value = {"success": True, "message": "Stopped server"}
    return manager


@pytest.fixture
def computer_use_interface(mock_computer_use_manager):
    """Create a ComputerUseInterface with a mock manager for testing."""
    return ComputerUseInterface(manager=mock_computer_use_manager)


def test_computer_use_interface_init():
    """Test initialization of ComputerUseInterface."""
    # Test with provided manager
    manager = MagicMock(spec=MCPServerManager)
    interface = ComputerUseInterface(manager=manager)
    assert interface.manager is manager
    assert interface._server_name == "computer-use"
    
    # Test with auto-created manager
    with patch("hanzo_mcp.tools.computer_use.MCPServerManager") as mock_manager_class:
        mock_manager = MagicMock(spec=MCPServerManager)
        mock_manager_class.return_value = mock_manager
        
        interface = ComputerUseInterface()
        assert interface.manager is mock_manager
        assert interface._server_name == "computer-use"


def test_computer_use_interface_is_available(computer_use_interface, mock_computer_use_manager):
    """Test checking if the computer-use server is available."""
    # Test when server is available
    assert computer_use_interface.is_available() is True
    
    # Test when server is not available
    mock_computer_use_manager.servers = {}
    assert computer_use_interface.is_available() is False


def test_computer_use_interface_is_running(computer_use_interface, mock_computer_use_manager):
    """Test checking if the computer-use server is running."""
    # Test when server is running
    mock_computer_use_manager.is_server_running.return_value = True
    assert computer_use_interface.is_running() is True
    mock_computer_use_manager.is_server_running.assert_called_once_with("computer-use")
    
    # Test when server is not running
    mock_computer_use_manager.is_server_running.reset_mock()
    mock_computer_use_manager.is_server_running.return_value = False
    assert computer_use_interface.is_running() is False
    mock_computer_use_manager.is_server_running.assert_called_once_with("computer-use")


@pytest.mark.asyncio
async def test_computer_use_interface_ensure_running(computer_use_interface, mock_computer_use_manager):
    """Test ensuring that the computer-use server is running."""
    # Test when server is not available
    mock_computer_use_manager.servers = {}
    result = await computer_use_interface.ensure_running()
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_computer_use_manager.servers = {"computer-use": mock_computer_use_manager.get_server.return_value}
    
    # Test when server is already running
    mock_computer_use_manager.is_server_running.return_value = True
    result = await computer_use_interface.ensure_running()
    assert result["success"] is True
    assert "already running" in result["message"]
    mock_computer_use_manager.start_server.assert_not_called()
    
    # Test when server is not running and needs to be started
    mock_computer_use_manager.is_server_running.return_value = False
    mock_computer_use_manager.start_server.reset_mock()
    result = await computer_use_interface.ensure_running()
    assert result["success"] is True
    assert result == {"success": True, "message": "Started server"}
    mock_computer_use_manager.start_server.assert_called_once_with("computer-use")


@pytest.mark.asyncio
async def test_computer_use_interface_stop(computer_use_interface, mock_computer_use_manager):
    """Test stopping the computer-use server."""
    # Test when server is not available
    mock_computer_use_manager.servers = {}
    result = await computer_use_interface.stop()
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_computer_use_manager.servers = {"computer-use": mock_computer_use_manager.get_server.return_value}
    
    # Test when server is not running
    mock_computer_use_manager.is_server_running.return_value = False
    result = await computer_use_interface.stop()
    assert result["success"] is True
    assert "not running" in result["message"]
    mock_computer_use_manager.stop_server.assert_not_called()
    
    # Test when server is running and needs to be stopped
    mock_computer_use_manager.is_server_running.return_value = True
    mock_computer_use_manager.stop_server.reset_mock()
    result = await computer_use_interface.stop()
    assert result["success"] is True
    assert result == {"success": True, "message": "Stopped server"}
    mock_computer_use_manager.stop_server.assert_called_once_with("computer-use")


@pytest.mark.asyncio
async def test_computer_use_interface_restart(computer_use_interface, mock_computer_use_manager):
    """Test restarting the computer-use server."""
    # Test when server is not available
    mock_computer_use_manager.servers = {}
    result = await computer_use_interface.restart()
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_computer_use_manager.servers = {"computer-use": mock_computer_use_manager.get_server.return_value}
    
    # Test successful restart when server was running
    mock_computer_use_manager.is_server_running.return_value = True
    mock_computer_use_manager.stop_server.reset_mock()
    mock_computer_use_manager.start_server.reset_mock()
    result = await computer_use_interface.restart()
    assert result["success"] is True
    assert result == {"success": True, "message": "Started server"}
    mock_computer_use_manager.stop_server.assert_called_once_with("computer-use")
    mock_computer_use_manager.start_server.assert_called_once_with("computer-use")
    
    # Test successful restart when server was not running
    mock_computer_use_manager.is_server_running.return_value = False
    mock_computer_use_manager.stop_server.reset_mock()
    mock_computer_use_manager.start_server.reset_mock()
    result = await computer_use_interface.restart()
    assert result["success"] is True
    assert result == {"success": True, "message": "Started server"}
    mock_computer_use_manager.stop_server.assert_not_called()
    mock_computer_use_manager.start_server.assert_called_once_with("computer-use")


@pytest.mark.asyncio
async def test_computer_use_interface_get_available_tools(computer_use_interface, mock_computer_use_manager, mock_computer_use_server):
    """Test getting available tools from the computer-use server."""
    # Test when server is not available
    mock_computer_use_manager.servers = {}
    tools = await computer_use_interface.get_available_tools()
    assert tools == []
    
    # Reset for next test
    mock_computer_use_manager.servers = {"computer-use": mock_computer_use_server}
    
    # Test when server is not running
    mock_computer_use_manager.is_server_running.return_value = False
    tools = await computer_use_interface.get_available_tools()
    assert tools == []
    
    # Test when server is running with tools
    mock_computer_use_manager.is_server_running.return_value = True
    tools = await computer_use_interface.get_available_tools()
    assert len(tools) == 5
    assert tools[0]["name"] == "open_application"
    assert "definition" in tools[0]
    
    # Test when server is running but get_server returns None
    mock_computer_use_manager.get_server.return_value = None
    tools = await computer_use_interface.get_available_tools()
    assert tools == []


@pytest.mark.asyncio
async def test_computer_use_interface_execute_tool(computer_use_interface, mock_computer_use_manager, mock_computer_use_server):
    """Test executing a tool on the computer-use server."""
    # Set up mock server process
    mock_computer_use_server.process.stdin.write.return_value = None
    mock_computer_use_server.process.stdout.readline.return_value = '{"success": true, "result": "tool executed"}'
    
    # Test when server is not available
    mock_computer_use_manager.servers = {}
    result = await computer_use_interface.execute_tool("open_application", {"name": "firefox"})
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_computer_use_manager.servers = {"computer-use": mock_computer_use_server}
    
    # Test when server is not running and needs to be started
    mock_computer_use_manager.is_server_running.return_value = False
    mock_computer_use_manager.start_server.reset_mock()
    result = await computer_use_interface.execute_tool("open_application", {"name": "firefox"})
    assert result["success"] is True
    assert result["result"] == "tool executed"
    mock_computer_use_manager.start_server.assert_called_once_with("computer-use")
    
    # Test when server is running but tool is not found
    mock_computer_use_manager.is_server_running.return_value = True
    mock_computer_use_server.tools = {}
    result = await computer_use_interface.execute_tool("nonexistent_tool", {})
    assert result["success"] is False
    assert "not found" in result["error"]
    
    # Reset tools for next test
    mock_computer_use_server.tools = {
        "open_application": {"name": "open_application", "params": {"name": "string"}},
        "screenshot": {"name": "screenshot", "params": {}}
    }
    
    # Test successful tool execution
    mock_computer_use_server.process.stdin.write.reset_mock()
    mock_computer_use_server.process.stdin.flush.reset_mock()
    result = await computer_use_interface.execute_tool("open_application", {"name": "firefox"})
    assert result["success"] is True
    assert result["result"] == "tool executed"
    mock_computer_use_server.process.stdin.write.assert_called_once_with('{"tool": "open_application", "params": {"name": "firefox"}}\n')
    mock_computer_use_server.process.stdin.flush.assert_called_once()
    
    # Test handling of invalid JSON response
    mock_computer_use_server.process.stdout.readline.return_value = 'invalid json'
    result = await computer_use_interface.execute_tool("open_application", {"name": "firefox"})
    assert result["success"] is False
    assert "Invalid response" in result["error"]
    
    # Test handling of exception during execution
    mock_computer_use_server.process.stdin.write.side_effect = Exception("Test exception")
    result = await computer_use_interface.execute_tool("open_application", {"name": "firefox"})
    assert result["success"] is False
    assert "Error executing tool" in result["error"]


@pytest.mark.asyncio
async def test_helper_functions(computer_use_interface):
    """Test the helper functions that use the ComputerUseInterface."""
    # Patch the global computer_use instance
    with patch("hanzo_mcp.tools.computer_use.computer_use", computer_use_interface):
        # Test get_computer_capabilities
        from hanzo_mcp.tools.computer_use import get_computer_capabilities
        computer_use_interface.is_available = MagicMock(return_value=True)
        computer_use_interface.is_running = MagicMock(return_value=True)
        computer_use_interface.ensure_running = AsyncMock()  # Use AsyncMock for async methods
        computer_use_interface.get_available_tools = AsyncMock(return_value=[
            {"name": "tool1", "definition": {}},
            {"name": "tool2", "definition": {}}
        ])
        
        result = await get_computer_capabilities()
        assert result["available"] is True
        assert len(result["tools"]) == 2
        assert result["running"] is True
        computer_use_interface.ensure_running.assert_called_once()
        computer_use_interface.get_available_tools.assert_called_once()
        
        # Test when computer use is not available
        computer_use_interface.is_available.return_value = False
        result = await get_computer_capabilities()
        assert result["available"] is False
        assert "message" in result
        
        # Test open_application
        from hanzo_mcp.tools.computer_use import open_application
        computer_use_interface.execute_tool = AsyncMock(return_value={"success": True, "result": "opened"})
        
        result = await open_application("firefox")
        assert result["success"] is True
        computer_use_interface.execute_tool.assert_called_once_with(
            tool_name="open_application",
            params={"name": "firefox"}
        )
        
        # Test take_screenshot
        from hanzo_mcp.tools.computer_use import take_screenshot
        computer_use_interface.execute_tool.reset_mock()
        computer_use_interface.execute_tool.return_value = {"success": True, "path": "/path/to/screenshot.png"}
        
        result = await take_screenshot()
        assert result["success"] is True
        computer_use_interface.execute_tool.assert_called_once_with(
            tool_name="screenshot",
            params={}
        )
        
        # Test file_explorer
        from hanzo_mcp.tools.computer_use import file_explorer
        computer_use_interface.execute_tool.reset_mock()
        computer_use_interface.execute_tool.return_value = {"success": True, "result": "opened"}
        
        result = await file_explorer("/path/to/explore")
        assert result["success"] is True
        computer_use_interface.execute_tool.assert_called_once_with(
            tool_name="file_explorer",
            params={"path": "/path/to/explore"}
        )
        
        # Test clipboard_get
        from hanzo_mcp.tools.computer_use import clipboard_get
        computer_use_interface.execute_tool.reset_mock()
        computer_use_interface.execute_tool.return_value = {"success": True, "text": "clipboard content"}
        
        result = await clipboard_get()
        assert result["success"] is True
        computer_use_interface.execute_tool.assert_called_once_with(
            tool_name="clipboard_get",
            params={}
        )
        
        # Test clipboard_set
        from hanzo_mcp.tools.computer_use import clipboard_set
        computer_use_interface.execute_tool.reset_mock()
        computer_use_interface.execute_tool.return_value = {"success": True, "result": "set"}
        
        result = await clipboard_set("new content")
        assert result["success"] is True
        computer_use_interface.execute_tool.assert_called_once_with(
            tool_name="clipboard_set",
            params={"text": "new content"}
        )
