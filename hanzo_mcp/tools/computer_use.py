"""Computer Use MCP interface for Hanzo MCP.

This module provides a clean and composable interface for interacting with the computer-use
MCP server, which provides full computer access capabilities.
This implementation leverages the hanzo_aci module for computer interactions.
"""

import os
import asyncio
import logging
import json
from typing import Dict, List, Optional, Any, Union

# Import hanzo_aci components
from hanzo_aci.concrete import computer as aci_computer
from hanzo_aci.specialized.vector_search import vector_search
from hanzo_aci.specialized.symbolic_reasoning import symbolic_reasoning

logger = logging.getLogger(__name__)


class ComputerUseInterface:
    """Interface for interacting with the computer-use MCP server.
    This is a compatibility wrapper around the hanzo_aci ComputerInterface.
    """

    def __init__(self):
        """Initialize the ComputerUseInterface using hanzo_aci's computer interface."""
        self._computer = aci_computer
        self._server_name = "computer-use"

    async def is_available(self) -> bool:
        """Check if the computer-use server is available.
        
        Returns:
            True if the server is available in the configuration, False otherwise
        """
        return await self._computer.is_available()

    def is_running(self) -> bool:
        """Check if the computer-use server is currently running.
        
        Returns:
            True if the server is running, False otherwise
        """
        # For compatibility - ACI handles this internally
        return True

    async def ensure_running(self) -> Dict[str, Any]:
        """Ensure that the computer-use server is running.
        
        Returns:
            Dictionary with result information
        """
        return await self._computer.ensure_running()

    async def stop(self) -> Dict[str, Any]:
        """Stop the computer-use server.
        
        Returns:
            Dictionary with result information
        """
        # ACI doesn't expose a direct stop method, but we'll return a success response
        # since the interface is designed to be stateless
        return {
            "success": True,
            "message": "ACI computer interface doesn't require explicit stop"
        }

    async def restart(self) -> Dict[str, Any]:
        """Restart the computer-use server.
        
        Returns:
            Dictionary with result information
        """
        # ACI doesn't need explicit restart, but we'll re-ensure it's running
        return await self._computer.ensure_running()

    async def get_available_tools(self) -> List[Dict[str, Any]]:
        """Get all available tools from the computer interface.
        
        Returns:
            List of tool definitions
        """
        capabilities = await self._computer.get_capabilities()
        
        # Transform ACI capabilities into MCP-compatible format
        tools = []
        if "operations" in capabilities:
            for operation in capabilities.get("operations", []):
                tools.append({
                    "name": operation,
                    "definition": {
                        "description": f"ACI operation: {operation}",
                        "parameters": {}
                    }
                })
                
        return tools

    async def execute_tool(
        self,
        tool_name: str,
        params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Execute a tool using the ACI computer interface.
        
        Args:
            tool_name: Name of the tool/operation to execute
            params: Parameters for the tool
            
        Returns:
            Dictionary with the tool result
        """
        try:
            return await self._computer.execute_operation(tool_name, params)
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
    if not await computer_use.is_available():
        return {
            "available": False,
            "message": "Computer use is not available on this system"
        }
        
    await computer_use.ensure_running()
    
    # Get capabilities directly from ACI
    capabilities = await aci_computer.get_capabilities()
    
    # Add specialized module information
    vector_available = await vector_search.is_available()
    symbolic_available = await symbolic_reasoning.is_available()
    
    specialized = {
        "vector_search": {
            "available": vector_available,
            "operations": await vector_search.get_capabilities() if vector_available else []
        },
        "symbolic_reasoning": {
            "available": symbolic_available,
            "operations": await symbolic_reasoning.get_capabilities() if symbolic_available else []
        }
    }
    
    capabilities["specialized_modules"] = specialized
    capabilities["running"] = True  # ACI is stateless/always running
    
    return capabilities


async def open_application(app_name: str) -> Dict[str, Any]:
    """Open an application on the computer.
    
    Args:
        app_name: Name of the application to open
        
    Returns:
        Dictionary with the result of the operation
    """
    return await aci_computer.open_application(app_name)


async def take_screenshot() -> Dict[str, Any]:
    """Take a screenshot of the computer screen.
    
    Returns:
        Dictionary with the path to the screenshot
    """
    return await aci_computer.take_screenshot()


async def file_explorer(path: str) -> Dict[str, Any]:
    """Open the file explorer at a specific path.
    
    Args:
        path: Path to open in the file explorer
        
    Returns:
        Dictionary with the result of the operation
    """
    return await aci_computer.file_explorer(path)


async def clipboard_get() -> Dict[str, Any]:
    """Get the current clipboard contents.
    
    Returns:
        Dictionary with the clipboard contents
    """
    return await aci_computer.clipboard_get()


async def clipboard_set(text: str) -> Dict[str, Any]:
    """Set the clipboard contents.
    
    Args:
        text: Text to set in the clipboard
        
    Returns:
        Dictionary with the result of the operation
    """
    return await aci_computer.clipboard_set(text)


# New specialized functions leveraging ACI's capabilities

async def vector_search_query(query_text: str, project_dir: str, n_results: int = 10) -> Dict[str, Any]:
    """Search the project using vector similarity.
    
    Args:
        query_text: Text to search for
        project_dir: Project directory to search in
        n_results: Number of results to return
        
    Returns:
        Dictionary with search results
    """
    return await vector_search.execute_operation(
        operation="vector_search",
        params={
            "query": query_text,
            "project_dir": project_dir,
            "n_results": n_results
        }
    )


async def find_symbols(file_path: str, symbol_type: Optional[str] = None) -> Dict[str, Any]:
    """Find symbols in a file.
    
    Args:
        file_path: Path to the file
        symbol_type: Optional type of symbol to find (function, class, etc.)
        
    Returns:
        Dictionary with symbols found
    """
    return await symbolic_reasoning.execute_operation(
        operation="find_symbols",
        params={
            "file_path": file_path,
            "symbol_type": symbol_type
        }
    )
