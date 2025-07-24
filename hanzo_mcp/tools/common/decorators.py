"""Decorators for MCP tools.

This module provides decorators that handle common cross-cutting concerns
for MCP tools, such as context normalization and error handling.
"""

import functools
import inspect
from typing import Any, Callable, TypeVar, cast
from collections.abc import Awaitable, Coroutine

from mcp.server.fastmcp import Context as MCPContext

F = TypeVar('F', bound=Callable[..., Any])


class MockContext:
    """Mock context for when no real context is available.
    
    This is used when tools are called externally through the MCP protocol
    and the Context parameter is not properly serialized.
    """
    
    def __init__(self):
        self.request_id = "external-request"
        self.client_id = "external-client"
    
    async def info(self, message: str) -> None:
        """Mock info logging - no-op for external calls."""
        pass
    
    async def debug(self, message: str) -> None:
        """Mock debug logging - no-op for external calls."""
        pass
    
    async def warning(self, message: str) -> None:
        """Mock warning logging - no-op for external calls."""
        pass
    
    async def error(self, message: str) -> None:
        """Mock error logging - no-op for external calls."""
        pass
    
    async def report_progress(self, current: int, total: int) -> None:
        """Mock progress reporting - no-op for external calls."""
        pass
    
    async def read_resource(self, uri: str) -> Any:
        """Mock resource reading - returns empty result."""
        return []


def with_context_normalization(func: F) -> F:
    """Decorator that normalizes the context parameter for MCP tools.
    
    This decorator intercepts the ctx parameter and ensures it's a valid
    MCPContext object, even when called externally where it might be
    passed as a string, dict, or None.
    
    Usage:
        @server.tool()
        @with_context_normalization
        async def my_tool(ctx: MCPContext, param: str) -> str:
            # ctx is guaranteed to be a valid context object
            await ctx.info("Processing...")
            return "result"
    
    Args:
        func: The async function to decorate
        
    Returns:
        The decorated function with context normalization
    """
    @functools.wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        # Get function signature to find ctx parameter
        sig = inspect.signature(func)
        params = list(sig.parameters.keys())
        
        # Handle ctx in kwargs
        if 'ctx' in kwargs:
            ctx_value = kwargs['ctx']
            if not _is_valid_context(ctx_value):
                kwargs['ctx'] = MockContext()
        
        # Handle ctx in args (positional)
        elif 'ctx' in params:
            ctx_index = params.index('ctx')
            if ctx_index < len(args):
                ctx_value = args[ctx_index]
                if not _is_valid_context(ctx_value):
                    args_list = list(args)
                    args_list[ctx_index] = MockContext()
                    args = tuple(args_list)
        
        # Call the original function
        return await func(*args, **kwargs)
    
    return cast(F, wrapper)


def _is_valid_context(ctx: Any) -> bool:
    """Check if an object is a valid MCPContext.
    
    Args:
        ctx: The object to check
        
    Returns:
        True if ctx is a valid context object
    """
    # Check for required context methods
    return (
        hasattr(ctx, 'info') and 
        hasattr(ctx, 'debug') and
        hasattr(ctx, 'warning') and
        hasattr(ctx, 'error') and
        hasattr(ctx, 'report_progress') and
        # Ensure they're callable
        callable(getattr(ctx, 'info', None)) and
        callable(getattr(ctx, 'debug', None))
    )


def mcp_tool(
    server: Any,
    name: str | None = None,
    description: str | None = None
) -> Callable[[F], F]:
    """Enhanced MCP tool decorator that includes context normalization.
    
    This decorator combines the standard MCP tool registration with
    automatic context normalization, providing a single-point solution
    for all tools.
    
    Usage:
        @mcp_tool(server, name="my_tool", description="Does something")
        async def my_tool(ctx: MCPContext, param: str) -> str:
            await ctx.info("Processing...")
            return "result"
    
    Args:
        server: The MCP server instance
        name: Optional tool name (defaults to function name)
        description: Optional tool description
        
    Returns:
        Decorator function
    """
    def decorator(func: F) -> F:
        # Apply context normalization first
        normalized_func = with_context_normalization(func)
        
        # Then apply the server's tool decorator
        if hasattr(server, 'tool'):
            # Use the server's tool decorator
            server_decorator = server.tool(name=name, description=description)
            return server_decorator(normalized_func)
        else:
            # Fallback if server doesn't have tool method
            return normalized_func
    
    return decorator


def create_tool_handler(server: Any, tool: Any) -> Callable[[], None]:
    """Create a standardized tool registration handler.
    
    This function creates a registration method that automatically applies
    context normalization to any tool handler registered with the server.
    
    Usage:
        class MyTool(BaseTool):
            def register(self, mcp_server):
                register = create_tool_handler(mcp_server, self)
                register()
    
    Args:
        server: The MCP server instance
        tool: The tool instance with name, description, and handler
        
    Returns:
        A function that registers the tool with context normalization
    """
    def register_with_normalization():
        # Get the original register method
        original_register = tool.__class__.register
        
        # Temporarily replace server.tool to wrap with normalization
        original_tool_decorator = server.tool
        
        def normalized_tool_decorator(name=None, description=None):
            def decorator(func):
                # Apply context normalization
                normalized = with_context_normalization(func)
                # Apply original decorator
                return original_tool_decorator(name=name, description=description)(normalized)
            return decorator
        
        # Monkey-patch temporarily
        server.tool = normalized_tool_decorator
        try:
            # Call original register
            original_register(tool, server)
        finally:
            # Restore original
            server.tool = original_tool_decorator
    
    return register_with_normalization