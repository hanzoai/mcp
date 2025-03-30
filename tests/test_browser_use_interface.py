"""Tests for BrowserUseInterface.

This module contains tests for the BrowserUseInterface class for browser automation.
"""

import json
from unittest.mock import patch, MagicMock, AsyncMock

import pytest

from hanzo_mcp.tools.browser_use import BrowserUseInterface
from hanzo_mcp.tools.mcp_manager import MCPServer, MCPServerManager


@pytest.fixture
def mock_browser_use_server():
    """Create a mock browser-use server for testing."""
    server = MagicMock(spec=MCPServer)
    server.name = "browser-use"
    server.command = "uvx"
    server.args = ["mcp-server-browser-use"]
    server.enabled = True
    server.description = "Automates browser interactions"
    server.process = MagicMock()
    server.running = True
    server.tools = {
        "navigate_to": {"name": "navigate_to", "params": {"url": "string"}},
        "screenshot": {"name": "screenshot", "params": {}},
        "get_page_content": {"name": "get_page_content", "params": {}},
        "click_element": {"name": "click_element", "params": {"selector": "string"}},
        "fill_form": {"name": "fill_form", "params": {"selector": "string", "value": "string"}}
    }
    return server


@pytest.fixture
def mock_browser_use_manager(mock_browser_use_server):
    """Create a mock MCPServerManager for testing the browser-use interface."""
    manager = MagicMock(spec=MCPServerManager)
    manager.servers = {"browser-use": mock_browser_use_server}
    manager.get_server.return_value = mock_browser_use_server
    manager.is_server_running.return_value = True
    async_start_mock = AsyncMock(return_value={"success": True, "message": "Started server"})
    manager.start_server = async_start_mock
    async_stop_mock = AsyncMock(return_value={"success": True, "message": "Stopped server"})
    manager.stop_server = async_stop_mock
    return manager


@pytest.fixture
def browser_use_interface(mock_browser_use_manager):
    """Create a BrowserUseInterface with a mock manager for testing."""
    return BrowserUseInterface(manager=mock_browser_use_manager)


def test_browser_use_interface_init():
    """Test initialization of BrowserUseInterface."""
    # Test with provided manager
    manager = MagicMock(spec=MCPServerManager)
    interface = BrowserUseInterface(manager=manager)
    assert interface.manager is manager
    assert interface._server_name == "browser-use"
    
    # Test with auto-created manager
    with patch("hanzo_mcp.tools.browser_use.MCPServerManager") as mock_manager_class:
        mock_manager = MagicMock(spec=MCPServerManager)
        mock_manager_class.return_value = mock_manager
        
        interface = BrowserUseInterface()
        assert interface.manager is mock_manager
        assert interface._server_name == "browser-use"


def test_browser_use_interface_is_available(browser_use_interface, mock_browser_use_manager):
    """Test checking if the browser-use server is available."""
    # Test when server is available
    assert browser_use_interface.is_available() is True
    
    # Test when server is not available
    mock_browser_use_manager.servers = {}
    assert browser_use_interface.is_available() is False


def test_browser_use_interface_is_running(browser_use_interface, mock_browser_use_manager):
    """Test checking if the browser-use server is running."""
    # Test when server is running
    mock_browser_use_manager.is_server_running.return_value = True
    assert browser_use_interface.is_running() is True
    mock_browser_use_manager.is_server_running.assert_called_once_with("browser-use")
    
    # Test when server is not running
    mock_browser_use_manager.is_server_running.reset_mock()
    mock_browser_use_manager.is_server_running.return_value = False
    assert browser_use_interface.is_running() is False
    mock_browser_use_manager.is_server_running.assert_called_once_with("browser-use")


@pytest.mark.asyncio
async def test_browser_use_interface_ensure_running(browser_use_interface, mock_browser_use_manager):
    """Test ensuring that the browser-use server is running."""
    # Test when server is not available
    mock_browser_use_manager.servers = {}
    result = await browser_use_interface.ensure_running()
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_browser_use_manager.servers = {"browser-use": mock_browser_use_manager.get_server.return_value}
    
    # Test when server is already running
    mock_browser_use_manager.is_server_running.return_value = True
    result = await browser_use_interface.ensure_running()
    assert result["success"] is True
    assert "already running" in result["message"]
    mock_browser_use_manager.start_server.assert_not_called()
    
    # Test when server is not running and needs to be started
    mock_browser_use_manager.is_server_running.return_value = False
    mock_browser_use_manager.start_server.reset_mock()
    result = await browser_use_interface.ensure_running()
    assert result["success"] is True
    assert result == {"success": True, "message": "Started server"}
    mock_browser_use_manager.start_server.assert_called_once_with("browser-use")


