"""Integration tests for browser use functionality.

This module contains integration tests for the browser-use server,
testing the full functionality with minimal mocking.
"""

import os
import json
import time
import tempfile
import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from hanzo_mcp.tools.browser_use import (
    BrowserUseInterface,
    get_browser_capabilities,
    navigate_to,
    take_screenshot,
    get_page_content,
    click_element,
    fill_form
)
from hanzo_mcp.tools.mcp_manager import MCPServerManager


class TestBrowserUseIntegration:
    """Integration tests for browser-use functionality."""

    @pytest.fixture(autouse=True)
    def mock_manager_setup(self):
        """Set up mock manager with patched subprocess functionality."""
        # This fixture will automatically be used for all test methods in this class
        # It mocks out the actual server process startup but preserves the rest of the flow

        # Mock for the process
        self.mock_process = MagicMock()
        self.mock_process.stdin = MagicMock()
        self.mock_process.stdout = MagicMock()

        # Set up the mock responses for different tools
        self.tool_responses = {
            "navigate_to": {"success": True, "result": "Navigated to URL"},
            "screenshot": {"success": True, "path": "/tmp/screenshot.png"},
            "get_page_content": {"success": True, "content": "<html><body>Test page</body></html>"},
            "click_element": {"success": True, "result": "Element clicked"},
            "fill_form": {"success": True, "result": "Form filled"}
        }

        # Create the patch for Popen to return our mock process
        self.popen_patcher = patch("subprocess.Popen", return_value=self.mock_process)
        self.mock_popen = self.popen_patcher.start()

        # Create a real manager that will use our mock Popen
        self.manager = MCPServerManager()

        # Patch the _load_config method to use our test config
        with patch.object(MCPServerManager, "_load_config"):
            self.manager.servers = {
                "browser-use": {
                    "command": "uvx",
                    "args": ["mcp-server-browser-use"],
                    "enabled": True,
                    "description": "Automates browser interactions",
                    "env": {
                        "BROWSER_HEADLESS": "true"
                    }
                }
            }

        # Set up mocked tool info for when server is running
        self.mock_server = MagicMock()
        self.mock_server.tools = {
            "navigate_to": {"name": "navigate_to", "params": {"url": "string"}},
            "screenshot": {"name": "screenshot", "params": {}},
            "get_page_content": {"name": "get_page_content", "params": {}},
            "click_element": {"name": "click_element", "params": {"selector": "string"}},
            "fill_form": {"name": "fill_form", "params": {"selector": "string", "value": "string"}}
        }
        self.mock_server.process = self.mock_process
        self.mock_server.running = True

        # Patch the manager
        self.manager_patcher = patch.object(
            MCPServerManager,
            "get_server",
            return_value=self.mock_server
        )
        self.mock_get_server = self.manager_patcher.start()

        # Patch the is_server_running method
        self.running_patcher = patch.object(
            MCPServerManager,
            "is_server_running",
            return_value=True
        )
        self.mock_is_running = self.running_patcher.start()

        # Patch the start_server method
        # Use AsyncMock for async methods
        start_mock = AsyncMock(return_value={"success": True, "message": "Started server"})
        self.start_patcher = patch.object(
            MCPServerManager,
            "start_server",
            new=start_mock
        )
        self.mock_start_server = self.start_patcher.start()

        # Create our interface with the patched manager
        self.browser_use = BrowserUseInterface(manager=self.manager)
        
        # Patch the global browser_use instance
        self.browser_use_patcher = patch("hanzo_mcp.tools.browser_use.browser_use", self.browser_use)
        self.mock_browser_use = self.browser_use_patcher.start()

        # Setup for the process interaction
        def mock_stdin_write(cmd_str):
            try:
                cmd = json.loads(cmd_str.strip())
                tool_name = cmd.get("tool")
                if tool_name in self.tool_responses:
                    response = self.tool_responses[tool_name]
                    self.mock_process.stdout.readline.return_value = json.dumps(response)
                else:
                    self.mock_process.stdout.readline.return_value = json.dumps({
                        "success": False,
                        "error": f"Unknown tool: {tool_name}"
                    })
            except Exception as e:
                self.mock_process.stdout.readline.return_value = json.dumps({
                    "success": False,
                    "error": f"Invalid command: {str(e)}"
                })

        self.mock_process.stdin.write = MagicMock(side_effect=mock_stdin_write)
        self.mock_process.stdin.flush = MagicMock()

        yield

        # Cleanup
        self.popen_patcher.stop()
        self.manager_patcher.stop()
        self.running_patcher.stop()
        self.start_patcher.stop()
        self.browser_use_patcher.stop()

    @pytest.mark.asyncio
    async def test_navigate_to_url(self):
        """Test navigating to a URL with the browser-use interface."""
        # Test navigating to a URL
        result = await navigate_to("https://example.com")
        print(f"\nTest result: {result}")
        assert result["success"] is True
        assert result["result"] == "Navigated to URL"

    @pytest.mark.asyncio
    async def test_take_screenshot(self):
        """Test taking a screenshot with the browser-use interface."""
        result = await take_screenshot()
        assert result["success"] is True
        assert "path" in result
        assert result["path"] == "/tmp/screenshot.png"

    @pytest.mark.asyncio
    async def test_get_page_content(self):
        """Test getting page content with the browser-use interface."""
        result = await get_page_content()
        assert result["success"] is True
        assert "content" in result
        assert result["content"] == "<html><body>Test page</body></html>"

    @pytest.mark.asyncio
    async def test_click_element(self):
        """Test clicking an element with the browser-use interface."""
        result = await click_element("#test-button")
        assert result["success"] is True
        assert result["result"] == "Element clicked"

    @pytest.mark.asyncio
    async def test_fill_form(self):
        """Test filling a form field with the browser-use interface."""
        result = await fill_form("#input-field", "test value")
        assert result["success"] is True
        assert result["result"] == "Form filled"

    @pytest.mark.asyncio
    async def test_browser_capabilities(self):
        """Test getting browser capabilities with the browser-use interface."""
        result = await get_browser_capabilities()
        assert result["available"] is True
        assert result["running"] is True
        assert "tools" in result
        assert len(result["tools"]) > 0

    @pytest.mark.asyncio
    async def test_browser_automations_sequence(self):
        """Test a sequence of browser automation actions."""
        # Navigate to a URL
        nav_result = await navigate_to("https://example.com/login")
        assert nav_result["success"] is True

        # Fill in a username
        fill_username = await fill_form("#username", "testuser")
        assert fill_username["success"] is True

        # Fill in a password
        fill_password = await fill_form("#password", "password123")
        assert fill_password["success"] is True

        # Click the login button
        click_result = await click_element("#login-button")
        assert click_result["success"] is True

        # Take a screenshot of the result
        screenshot_result = await take_screenshot()
        assert screenshot_result["success"] is True


