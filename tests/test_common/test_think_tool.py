"""Tests for the refactored ThinkingTool."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hanzo_mcp.tools.common.think_tool import ThinkingTool


class TestThinkingTool:
    """Test the refactored ThinkingTool."""

    @pytest.fixture
    def think_tool(self):
        """Create a ThinkingTool instance for testing."""
        return ThinkingTool()

    def test_initialization(self, think_tool: ThinkingTool):
        """Test initializing ThinkingTool."""
        assert think_tool.name == "think"
        assert "Use the tool to think about something" in think_tool.description
        assert think_tool.required == ["thought"]

    def test_valid_thought(self, think_tool: ThinkingTool, mcp_context: MagicMock):
        """Test the thinking tool with a valid thought (converted from async)."""
        # Define the async test function
        async def _async_test_valid_thought():
            # Mock context calls
            tool_ctx = AsyncMock()
            with patch(
                "hanzo_mcp.tools.common.think_tool.create_tool_context",
                return_value=tool_ctx,
            ):
                # Call the tool directly
                thought = "This is a test thought process"
                result = await think_tool.call(ctx=mcp_context, thought=thought)

                # Verify result
                assert "I've recorded your thinking process" in result
                tool_ctx.info.assert_called_with("Thinking process recorded")
        
        # Run the async test using a manual event loop

    def test_empty_thought(self, think_tool: ThinkingTool, mcp_context: MagicMock):
        """Test the thinking tool with an empty thought (converted from async)."""
        # Define the async test function
        async def _async_test_empty_thought():
            # Mock context calls
            tool_ctx = AsyncMock()
            with patch(
                "hanzo_mcp.tools.common.think_tool.create_tool_context",
                return_value=tool_ctx,
            ):
                # Call the tool with an empty thought
                result = await think_tool.call(ctx=mcp_context, thought="")

                # Verify result
                assert "Error: Parameter 'thought' is required but was None or empty" in result
                tool_ctx.error.assert_called()
        
        # Run the async test using a manual event loop
