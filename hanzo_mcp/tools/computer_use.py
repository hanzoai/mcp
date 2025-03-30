"""Computer Use MCP interface for Hanzo MCP.

This module provides a clean and composable interface for interacting with the computer-use
MCP server, which provides full computer access capabilities.
"""

import os
import asyncio
import logging
import json
from typing import Dict, List, Optional, Any, Union

from hanzo_mcp.tools.mcp_manager import MCPServerManager

logger = logging.getLogger(__name__)


class ComputerUseInterface:
    """Interface for interacting with the computer-use MCP server."""

    def __init__(self, manager: Optional[MCPServerManager] = None):
        """Initialize the ComputerUseInterface.
        
        Args:
            manager: Optional MCPServerManager instance. If not provided, a new one will be created.
        """
        self.manager = manager or MCPServerManager()
        self._server_name = "computer-use"

    def is_available(self) -> bool:
        """Check if the computer-use server is available.
        
        Returns:
            True if the server is available in the configuration, False otherwise
        """
        return self._server_name in self.manager.servers

    def is_running(self) -> bool:
        """Check if the computer-use server is currently running.
        
        Returns:
            True if the server is running, False otherwise
        """
        return self.manager.is_server_running(self._server_name)

    async def ensure_running(self) -> Dict[str, Any]:
        """Ensure that the computer-use server is running.
        
        Returns:
            Dictionary with result information
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Server not available: {self._server_name}"
            }
            
        if not self.is_running():
            return self.manager.start_server(self._server_name)
            
        return {
            "success": True,
            "message": f"Server already running: {self._server_name}"
        }

    async def stop(self) -> Dict[str, Any]:
        """Stop the computer-use server.
        
        Returns:
            Dictionary with result information
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Server not available: {self._server_name}"
            }
            
        if not self.is_running():
            return {
                "success": True,
                "message": f"Server not running: {self._server_name}"
            }
            
        return self.manager.stop_server(self._server_name)

    async def restart(self) -> Dict[str, Any]:
        """Restart the computer-use server.
        
        Returns:
            Dictionary with result information
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Server not available: {self._server_name}"
            }
            
        # Stop the server if it's running
        if self.is_running():
            stop_result = self.manager.stop_server(self._server_name)
            if not stop_result["success"]:
                return stop_result
                
        # Start the server
        return self.manager.start_server(self._server_name)

    async def get_available_tools(self) -> List[Dict[str, Any]]:
        """Get all available tools from the computer-use server.
        
        Returns:
            List of tool definitions
        """
        if not self.is_available() or not self.is_running():
            return []
            
        server = self.manager.get_server(self._server_name)
        if not server:
            return []
            
        return [
            {
                "name": tool_name,
                "definition": tool_def
            }
            for tool_name, tool_def in server.tools.items()
        ]

    async def execute_tool(
        self,
        tool_name: str,
        params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Execute a tool on the computer-use server.
        
        Args:
            tool_name: Name of the tool to execute
            params: Parameters for the tool
            
        Returns:
            Dictionary with the tool result
        """
        if not self.is_available():
            return {
                "success": False,
                "error": f"Server not available: {self._server_name}"
            }
            
        # Make sure the server is running
        if not self.is_running():
            start_result = self.manager.start_server(self._server_name)
            if not start_result["success"]:
                return start_result
                
        server = self.manager.get_server(self._server_name)
        if not server:
            return {
                "success": False,
                "error": f"Server not found: {self._server_name}"
            }
            
        # Check if the tool is available
        if tool_name not in server.tools:
            return {
                "success": False,
                "error": f"Tool not found: {tool_name}"
            }
            
        # Prepare the request
        request = {
            "tool": tool_name,
            "params": params
        }
        
        # Send the request
        try:
            response = server.process.stdin.write(json.dumps(request) + "\n")
            server.process.stdin.flush()
            
            # Wait for the response
            response_text = server.process.stdout.readline()
            
            # Parse the response
            try:
                result = json.loads(response_text)
                return result
            except json.JSONDecodeError:
                return {
                    "success": False,
                    "error": f"Invalid response from server: {response_text}"
                }
                
        except Exception as e:
            logger.error(f"Error executing tool: {str(e)}")
            return {
                "success": False,
                "error": f"Error executing tool: {str(e)}"
            }


# Create a singleton instance
computer_use = ComputerUseInterface()


async def get_computer_capabilities() -> Dict[str, Any]:
    """Get information about the computer's capabilities.
    
    Returns:
        Dictionary with information about available tools
    """
    if not computer_use.is_available():
        return {
            "available": False,
            "message": "Computer use is not available on this system"
        }
        
    await computer_use.ensure_running()
    
    tools = await computer_use.get_available_tools()
    
    return {
        "available": True,
        "tools": tools,
        "running": computer_use.is_running()
    }


async def open_application(app_name: str) -> Dict[str, Any]:
    """Open an application on the computer.
    
    Args:
        app_name: Name of the application to open
        
    Returns:
        Dictionary with the result of the operation
    """
    return await computer_use.execute_tool(
        tool_name="open_application",
        params={"name": app_name}
    )


async def take_screenshot() -> Dict[str, Any]:
    """Take a screenshot of the computer screen.
    
    Returns:
        Dictionary with the path to the screenshot
    """
    return await computer_use.execute_tool(
        tool_name="screenshot",
        params={}
    )


async def file_explorer(path: str) -> Dict[str, Any]:
    """Open the file explorer at a specific path.
    
    Args:
        path: Path to open in the file explorer
        
    Returns:
        Dictionary with the result of the operation
    """
    return await computer_use.execute_tool(
        tool_name="file_explorer",
        params={"path": path}
    )


async def clipboard_get() -> Dict[str, Any]:
    """Get the current clipboard contents.
    
    Returns:
        Dictionary with the clipboard contents
    """
    return await computer_use.execute_tool(
        tool_name="clipboard_get",
        params={}
    )


async def clipboard_set(text: str) -> Dict[str, Any]:
    """Set the clipboard contents.
    
    Args:
        text: Text to set in the clipboard
        
    Returns:
        Dictionary with the result of the operation
    """
    return await computer_use.execute_tool(
        tool_name="clipboard_set",
        params={"text": text}
    )