@pytest.mark.asyncio
async def test_browser_use_interface_stop(browser_use_interface, mock_browser_use_manager):
    """Test stopping the browser-use server."""
    # Test when server is not available
    mock_browser_use_manager.servers = {}
    result = await browser_use_interface.stop()
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_browser_use_manager.servers = {"browser-use": mock_browser_use_manager.get_server.return_value}
    
    # Test when server is not running
    mock_browser_use_manager.is_server_running.return_value = False
    result = await browser_use_interface.stop()
    assert result["success"] is True
    assert "not running" in result["message"]
    mock_browser_use_manager.stop_server.assert_not_called()
    
    # Test when server is running and needs to be stopped
    mock_browser_use_manager.is_server_running.return_value = True
    mock_browser_use_manager.stop_server.reset_mock()
    result = await browser_use_interface.stop()
    assert result["success"] is True
    assert result == {"success": True, "message": "Stopped server"}
    mock_browser_use_manager.stop_server.assert_called_once_with("browser-use")


@pytest.mark.asyncio
async def test_browser_use_interface_restart(browser_use_interface, mock_browser_use_manager):
    """Test restarting the browser-use server."""
    # Test when server is not available
    mock_browser_use_manager.servers = {}
    result = await browser_use_interface.restart()
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_browser_use_manager.servers = {"browser-use": mock_browser_use_manager.get_server.return_value}
    
    # Test successful restart when server was running
    mock_browser_use_manager.is_server_running.return_value = True
    mock_browser_use_manager.stop_server.reset_mock()
    mock_browser_use_manager.start_server.reset_mock()
    result = await browser_use_interface.restart()
    assert result["success"] is True
    assert result == {"success": True, "message": "Started server"}
    mock_browser_use_manager.stop_server.assert_called_once_with("browser-use")
    mock_browser_use_manager.start_server.assert_called_once_with("browser-use")
    
    # Test successful restart when server was not running
    mock_browser_use_manager.is_server_running.return_value = False
    mock_browser_use_manager.stop_server.reset_mock()
    mock_browser_use_manager.start_server.reset_mock()
    result = await browser_use_interface.restart()
    assert result["success"] is True
    assert result == {"success": True, "message": "Started server"}
    mock_browser_use_manager.stop_server.assert_not_called()
    mock_browser_use_manager.start_server.assert_called_once_with("browser-use")


@pytest.mark.asyncio
async def test_browser_use_interface_get_available_tools(browser_use_interface, mock_browser_use_manager, mock_browser_use_server):
    """Test getting available tools from the browser-use server."""
    # Test when server is not available
    mock_browser_use_manager.servers = {}
    tools = await browser_use_interface.get_available_tools()
    assert tools == []
    
    # Reset for next test
    mock_browser_use_manager.servers = {"browser-use": mock_browser_use_server}
    
    # Test when server is not running
    mock_browser_use_manager.is_server_running.return_value = False
    tools = await browser_use_interface.get_available_tools()
    assert tools == []
    
    # Test when server is running with tools
    mock_browser_use_manager.is_server_running.return_value = True
    tools = await browser_use_interface.get_available_tools()
    assert len(tools) == 5
    assert tools[0]["name"] in mock_browser_use_server.tools
    assert "definition" in tools[0]
    
    # Test when server is running but get_server returns None
    mock_browser_use_manager.get_server.return_value = None
    tools = await browser_use_interface.get_available_tools()
    assert tools == []


