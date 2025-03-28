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
    def agent_tool_with_params(self, document_context, permission_manager, command_executor):
        """Create a test agent tool with custom parameters."""
        with patch("mcp_claude_code.tools.agent.agent_tool.litellm"):
            return AgentTool(
                document_context=document_context, 
                permission_manager=permission_manager,
                command_executor=command_executor,
                model="anthropic/claude-3-sonnet",
                api_key="test_anthropic_key",
                max_tokens=2000
            )
            
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
        assert "Launch one or more agents" in agent_tool.description
        assert agent_tool.required == ["prompts"]
        assert agent_tool.model_override is None
        assert agent_tool.api_key_override is None
        assert agent_tool.max_tokens_override is None
        
    def test_initialization_with_params(self, agent_tool_with_params):
        """Test agent tool initialization with custom parameters."""
        assert agent_tool_with_params.name == "dispatch_agent"
        assert agent_tool_with_params.model_override == "anthropic/claude-3-sonnet"
        assert agent_tool_with_params.api_key_override == "test_anthropic_key"
        assert agent_tool_with_params.max_tokens_override == 2000
        
    def test_parameters(self, agent_tool):
        """Test agent tool parameters."""
        params = agent_tool.parameters
        assert "prompts" in params["properties"]
        assert "anyOf" in params["properties"]["prompts"]
        # Updated test to check only array type is supported
        assert any(schema.get("type") == "array" for schema in params["properties"]["prompts"]["anyOf"])
        assert params["required"] == ["prompts"]
        
    def test_model_and_api_key_override(self, document_context, permission_manager, command_executor):
        """Test API key and model override functionality."""
        # Test with antropic model and API key
        agent_tool = AgentTool(
            document_context=document_context,
            permission_manager=permission_manager,
            command_executor=command_executor,
            model="anthropic/claude-3-sonnet",
            api_key="test_anthropic_key"
        )
        
        assert agent_tool.model_override == "anthropic/claude-3-sonnet"
        assert agent_tool.api_key_override == "test_anthropic_key"
        
        # Test with openai model and API key
        agent_tool = AgentTool(
            document_context=document_context,
            permission_manager=permission_manager,
            command_executor=command_executor,
            model="openai/gpt-4o",
            api_key="test_openai_key"
        )
        
        assert agent_tool.model_override == "openai/gpt-4o"
        assert agent_tool.api_key_override == "test_openai_key"
        
        # Test with no model or API key
        agent_tool = AgentTool(
            document_context=document_context,
            permission_manager=permission_manager,
            command_executor=command_executor
        )
        
        assert agent_tool.model_override is None
        assert agent_tool.api_key_override is None
        
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
        assert "prompts" in result
        tool_ctx.error.assert_called_once()
        
    @pytest.mark.asyncio
    async def test_call_with_litellm_error(self, agent_tool, mcp_context):
        """Test agent tool call when litellm raises an error."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.get_tools = AsyncMock(return_value=[])
        
        # Mock litellm to raise an error
        with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
            with patch("mcp_claude_code.tools.agent.agent_tool.litellm.completion", side_effect=RuntimeError("API key error")):
                with patch("mcp_claude_code.tools.agent.agent_tool.get_allowed_agent_tools", return_value=[]):
                    with patch("mcp_claude_code.tools.agent.agent_tool.convert_tools_to_openai_functions", return_value=[]):
                        with patch("mcp_claude_code.tools.agent.agent_tool.get_system_prompt", return_value="System prompt"):
                            # Update the test to use a list instead of a string
                            result = await agent_tool.call(ctx=mcp_context, prompts=["Test prompt"])
                
        # We're just making sure an error is returned, the actual error message may vary in tests
        assert "Error" in result
        tool_ctx.error.assert_called()
        
    @pytest.mark.asyncio
    async def test_call_with_valid_prompt_string(self, agent_tool, mcp_context, mock_tools):
        """Test agent tool call with valid prompt as string."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mcp_context
        
        # Mock the _execute_multiple_agents method
        with patch.object(agent_tool, "_execute_multiple_agents", AsyncMock(return_value="Agent result")):
            with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
                # Update the test to use a list instead of a string
                result = await agent_tool.call(ctx=mcp_context, prompts=["Test prompt"])
                
        assert "Agent execution completed" in result
        assert "Agent result" in result
        tool_ctx.info.assert_called()
        
    @pytest.mark.asyncio
    async def test_call_with_multiple_prompts(self, agent_tool, mcp_context, mock_tools):
        """Test agent tool call with multiple prompts for parallel execution."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mcp_context
        
        # Create test prompts
        test_prompts = ["Task 1", "Task 2", "Task 3"]
        
        # Mock the _execute_multiple_agents method
        multi_agent_result = "\n\n---\n\nAgent 1 Result:\nResult 1\n\n---\n\nAgent 2 Result:\nResult 2\n\n---\n\nAgent 3 Result:\nResult 3"
        with patch.object(agent_tool, "_execute_multiple_agents", AsyncMock(return_value=multi_agent_result)):
            with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
                result = await agent_tool.call(ctx=mcp_context, prompts=test_prompts)
                
        assert "Multi-agent execution completed" in result
        assert "(3 agents)" in result
        assert "Agent 1 Result" in result
        assert "Agent 2 Result" in result
        assert "Agent 3 Result" in result
        tool_ctx.info.assert_called()
        
    @pytest.mark.asyncio
    async def test_call_with_empty_prompt_list(self, agent_tool, mcp_context):
        """Test agent tool call with an empty prompt list."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        
        with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
            # Test with empty list
            result = await agent_tool.call(ctx=mcp_context, prompts=[])
            
        assert "Error" in result
        assert "At least one prompt must be provided" in result
        tool_ctx.error.assert_called()
        
    @pytest.mark.asyncio
    async def test_call_with_invalid_type(self, agent_tool, mcp_context):
        """Test agent tool call with an invalid parameter type."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.set_tool_info = AsyncMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        
        with patch("mcp_claude_code.tools.agent.agent_tool.create_tool_context", return_value=tool_ctx):
            # Test with invalid type (number)
            result = await agent_tool.call(ctx=mcp_context, prompts=123)
            
        assert "Error" in result
        assert "Parameter 'prompts' must be a string or an array of strings" in result
        tool_ctx.error.assert_called()
        
    @pytest.mark.asyncio
    async def test_execute_agent_with_tools_simple(self, agent_tool, mcp_context, mock_tools):
        """Test _execute_agent_with_tools with a simple response."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mcp_context
        
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
            # Execute the method
            result = await agent_tool._execute_agent_with_tools(
                "System prompt",
                "User prompt",
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
        tool_ctx.mcp_context = mcp_context
        
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
            # Mock any complex dictionary or string processing by directly using the expected values in the test
            with patch.object(json, "loads", return_value={"param": "value"}):
                result = await agent_tool._execute_agent_with_tools(
                    "System prompt",
                    "User prompt",
                    mock_tools,
                    [{"type": "function", "function": {"name": mock_tool.name}}],  # openai_tools
                    tool_ctx
                )
        
        assert result == "Final result"
        mock_tool.call.assert_called_once()
        
    @pytest.mark.asyncio
    async def test_execute_multiple_agents(self, agent_tool, mcp_context, mock_tools):
        """Test the _execute_multiple_agents method."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mcp_context
        
        # Create test prompts
        test_prompts = ["Task 1", "Task 2"]
        
        # Mock the necessary dependencies
        with patch("mcp_claude_code.tools.agent.agent_tool.get_allowed_agent_tools", return_value=mock_tools):
            with patch("mcp_claude_code.tools.agent.agent_tool.get_system_prompt", return_value="System prompt"):
                with patch("mcp_claude_code.tools.agent.agent_tool.convert_tools_to_openai_functions", return_value=[]):
                    with patch.object(agent_tool, "_execute_agent_with_tools", side_effect=["Result 1", "Result 2"]):
                        import asyncio
                        with patch.object(asyncio, "gather", AsyncMock(return_value=["Result 1", "Result 2"])):
                            result = await agent_tool._execute_multiple_agents(test_prompts, tool_ctx)
        
        # Check the result format
        assert "Agent 1 Result" in result
        assert "Agent 2 Result" in result
        assert "Result 1" in result
        assert "Result 2" in result
        assert "---" in result  # Check for the separator

    @pytest.mark.asyncio
    async def test_execute_multiple_agents_single_prompt(self, agent_tool, mcp_context, mock_tools):
        """Test the _execute_multiple_agents method with a single prompt."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mcp_context
        
        # Create test prompts - just one
        test_prompts = ["Single task"]
        
        # Mock the necessary dependencies
        with patch("mcp_claude_code.tools.agent.agent_tool.get_allowed_agent_tools", return_value=mock_tools):
            with patch("mcp_claude_code.tools.agent.agent_tool.get_system_prompt", return_value="System prompt"):
                with patch("mcp_claude_code.tools.agent.agent_tool.convert_tools_to_openai_functions", return_value=[]):
                    with patch.object(agent_tool, "_execute_agent_with_tools", AsyncMock(return_value="Single result")):
                        import asyncio
                        with patch.object(asyncio, "gather", AsyncMock(return_value=["Single result"])):
                            result = await agent_tool._execute_multiple_agents(test_prompts, tool_ctx)
        
        # Check that the single result is returned directly without agent prefix or separator
        assert result == "Single result"
        assert "Agent 1" not in result
        assert "---" not in result

    @pytest.mark.asyncio
    async def test_execute_multiple_agents_with_exceptions(self, agent_tool, mcp_context, mock_tools):
        """Test the _execute_multiple_agents method with exceptions."""
        # Mock the tool context
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mcp_context
        
        # Create test prompts
        test_prompts = ["Task 1", "Task that fails", "Task 3"]
        
        # Create a mix of results and exceptions
        gather_results = ["Result 1", Exception("Task failed"), "Result 3"]
        
        # Mock the necessary dependencies
        with patch("mcp_claude_code.tools.agent.agent_tool.get_allowed_agent_tools", return_value=mock_tools):
            with patch("mcp_claude_code.tools.agent.agent_tool.get_system_prompt", return_value="System prompt"):
                with patch("mcp_claude_code.tools.agent.agent_tool.convert_tools_to_openai_functions", return_value=[]):
                    with patch.object(agent_tool, "_execute_agent_with_tools", side_effect=[lambda: "Result 1", lambda: "Result 2", lambda: "Result 3"]):
                        import asyncio
                        with patch.object(asyncio, "gather", AsyncMock(return_value=gather_results)):
                            result = await agent_tool._execute_multiple_agents(test_prompts, tool_ctx)
        
        # Check the result format
        assert "Agent 1 Result" in result
        assert "Agent 2 Error" in result
        assert "Task failed" in result
        assert "Agent 3 Result" in result
        assert "Result 1" in result
        assert "Result 3" in result
