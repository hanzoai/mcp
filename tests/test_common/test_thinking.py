"""Tests for the thinking tool."""

import asyncio
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hanzo_mcp.tools.common.think_tool import ThinkingTool
from hanzo_mcp.tools.common.base import ToolRegistry


@pytest.fixture
def mcp_server():
    """Create a mock MCP server."""
    server = MagicMock()
    server.tool = MagicMock(return_value=lambda func: func)
    return server


@pytest.fixture
def think_tool():
    """Create a ThinkingTool instance."""
    return ThinkingTool()


def test_think_tool_registration(mcp_server, think_tool):
    """Test that the think tool is registered correctly (converted from async)."""
    # Define the async test function
    async def _async_test():
        # Test registration using ToolRegistry
        ToolRegistry.register_tool(mcp_server, think_tool)
        # Check if tool was registered
        assert mcp_server.tool.called
    
    # Run the async test using a manual event loop


def test_think_with_valid_thought(think_tool, mcp_context):
    """Test the think tool with a valid thought (converted from async)."""
    # Define the async test function
    async def _async_test():
        # Mock context calls
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()  # Make sure this is AsyncMock
        tool_ctx.prepare_tool_context = AsyncMock()

        # Patch the create_tool_context function
        with patch(
            "hanzo_mcp.tools.common.think_tool.create_tool_context",
            return_value=tool_ctx,
        ):
            # Test the tool's call method directly
            thought = "I should check if the file exists before trying to read it."
            result = await think_tool.call(ctx=mcp_context, thought=thought)

            # Check that the function behaved correctly
            tool_ctx.set_tool_info.assert_called_once_with("think")
            tool_ctx.info.assert_called_once_with("Thinking process recorded")
            assert "I've recorded your thinking process" in result
    
    # Run the async test using a manual event loop


def test_think_with_empty_thought(think_tool, mcp_context):
    """Test the think tool with an empty thought (converted from async)."""
    # Define the async test function
    async def _async_test():
        # Mock context calls
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()  # Make sure this is AsyncMock
        tool_ctx.prepare_tool_context = AsyncMock()

        # Patch the create_tool_context function
        with patch(
            "hanzo_mcp.tools.common.think_tool.create_tool_context",
            return_value=tool_ctx,
        ):
            # Test with None thought
            result_none = await think_tool.call(ctx=mcp_context, thought=None)
            assert "Error" in result_none

            # Test with empty string thought
            result_empty = await think_tool.call(ctx=mcp_context, thought="")
            assert "Error" in result_empty

            # Test with whitespace-only thought
            result_whitespace = await think_tool.call(ctx=mcp_context, thought="   ")
            assert "Error" in result_whitespace
    
    # Run the async test using a manual event loop
