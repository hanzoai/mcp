"""Error handling utilities for MCP tools.

This module provides utility functions for better error handling in MCP tools.
"""

import logging
import traceback
from functools import wraps
from typing import Any, Callable, TypeVar, Awaitable, cast

from mcp.server.fastmcp import Context as MCPContext

# Setup logger
logger = logging.getLogger(__name__)

# Type variables for generic function signatures
T = TypeVar('T')
F = TypeVar('F', bound=Callable[..., Awaitable[Any]])


async def log_error(ctx: MCPContext, error: Exception, message: str) -> None:
    """Log an error to both the logger and the MCP context.
    
    Args:
        ctx: The MCP context
        error: The exception that occurred
        message: A descriptive message about the error
    """
    error_message = f"{message}: {str(error)}"
    stack_trace = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    
    # Log to system logger
    logger.error(error_message)
    logger.debug(stack_trace)
    
    # Log to MCP context if available
    try:
        await ctx.error(error_message)
    except Exception as e:
        logger.error(f"Failed to log error to MCP context: {str(e)}")


def tool_error_handler(func: F) -> F:
    """Decorator for handling errors in tool execution.
    
    This decorator wraps a tool function to catch and properly handle exceptions,
    ensuring they are logged and proper error messages are returned.
    
    Args:
        func: The async tool function to wrap
        
    Returns:
        Wrapped function with error handling
    """
    @wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            # Extract the MCP context from arguments
            ctx = None
            for arg in args:
                if isinstance(arg, MCPContext):
                    ctx = arg
                    break
            
            if not ctx and 'ctx' in kwargs:
                ctx = kwargs['ctx']
                
            if not ctx:
                logger.warning("No MCP context found in tool arguments, error handling will be limited")
            
            # Call the original function
            return await func(*args, **kwargs)
        except Exception as e:
            # Log the error
            error_message = f"Error in tool execution: {func.__name__}"
            if ctx:
                await log_error(ctx, e, error_message)
            else:
                stack_trace = "".join(traceback.format_exception(type(e), e, e.__traceback__))
                logger.error(f"{error_message}: {str(e)}")
                logger.debug(stack_trace)
            
            # Return a friendly error message
            return f"Error executing {func.__name__}: {str(e)}"
    
    return cast(F, wrapper)
