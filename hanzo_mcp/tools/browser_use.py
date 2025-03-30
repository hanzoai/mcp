"""Browser Use Interface for MCP.

This module provides an interface for interacting with the browser-use MCP server
to enable browser automation capabilities.
"""

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional, Union

from hanzo_mcp.tools.mcp_manager import MCPServerManager

# Set up logging
logger = logging.getLogger(__name__)


class BrowserUseInterface:
    """Interface for interacting with the browser-use MCP server.

    This class provides methods for starting, stopping, and interacting with
    the browser-use server that enables browser automation capabilities.
    """

    def __init__(self, manager: Optional[MCPServerManager] = None):
        """Initialize the BrowserUseInterface.

        Args:
            manager (Optional[MCPServerManager]): The MCP server manager to use.
                If not provided, a new one will be created.
        """
        self.manager = manager or MCPServerManager()
        self._server_name = "browser-use"

    def is_available(self) -> bool:
        """Check if the browser-use server is available.

        Returns:
            bool: True if the server is available, False otherwise.
        """
        return self._server_name in self.manager.servers

    def is_running(self) -> bool:
        """Check if the browser-use server is running.

        Returns:
            bool: True if the server is running, False otherwise.
        """
        return self.manager.is_server_running(self._server_name)

    async def ensure_running(self) -> Dict[str, Any]:
        """Ensure that the browser-use server is running.

        Returns:
            Dict[str, Any]: A dictionary with the result of the operation.
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Browser-use server is not available. Check your MCP configuration."
            }

        if self.is_running():
            return {
                "success": True,
                "message": "Browser-use server is already running."
            }

        return await self.manager.start_server(self._server_name)

    async def stop(self) -> Dict[str, Any]:
        """Stop the browser-use server.

        Returns:
            Dict[str, Any]: A dictionary with the result of the operation.
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Browser-use server is not available. Check your MCP configuration."
            }

        if not self.is_running():
            return {
                "success": True,
                "message": "Browser-use server is not running."
            }

        return await self.manager.stop_server(self._server_name)

    async def restart(self) -> Dict[str, Any]:
        """Restart the browser-use server.

        Returns:
            Dict[str, Any]: A dictionary with the result of the operation.
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Browser-use server is not available. Check your MCP configuration."
            }

        if self.is_running():
            await self.manager.stop_server(self._server_name)

        return await self.manager.start_server(self._server_name)

    async def get_available_tools(self) -> List[Dict[str, Any]]:
        """Get a list of available browser automation tools.

        Returns:
            List[Dict[str, Any]]: A list of available tools with their definitions.
        """
        if not self.is_available() or not self.is_running():
            return []

        server = self.manager.get_server(self._server_name)
        if not server:
            return []

        tool_list = []
        for tool_name, tool_def in server.tools.items():
            tool_info = {
                "name": tool_name,
                "definition": tool_def
            }
            tool_list.append(tool_info)

        return tool_list

    async def execute_tool(self, tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a browser automation tool.

        Args:
            tool_name (str): The name of the tool to execute.
            params (Dict[str, Any]): The parameters to pass to the tool.

        Returns:
            Dict[str, Any]: The result of the tool execution.
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Browser-use server is not available. Check your MCP configuration."
            }

        # Start the server if it's not running
        if not self.is_running():
            start_result = await self.manager.start_server(self._server_name)
            if not start_result.get("success", False):
                return start_result

        server = self.manager.get_server(self._server_name)
        if not server:
            return {
                "success": False,
                "error": f"Failed to get browser-use server."
            }

        # Check if the tool exists
        if tool_name not in server.tools:
            return {
                "success": False,
                "error": f"Tool '{tool_name}' not found in browser-use server."
            }

        # Execute the tool
        try:
            cmd = {
                "tool": tool_name,
                "params": params
            }
            cmd_str = json.dumps(cmd) + "\n"
            server.process.stdin.write(cmd_str)
            server.process.stdin.flush()

            # Read the response
            response_str = server.process.stdout.readline()
            try:
                response = json.loads(response_str)
                return response
            except json.JSONDecodeError:
                return {
                    "success": False,
                    "error": f"Invalid response from browser-use server: {response_str}"
                }
        except Exception as e:
            return {
                "success": False,
                "error": f"Error executing tool '{tool_name}': {str(e)}"
            }


# Create a singleton instance
browser_use = BrowserUseInterface()


# Helper functions for common browser automation tasks
async def get_browser_capabilities() -> Dict[str, Any]:
    """Get the browser automation capabilities.

    Returns:
        Dict[str, Any]: Information about browser automation capabilities.
    """
    if not browser_use.is_available():
        return {
            "available": False,
            "message": "Browser automation is not available. Check your MCP configuration."
        }

    await browser_use.ensure_running()
    tools = await browser_use.get_available_tools()

    return {
        "available": True,
        "running": browser_use.is_running(),
        "tools": tools
    }


async def navigate_to(url: str) -> Dict[str, Any]:
    """Navigate to a URL in the browser.

    Args:
        url (str): The URL to navigate to.

    Returns:
        Dict[str, Any]: The result of the navigation.
    """
    return await browser_use.execute_tool(
        tool_name="navigate_to",
        params={"url": url}
    )


async def take_screenshot() -> Dict[str, Any]:
    """Take a screenshot of the current browser window.

    Returns:
        Dict[str, Any]: The result of the screenshot operation, including the path
            to the screenshot file.
    """
    return await browser_use.execute_tool(
        tool_name="screenshot",
        params={}
    )


async def get_page_content() -> Dict[str, Any]:
    """Get the HTML content of the current page.

    Returns:
        Dict[str, Any]: The result of the operation, including the HTML content.
    """
    return await browser_use.execute_tool(
        tool_name="get_page_content",
        params={}
    )


async def click_element(selector: str) -> Dict[str, Any]:
    """Click an element on the page.

    Args:
        selector (str): The CSS selector for the element to click.

    Returns:
        Dict[str, Any]: The result of the click operation.
    """
    return await browser_use.execute_tool(
        tool_name="click_element",
        params={"selector": selector}
    )


async def fill_form(selector: str, value: str) -> Dict[str, Any]:
    """Fill a form field with a value.

    Args:
        selector (str): The CSS selector for the form field.
        value (str): The value to fill in the form field.

    Returns:
        Dict[str, Any]: The result of the form fill operation.
    """
    return await browser_use.execute_tool(
        tool_name="fill_form",
        params={"selector": selector, "value": value}
    )
