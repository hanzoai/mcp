"""Context handling fix for MCP tools.

This module provides backward compatibility by re-exporting the
context normalization utilities from the decorators module.

DEPRECATED: Use hanzo_mcp.tools.common.decorators directly.
"""

# Re-export for backward compatibility
from hanzo_mcp.tools.common.decorators import (
    MockContext,
    with_context_normalization,
    _is_valid_context as is_valid_context,
)

# Backward compatibility function
def normalize_context(ctx):
    """Normalize context - backward compatibility wrapper.
    
    DEPRECATED: Use decorators.with_context_normalization instead.
    """
    if is_valid_context(ctx):
        return ctx
    return MockContext()

__all__ = ['MockContext', 'normalize_context', 'with_context_normalization']