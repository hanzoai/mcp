"""Tests for the enhanced thinking tool."""

import os
import pytest
from unittest.mock import patch, AsyncMock, MagicMock

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.thinking import ThinkingTool
from hanzo_mcp.tools.common.llm_providers import provider_manager


class TestEnhancedThinking:
    """Test suite for enhanced thinking functionality."""

    @pytest.mark.asyncio
    async def test_thinking_tool_basic(self):
        """Test basic functionality of the thinking tool without enhancement."""
        # Disable enhanced thinking
        with patch.dict(os.environ, {"HANZO_MCP_ENHANCED_THINKING": "false"}):
            thinking_tool = ThinkingTool()
            
            # Create mock context
            mock_ctx = AsyncMock()
            mock_tool_ctx = AsyncMock()
            
            # Mock the create_tool_context function
            with patch("hanzo_mcp.tools.common.thinking.create_tool_context", return_value=mock_tool_ctx):
                # Call the think function
                mock_mcp_server = MagicMock()
                # Get the think function
                thinking_tool.register_tools(mock_mcp_server)
                think_func = mock_mcp_server.tool.call_args[0][0]
                
                # Call the think function
                result = await think_func("This is a test thought", mock_ctx)
                
                # Verify the result
                assert "I've recorded your thinking process" in result
                mock_tool_ctx.info.assert_any_call("Processing thinking request")
                mock_tool_ctx.info.assert_any_call("Basic thinking recorded")

    @pytest.mark.asyncio
    async def test_thinking_tool_enhanced(self):
        """Test enhanced functionality of the thinking tool."""
        # Enable enhanced thinking
        with patch.dict(os.environ, {
            "HANZO_MCP_ENHANCED_THINKING": "true",
            "HANZO_MCP_THINKING_ENABLED": "true"
        }):
            thinking_tool = ThinkingTool()
            
            # Create mock context
            mock_ctx = AsyncMock()
            mock_tool_ctx = AsyncMock()
            
            # Mock provider_manager.generate_thought
            mock_enhanced_thought = "Enhanced analysis: This is a more detailed analysis."
            with patch("hanzo_mcp.tools.common.thinking.provider_manager.generate_thought", 
                      new_callable=AsyncMock, return_value=mock_enhanced_thought):
                
                # Mock the create_tool_context function
                with patch("hanzo_mcp.tools.common.thinking.create_tool_context", return_value=mock_tool_ctx):
                    # Call the think function
                    mock_mcp_server = MagicMock()
                    thinking_tool.register_tools(mock_mcp_server)
                    think_func = mock_mcp_server.tool.call_args[0][0]
                    
                    # Call the think function
                    result = await think_func("This is a test thought", mock_ctx)
                    
                    # Verify the result
                    assert "Enhanced analysis" in result
                    mock_tool_ctx.info.assert_any_call("Processing thinking request")
                    mock_tool_ctx.info.assert_any_call("Enhanced thinking completed")

    @pytest.mark.asyncio
    async def test_thinking_tool_enhancement_failure(self):
        """Test thinking tool fallback when enhancement fails."""
        # Enable enhanced thinking
        with patch.dict(os.environ, {
            "HANZO_MCP_ENHANCED_THINKING": "true",
            "HANZO_MCP_THINKING_ENABLED": "true"
        }):
            thinking_tool = ThinkingTool()
            
            # Create mock context
            mock_ctx = AsyncMock()
            mock_tool_ctx = AsyncMock()
            
            # Mock provider_manager.generate_thought to return None (failure)
            with patch("hanzo_mcp.tools.common.thinking.provider_manager.generate_thought", 
                      new_callable=AsyncMock, return_value=None):
                
                # Mock the create_tool_context function
                with patch("hanzo_mcp.tools.common.thinking.create_tool_context", return_value=mock_tool_ctx):
                    # Call the think function
                    mock_mcp_server = MagicMock()
                    thinking_tool.register_tools(mock_mcp_server)
                    think_func = mock_mcp_server.tool.call_args[0][0]
                    
                    # Call the think function
                    result = await think_func("This is a test thought", mock_ctx)
                    
                    # Verify the result falls back to basic thinking
                    assert "I've recorded your thinking process" in result
                    assert "Enhanced analysis" not in result
                    mock_tool_ctx.info.assert_any_call("Processing thinking request")
                    mock_tool_ctx.info.assert_any_call("Basic thinking recorded")

    @pytest.mark.asyncio
    async def test_specified_provider(self):
        """Test using a specified provider."""
        # Set up environment to specify OpenAI provider
        with patch.dict(os.environ, {
            "HANZO_MCP_ENHANCED_THINKING": "true",
            "HANZO_MCP_THINKING_ENABLED": "true",
            "HANZO_MCP_LLM_PROVIDER": "openai"
        }):
            # Create mock providers
            mock_hanzo = AsyncMock()
            mock_hanzo.name = "Hanzo AI"
            mock_hanzo.is_available.return_value = True
            
            mock_openai = AsyncMock()
            mock_openai.name = "OpenAI"
            mock_openai.is_available.return_value = True
            mock_openai.generate_thought.return_value = "OpenAI thought"
            
            # Create manager with mocked providers
            with patch.object(provider_manager, "_providers", [mock_hanzo, mock_openai]):
                with patch.object(provider_manager, "_specified_provider", "openai"):
                    # Call generate_thought
                    result = await provider_manager.generate_thought("Test prompt")
                    
                    # Verify the result used OpenAI
                    assert result == "OpenAI thought"
                    mock_hanzo.generate_thought.assert_not_called()
                    mock_openai.generate_thought.assert_called_once()
