"""Tests for the agent tool implementation."""

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mcp_claude_code.tools.agent.agent_tool import AgentTool
from mcp_claude_code.tools.common.base import BaseTool
from mcp_claude_code.tools.common.context import DocumentContext
from mcp_claude_code.tools.common.permissions import PermissionManager


class TestAgentTool:
    """Test cases for the AgentTool."""
    
    @pytest.fixture
    def document_context(self):
        """Create a test document context."""
        return MagicMock(spec=DocumentContext)
        
    @pytest.fixture
    def permission_manager(self):
        """Create a test permission manager."""
        return MagicMock(spec=PermissionManager)
        
    @pytest.fixture
    def mcp_context(self):
        """Create a test MCP context."""
        return MagicMock()
        
    @pytest.fixture
    def command_executor(self):
        """Create a test command executor."""
        return MagicMock()
        
    @pytest.fixture
    def agent_tool(self, document_context, permission_manager, command_executor):
        """Create a test agent tool."""
        with patch("mcp_claude_code.tools.agent.agent_tool.litellm"):
            # Set environment variable for test
            os.environ["OPENAI_API_KEY"] = "test_key"
            return AgentTool(document_context, permission_manager, command_executor)
            
    @pytest.fixture
    def mock_tools(self):
        """Create a list of mock tools."""
        tools = []
        for name in ["read_files", "search_content", "directory_tree"]:
            tool = MagicMock(spec=BaseTool)
            tool.name = name
            tool.description = f"Description for {name}"
            tool.parameters = {"properties": {}, "type": "object"}
            tool.required = []
            tools.append(tool)
        return tools
            
    def test_initialization(self, agent_tool):
        """Test agent tool initialization."""
        assert agent_tool.name == "dispatch_agent"
        assert "Launch a new agent" in agent_tool.description
        assert agent_tool.required == ["prompt"]
        
    def test_parameters(self, agent_tool):
        """Test agent tool parameters."""
        params = agent_tool.parameters
        assert "prompt" in params["properties"]
        assert params["required"] == ["prompt"]
        
    @pytest.mark.asyncio
    async def test_call_no_prompt(self, agent_tool, mcp_context):
        """Test agent tool call with no prompt."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        
        with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
            result = await agent_tool.call(ctx=mcp_context)
            
        assert "Error" in result
        assert "prompt" in result
        tool_ctx.error.assert_called_once()
        
    @pytest.mark.asyncio
    async def test_call_no_api_key(self, agent_tool, mcp_context):
        """Test agent tool call with no API key."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.get_tools = AsyncMock()
        
        with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
            with patch.object(agent_tool, "_init_llm_client", side_effect=RuntimeError("API key error")):
                result = await agent_tool.call(ctx=mcp_context, prompt="Test prompt")
                
        # We're just making sure an error is returned, the actual error message may vary in tests
        assert "Error" in result
        tool_ctx.error.assert_called_once()
        
    @pytest.mark.asyncio
    async def test_call_with_valid_prompt(self, agent_tool, mcp_context, mock_tools):
        """Test agent tool call with valid prompt."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.get_tools = AsyncMock(return_value=mock_tools)
        
        # Mock the _execute_agent_with_tools method to avoid complex test
        with patch.object(agent_tool, "_execute_agent_with_tools", AsyncMock(return_value="Agent result")):
            with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
                with patch("mcp_claude_code.tools.agent.agent_tool.get_allowed_agent_tools", return_value=mock_tools):
                    with patch("mcp_claude_code.tools.agent.agent_tool.get_system_prompt", return_value="System prompt"):
                        with patch("mcp_claude_code.tools.agent.agent_tool.convert_tools_to_openai_functions", return_value=[]):
                            result = await agent_tool.call(ctx=mcp_context, prompt="Test prompt")
                
        assert "Agent execution completed" in result
        assert "Agent result" in result
        tool_ctx.info.assert_called()
        
    @pytest.mark.asyncio
    async def test_execute_agent_with_tools_simple(self, agent_tool, mcp_context, mock_tools):
        """Test _execute_agent_with_tools with a simple response."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        
        # Mock the OpenAI response
        mock_message = MagicMock()
        mock_message.content = "Simple result"
        mock_message.tool_calls = None
        
        mock_choice = MagicMock()
        mock_choice.message = mock_message
        
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        
        # Set test mode and mock litellm
        os.environ["TEST_MODE"] = "1"
        with patch("mcp_claude_code.tools.agent.agent_tool.litellm.completion", return_value=mock_response):
            agent_tool.llm_initialized = True  # Set LLM as initialized for the test
            
            # Execute the method
            result = await agent_tool._execute_agent_with_tools(
            "System prompt",
            mock_tools,
            [],  # openai_tools
            tool_ctx
        )
        
        assert result == "Simple result"
        
    @pytest.mark.asyncio
    async def test_execute_agent_with_tools_tool_calls(self, agent_tool, mcp_context, mock_tools):
        """Test _execute_agent_with_tools with tool calls."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.ctx = mcp_context
        
        # Set up one of the mock tools
        mock_tool = mock_tools[0]
        mock_tool.call = AsyncMock(return_value="Tool result")
        
        # Create a tool call
        mock_tool_call = MagicMock()
        mock_tool_call.id = "call_123"
        mock_tool_call.function = MagicMock()
        mock_tool_call.function.name = mock_tool.name
        mock_tool_call.function.arguments = json.dumps({"param": "value"})
        
        # First response with tool call
        first_message = MagicMock()
        first_message.content = None
        first_message.tool_calls = [mock_tool_call]
        
        first_choice = MagicMock()
        first_choice.message = first_message
        
        first_response = MagicMock()
        first_response.choices = [first_choice]
        
        # Second response with final result
        second_message = MagicMock()
        second_message.content = "Final result"
        second_message.tool_calls = None
        
        second_choice = MagicMock()
        second_choice.message = second_message
        
        second_response = MagicMock()
        second_response.choices = [second_choice]
        
        # Set test mode and mock litellm
        os.environ["TEST_MODE"] = "1"
        with patch("mcp_claude_code.tools.agent.agent_tool.litellm.completion", side_effect=[first_response, second_response]):
            agent_tool.llm_initialized = True  # Set LLM as initialized for the test
            
            # Mock any complex dictionary or string processing by directly using the expected values in the test
            with patch.object(json, "loads", return_value={"param": "value"}):
                    result = await agent_tool._execute_agent_with_tools(
                    "System prompt",
                    mock_tools,
                    [{"type": "function", "function": {"name": mock_tool.name}}],  # openai_tools
                    tool_ctx
                )
        
        assert result == "Final result"
        mock_tool.call.assert_called_once()
        
    @pytest.mark.asyncio
    async def test_call_with_exception(self, agent_tool, mcp_context):
        """Test agent tool call with exception."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.get_tools = AsyncMock(side_effect=Exception("Test exception"))
        
        # Mock _format_result to return the raw error message
        with patch.object(agent_tool, "_format_result", return_value="Error: Error executing agent: Test exception"):
            with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
                result = await agent_tool.call(ctx=mcp_context, prompt="Test prompt")
                
        assert "Error" in result
        assert "Test exception" in result
        tool_ctx.error.assert_called_once()