@pytest.mark.asyncio
async def test_browser_use_interface_execute_tool(browser_use_interface, mock_browser_use_manager, mock_browser_use_server):
    """Test executing a tool on the browser-use server."""
    # Set up mock server process
    mock_browser_use_server.process.stdin.write.return_value = None
    mock_browser_use_server.process.stdout.readline.return_value = '{"success": true, "result": "tool executed"}'
    
    # Test when server is not available
    mock_browser_use_manager.servers = {}
    result = await browser_use_interface.execute_tool("navigate_to", {"url": "https://example.com"})
    assert result["success"] is False
    assert "not available" in result["error"]
    
    # Reset for next test
    mock_browser_use_manager.servers = {"browser-use": mock_browser_use_server}
    
    # Test when server is not running and needs to be started
    mock_browser_use_manager.is_server_running.return_value = False
    mock_browser_use_manager.start_server.reset_mock()
    result = await browser_use_interface.execute_tool("navigate_to", {"url": "https://example.com"})
    assert result["success"] is True
    assert result["result"] == "tool executed"
    mock_browser_use_manager.start_server.assert_called_once_with("browser-use")
    
    # Test when server is running but tool is not found
    mock_browser_use_manager.is_server_running.return_value = True
    mock_browser_use_server.tools = {}
    result = await browser_use_interface.execute_tool("nonexistent_tool", {})
    assert result["success"] is False
    assert "not found" in result["error"]
    
    # Reset tools for next test
    mock_browser_use_server.tools = {
        "navigate_to": {"name": "navigate_to", "params": {"url": "string"}},
        "screenshot": {"name": "screenshot", "params": {}}
    }
    
    # Test successful tool execution
    mock_browser_use_server.process.stdin.write.reset_mock()
    mock_browser_use_server.process.stdin.flush.reset_mock()
    result = await browser_use_interface.execute_tool("navigate_to", {"url": "https://example.com"})
    assert result["success"] is True
    assert result["result"] == "tool executed"
    mock_browser_use_server.process.stdin.write.assert_called_once_with('{"tool": "navigate_to", "params": {"url": "https://example.com"}}\n')
    mock_browser_use_server.process.stdin.flush.assert_called_once()
    
    # Test handling of invalid JSON response
    mock_browser_use_server.process.stdout.readline.return_value = 'invalid json'
    result = await browser_use_interface.execute_tool("navigate_to", {"url": "https://example.com"})
    assert result["success"] is False
    assert "Invalid response" in result["error"]
    
    # Test handling of exception during execution
    mock_browser_use_server.process.stdin.write.side_effect = Exception("Test exception")
    result = await browser_use_interface.execute_tool("navigate_to", {"url": "https://example.com"})
    assert result["success"] is False
    assert "Error executing tool" in result["error"]


@pytest.mark.asyncio
async def test_helper_functions(browser_use_interface):
    """Test the helper functions that use the BrowserUseInterface."""
    # Patch the global browser_use instance
    with patch("hanzo_mcp.tools.browser_use.browser_use", browser_use_interface):
        # Test get_browser_capabilities
        from hanzo_mcp.tools.browser_use import get_browser_capabilities
        browser_use_interface.is_available = MagicMock(return_value=True)
        browser_use_interface.is_running = MagicMock(return_value=True)
        browser_use_interface.ensure_running = AsyncMock()  # Use AsyncMock for async methods
        browser_use_interface.get_available_tools = AsyncMock(return_value=[
            {"name": "navigate_to", "definition": {}},
            {"name": "screenshot", "definition": {}}
        ])
        
        result = await get_browser_capabilities()
        assert result["available"] is True
        assert len(result["tools"]) == 2
        assert result["running"] is True
        browser_use_interface.ensure_running.assert_called_once()
        browser_use_interface.get_available_tools.assert_called_once()
        
        # Test when browser use is not available
        browser_use_interface.is_available.return_value = False
        result = await get_browser_capabilities()
        assert result["available"] is False
        assert "message" in result
        
        # Test navigate_to
        from hanzo_mcp.tools.browser_use import navigate_to
        browser_use_interface.execute_tool = AsyncMock(return_value={"success": True, "result": "navigated"})
        
        result = await navigate_to("https://example.com")
        assert result["success"] is True
        browser_use_interface.execute_tool.assert_called_once_with(
            tool_name="navigate_to",
            params={"url": "https://example.com"}
        )
        
        # Test take_screenshot
        from hanzo_mcp.tools.browser_use import take_screenshot
        browser_use_interface.execute_tool.reset_mock()
        browser_use_interface.execute_tool.return_value = {"success": True, "path": "/path/to/screenshot.png"}
        
        result = await take_screenshot()
        assert result["success"] is True
        browser_use_interface.execute_tool.assert_called_once_with(
            tool_name="screenshot",
            params={}
        )
        
        # Test get_page_content
        from hanzo_mcp.tools.browser_use import get_page_content
        browser_use_interface.execute_tool.reset_mock()
        browser_use_interface.execute_tool.return_value = {"success": True, "content": "<html>...</html>"}
        
        result = await get_page_content()
        assert result["success"] is True
        browser_use_interface.execute_tool.assert_called_once_with(
            tool_name="get_page_content",
            params={}
        )
        
        # Test click_element
        from hanzo_mcp.tools.browser_use import click_element
        browser_use_interface.execute_tool.reset_mock()
        browser_use_interface.execute_tool.return_value = {"success": True, "result": "clicked"}
        
        result = await click_element("#button")
        assert result["success"] is True
        browser_use_interface.execute_tool.assert_called_once_with(
            tool_name="click_element",
            params={"selector": "#button"}
        )
        
        # Test fill_form
        from hanzo_mcp.tools.browser_use import fill_form
        browser_use_interface.execute_tool.reset_mock()
        browser_use_interface.execute_tool.return_value = {"success": True, "result": "filled"}
        
        result = await fill_form("#input", "test value")
        assert result["success"] is True
        browser_use_interface.execute_tool.assert_called_once_with(
            tool_name="fill_form",
            params={"selector": "#input", "value": "test value"}
        )
