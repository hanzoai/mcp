"""Tests for the thinking tool."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from hanzo_mcp.tools.common.thinking import ThinkingTool


@pytest.fixture
def mcp_server():
    """Create a mock MCP server."""
    server = MagicMock()
    # Setup a proper tool decorator mock
    registered_func = None
    def tool_decorator():
        def decorator(func):
            nonlocal registered_func
            server.registered_func = func
            return func
        return decorator
    
    server.tool = tool_decorator
    return server


@pytest.fixture
def thinking_tool():
    """Create a ThinkingTool instance."""
    return ThinkingTool()


@pytest.mark.asyncio
async def test_think_tool_registration(mcp_server, thinking_tool):
    """Test that the think tool is registered correctly."""
    thinking_tool.register_tools(mcp_server)
    # Check if tool was registered
    assert hasattr(mcp_server, 'registered_func')


@pytest.mark.asyncio
async def test_think_with_valid_thought():
    """Test the think tool with a valid thought."""
    # Create a mock context
    ctx = MagicMock()
    ctx.info = AsyncMock()
    tool_ctx = MagicMock()
    tool_ctx.info = AsyncMock()
    tool_ctx.set_tool_info = MagicMock()

    # Patch the create_tool_context function
    with patch(
        "hanzo_mcp.tools.common.thinking.create_tool_context",
        return_value=tool_ctx,
    ):
        from hanzo_mcp.tools.common.thinking import ThinkingTool

        thinking_tool = ThinkingTool()

        # Register tool and get the registered function
        server = MagicMock()
        registered_func = None

        def tool_decorator():
            def decorator(func):
                nonlocal registered_func
                registered_func = func
                return func

            return decorator

        server.tool = tool_decorator
        thinking_tool.register_tools(server)

        # Test the registered function
        thought = "I should check if the file exists before trying to read it."
        result = await registered_func(thought=thought, ctx=ctx)

        # Check that the function behaved correctly
        tool_ctx.set_tool_info.assert_called_once_with("think")
        assert "recorded your thinking" in result
        # Now verifying info was called twice with the correct values
        assert tool_ctx.info.call_count == 2
        tool_ctx.info.assert_any_call("Processing thinking request")
        tool_ctx.info.assert_any_call("Basic thinking recorded")


@pytest.mark.asyncio
async def test_think_with_empty_thought():
    """Test the think tool with an empty thought."""
    # Create a mock context
    ctx = MagicMock()
    ctx.error = AsyncMock()
    tool_ctx = MagicMock()
    tool_ctx.error = AsyncMock()
    tool_ctx.set_tool_info = MagicMock()

    # Patch the create_tool_context function
    with patch(
        "hanzo_mcp.tools.common.thinking.create_tool_context",
        return_value=tool_ctx,
    ):
        from hanzo_mcp.tools.common.thinking import ThinkingTool

        thinking_tool = ThinkingTool()

        # Register tool and get the registered function
        server = MagicMock()
        registered_func = None

        def tool_decorator():
            def decorator(func):
                nonlocal registered_func
                registered_func = func
                return func

            return decorator

        server.tool = tool_decorator
        thinking_tool.register_tools(server)

        # Test with None thought
        result_none = await registered_func(thought=None, ctx=ctx)
        assert "Error" in result_none

        # Test with empty string thought
        result_empty = await registered_func(thought="", ctx=ctx)
        assert "Error" in result_empty

        # Test with whitespace-only thought
        result_whitespace = await registered_func(thought="   ", ctx=ctx)
        assert "Error" in result_whitespace