@pytest.mark.asyncio
async def test_browser_use_with_error_handling():
    """Test the browser-use interface with error handling."""
    # Create a mock manager for testing error cases
    mock_manager = MagicMock(spec=MCPServerManager)
    mock_manager.servers = {"browser-use": MagicMock()}
    mock_manager.is_server_running.return_value = True
    
    # Mock the server to raise exceptions
    mock_server = MagicMock()
    mock_server.tools = {"navigate_to": {"name": "navigate_to", "params": {"url": "string"}}}
    mock_server.process = MagicMock()
    mock_server.process.stdin.write.side_effect = Exception("Connection error")
    
    mock_manager.get_server.return_value = mock_server
    
    # Create the interface with our mock manager
    browser_interface = BrowserUseInterface(manager=mock_manager)
    
    # Test error handling during tool execution
    result = await browser_interface.execute_tool("navigate_to", {"url": "https://example.com"})
    assert result["success"] is False
    assert "Error executing tool" in result["error"]
    
    # Test with a non-existent tool
    mock_server.process.stdin.write.side_effect = None
    mock_server.process.stdout.readline.return_value = json.dumps({
        "success": False,
        "error": "Tool not found"
    })
    
    result = await browser_interface.execute_tool("non_existent_tool", {})
    assert result["success"] is False
