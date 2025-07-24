"""Enhanced MCP server with automatic context normalization.

This module provides an enhanced FastMCP server that automatically
applies context normalization to all registered tools.
"""

from typing import Any, Callable
from functools import wraps

from mcp.server import FastMCP

from hanzo_mcp.tools.common.decorators import with_context_normalization


class EnhancedFastMCP(FastMCP):
    """Enhanced FastMCP server with automatic context normalization.
    
    This server automatically wraps all tool registrations with context
    normalization, ensuring that tools work properly when called externally
    with serialized context parameters.
    """
    
    def tool(
        self,
        name: str | None = None,
        description: str | None = None
    ) -> Callable:
        """Enhanced tool decorator that includes automatic context normalization.
        
        Args:
            name: Tool name (defaults to function name)
            description: Tool description
            
        Returns:
            Decorator function that registers the tool with context normalization
        """
        # Get the original decorator from parent class
        original_decorator = super().tool(
            name=name,
            description=description
        )
        
        # Create our enhanced decorator
        def enhanced_decorator(func: Callable) -> Callable:
            # Apply context normalization first
            # Check if function has ctx parameter
            import inspect
            sig = inspect.signature(func)
            if 'ctx' in sig.parameters:
                normalized_func = with_context_normalization(func)
            else:
                normalized_func = func
            
            # Then apply the original decorator
            return original_decorator(normalized_func)
        
        return enhanced_decorator


def create_enhanced_server(name: str = "hanzo") -> EnhancedFastMCP:
    """Create an enhanced MCP server with automatic context normalization.
    
    Args:
        name: Server name
        
    Returns:
        Enhanced FastMCP server instance
    """
    return EnhancedFastMCP(name)