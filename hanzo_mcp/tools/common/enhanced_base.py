"""Enhanced base classes for MCP tools with automatic context handling.

This module provides enhanced base classes that automatically handle
context normalization and other cross-cutting concerns, ensuring
consistent behavior across all tools.
"""

from abc import ABC, abstractmethod
from typing import Any, get_type_hints, get_args, get_origin
import inspect

from mcp.server import FastMCP
from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.decorators import with_context_normalization


class EnhancedBaseTool(BaseTool, ABC):
    """Enhanced base class for MCP tools with automatic context normalization.
    
    This base class automatically wraps the tool registration to include
    context normalization, ensuring that all tools handle external calls
    properly without requiring manual decoration or copy-pasted code.
    """
    
    def register(self, mcp_server: FastMCP) -> None:
        """Register this tool with automatic context normalization.
        
        This method automatically applies context normalization to the tool
        handler, ensuring it works properly when called externally.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        # Get the tool method from the subclass
        tool_method = self._create_tool_handler()
        
        # Apply context normalization decorator
        normalized_method = with_context_normalization(tool_method)
        
        # Register with the server
        mcp_server.tool(
            name=self.name,
            description=self.description
        )(normalized_method)
    
    @abstractmethod
    def _create_tool_handler(self) -> Any:
        """Create the tool handler function.
        
        Subclasses must implement this to return an async function
        that will be registered as the tool handler.
        
        Returns:
            An async function that handles tool calls
        """
        pass


class AutoRegisterTool(BaseTool, ABC):
    """Base class that automatically generates tool handlers from the call method.
    
    This base class inspects the call method signature and automatically
    creates a properly typed tool handler with context normalization.
    """
    
    def register(self, mcp_server: FastMCP) -> None:
        """Register this tool with automatic handler generation.
        
        This method inspects the call method signature and automatically
        creates a tool handler with the correct parameters and types.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        # Get the call method signature
        call_method = self.call
        sig = inspect.signature(call_method)
        
        # Get type hints for proper typing
        hints = get_type_hints(call_method)
        
        # Create a dynamic handler function
        tool_self = self
        
        # Build the handler dynamically based on the call signature
        params = list(sig.parameters.items())
        
        # Skip 'self' and 'ctx' parameters
        tool_params = [(name, param) for name, param in params 
                      if name not in ('self', 'ctx')]
        
        # Create the handler function dynamically
        async def handler(ctx: MCPContext, **kwargs: Any) -> Any:
            # Call the tool's call method with the context and parameters
            return await tool_self.call(ctx, **kwargs)
        
        # Apply context normalization
        normalized_handler = with_context_normalization(handler)
        
        # Register with the server
        mcp_server.tool(
            name=self.name,
            description=self.description
        )(normalized_handler)