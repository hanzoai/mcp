"""Agent tool implementation for MCP Claude Code.

This module implements the AgentTool that allows Claude to delegate tasks to sub-agents,
enabling concurrent execution of multiple operations and specialized processing.
"""

from collections.abc import Iterable
import json
import os
import time
from typing import Any, final, override

from mcp.server.fastmcp import Context as MCPContext, FastMCP
from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam, ChatCompletionToolParam

from mcp_claude_code.tools.agent.prompt import (
    get_allowed_agent_tools,
    get_default_model,
    get_model_parameters,
    get_system_prompt,
)
from mcp_claude_code.tools.agent.tool_adapter import (
    convert_tools_to_openai_functions,
)
from mcp_claude_code.tools.common.base import BaseTool
from mcp_claude_code.tools.common.context import DocumentContext, create_tool_context
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.filesystem import get_filesystem_tools
from mcp_claude_code.tools.jupyter import get_jupyter_tools
from mcp_claude_code.tools.project import get_project_tools
from mcp_claude_code.tools.shell import get_shell_tools
from mcp_claude_code.tools.shell.command_executor import CommandExecutor


@final
class AgentTool(BaseTool):
    """Tool for delegating tasks to sub-agents.

    The AgentTool allows Claude to create and manage sub-agents for performing
    specialized tasks concurrently, such as code search, analysis, and more.
    """

    @property
    @override
    def name(self) -> str:
        """Get the tool name.

        Returns:
            Tool name
        """
        return "dispatch_agent"

    @property
    @override
    def description(self) -> str:
        """Get the tool description.

        Returns:
            Tool description
        """
        return """Launch a new agent that can perform tasks using read-only tools.

This tool creates an agent for delegation of tasks such as multi-step searches, complex analyses, 
or other operations that benefit from focused processing. The agent works independently with its 
own context and provides a single response containing the results of its work.

Args:
    prompt: The task for the agent to perform

Returns:
    Results of the agent's execution
"""

    @property
    @override
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.

        Returns:
            Parameter specifications
        """
        return {
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The task for the agent to perform",
                }
            },
            "required": ["prompt"],
            "type": "object",
        }

    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.

        Returns:
            List of required parameter names
        """
        return ["prompt"]

    def __init__(
            self, document_context: DocumentContext, permission_manager: PermissionManager, command_executor: CommandExecutor
    ) -> None:
        """Initialize the agent tool.

        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        self.command_executor = command_executor
        self.available_tools :list[BaseTool] = []
        self.available_tools.extend(get_filesystem_tools(self.document_context, self.permission_manager))
        self.available_tools.extend(get_jupyter_tools(self.document_context, self.permission_manager))
        self.available_tools.extend(get_project_tools(self.document_context, self.permission_manager,self.command_executor))
        self.available_tools.extend(get_shell_tools(self.permission_manager))
        self.client = None  # Initialize to None instead of calling _init_openai_client directly
        
    def _init_openai_client(self) -> None:
        """Initialize OpenAI client.

        Raises:
            RuntimeError: If OpenAI API key is not set
        """
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY environment variable must be set to use the agent tool"
            )
        self.client = OpenAI(api_key=api_key)

    @override
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Tool execution result
        """
        start_time = time.time()
        
        # Create tool context
        tool_ctx = create_tool_context(ctx)
        tool_ctx.set_tool_info(self.name)

        # Extract parameters
        prompt = params.get("prompt")
        if not prompt:
            await tool_ctx.error("Parameter 'prompt' is required but was not provided")
            return "Error: Parameter 'prompt' is required but was not provided"

        # Check if OpenAI API key is available
        try:
            if not self.client:
                self._init_openai_client()
        except RuntimeError as e:
            await tool_ctx.error(str(e))
            return f"Error: {str(e)}"

        # Log the start of execution
        await tool_ctx.info(f"Launching agent with prompt: {prompt[:100]}...")

        try:
            # Get available tools for the agent
            # The agent has access to the same tools we do, but filtered for safety
                        
            # Apply permissions filtering
            agent_tools = get_allowed_agent_tools(
                self.available_tools, 
                self.permission_manager,
            )
            
            # Create system prompt
            system_prompt = get_system_prompt(
                agent_tools,
                self.permission_manager,
            ).format(prompt=prompt)
            
            # Convert tools to OpenAI format
            openai_tools = convert_tools_to_openai_functions(agent_tools)
            
            # Execute the agent
            await tool_ctx.info(f"Agent executing with {len(agent_tools)} available tools")
            
            # Execute agent with tool handling
            result = await self._execute_agent_with_tools(
                system_prompt, 
                agent_tools, 
                openai_tools, 
                tool_ctx
            )
            
            # Calculate execution time
            execution_time = time.time() - start_time
            
            # Format the final result with metrics
            formatted_result = self._format_result(result, execution_time)
            
            # Log completion
            await tool_ctx.info(f"Agent execution completed in {execution_time:.2f}s")
            
            return formatted_result
            
        except Exception as e:
            # Log and return any errors
            error_message = f"Error executing agent: {str(e)}"
            await tool_ctx.error(error_message)
            return f"Error: {error_message}"

    async def _execute_agent_with_tools(
        self,
        system_prompt: str,
        available_tools: list[BaseTool],
        openai_tools: Iterable[ChatCompletionToolParam],
        tool_ctx: Any,
    ) -> str:
        """Execute agent with tool handling.

        Args:
            system_prompt: System prompt for the agent
            available_tools: List of available tools
            openai_tools: List of tools in OpenAI format
            tool_ctx: Tool context for logging

        Returns:
            Agent execution result
        """
        if not self.client:
            return "Error: OpenAI client not initialized"
            
        # Get model parameters and name
        model = get_default_model()
        params = get_model_parameters()
        
        # Initialize messages
        messages:Iterable[ChatCompletionMessageParam] = []
        messages.append({"role": "system", "content": system_prompt})
        
        # Track tool usage for metrics
        tool_usage = {}
        max_tool_uses = 15  # Safety limit to prevent infinite loops
        total_tool_use_count = 0
        iteration_count = 0
        max_iterations = 10  # Add a maximum number of iterations for safety
        
        # Execute until the agent completes or reaches the limit
        while total_tool_use_count < max_tool_uses and iteration_count < max_iterations:
            iteration_count += 1
            await tool_ctx.info(f"Calling model (iteration {iteration_count})...")
            
            try:
                response = self.client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=openai_tools,
                    tool_choice="auto",
                    temperature=params["temperature"],
                    max_tokens=params["max_tokens"],
                    timeout=params["timeout"],
                )
                
                message = response.choices[0].message

                # Add message to conversation history
                messages.append({ 
                    "role": "assistant", 
                    "content": message.content,
                    "tool_calls": message.tool_calls #pyright: ignore
                })

                # If no tool calls, we're done
                if not message.tool_calls:
                    return message.content or "Agent completed with no response."
                    
                # Process tool calls
                tool_call_count = len(message.tool_calls)
                await tool_ctx.info(f"Processing {tool_call_count} tool calls")
                
                for tool_call in message.tool_calls:
                    if total_tool_use_count >= max_tool_uses:
                        await tool_ctx.info("Reached maximum tool usage limit")
                        break
                        
                    total_tool_use_count += 1
                    function_name = tool_call.function.name
                    
                    # Track usage
                    tool_usage[function_name] = tool_usage.get(function_name, 0) + 1
                    
                    # Log tool usage
                    await tool_ctx.info(f"Agent using tool: {function_name}")
                    
                    # Parse the arguments
                    try:
                        function_args = json.loads(tool_call.function.arguments)
                    except json.JSONDecodeError:
                        function_args = {}
                        
                    # Find the matching tool
                    tool = next((t for t in available_tools if t.name == function_name), None)
                    if not tool:
                        tool_result = f"Error: Tool '{function_name}' not found"
                    else:
                        try:
                            tool_result = await tool.call(ctx=tool_ctx.ctx, **function_args)
                        except Exception as e:
                            tool_result = f"Error executing {function_name}: {str(e)}"
                            
                    # Add the tool result to messages
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": tool_result,
                        }
                    )
                
                # Log progress
                await tool_ctx.info(f"Processed {len(message.tool_calls)} tool calls. Total: {total_tool_use_count}")
                
            except Exception as e:
                await tool_ctx.error(f"Error in model call: {str(e)}")
                return f"Error in agent execution: {str(e)}"
                
        # If we've reached the limit, add a warning and get final response
        if total_tool_use_count >= max_tool_uses or iteration_count >= max_iterations:
            limit_type = "tool usage" if total_tool_use_count >= max_tool_uses else "iterations"
            await tool_ctx.info(f"Reached maximum {limit_type} limit. Getting final response.")
            
            messages.append(
                {
                    "role": "system",
                    "content": f"You have reached the maximum number of {limit_type}. Please provide your final response.",
                }
            )
            
            try:
                # Make a final call to get the result
                final_response = self.client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=params["temperature"],
                    max_tokens=params["max_tokens"],
                    timeout=params["timeout"],
                )
                
                return final_response.choices[0].message.content or f"Agent reached {limit_type} limit without a response."
            except Exception as e:
                await tool_ctx.error(f"Error in final model call: {str(e)}")
                return f"Error in final response: {str(e)}"
        
        # Should not reach here but just in case
        return "Agent execution completed after maximum iterations."

    def _format_result(self, result: str, execution_time: float) -> str:
        """Format agent result with metrics.

        Args:
            result: Raw result from agent
            execution_time: Execution time in seconds

        Returns:
            Formatted result with metrics
        """
        return f"""Agent execution completed in {execution_time:.2f} seconds.

AGENT RESPONSE:
{result}
"""
    
    @override
    def register(self, mcp_server: FastMCP) -> None:
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def dispatch_agent(ctx: MCPContext, prompt:str) -> str:
             return await tool_self.call(ctx,prompt=prompt) 
