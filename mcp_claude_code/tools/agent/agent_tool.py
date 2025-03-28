"""Agent tool implementation for MCP Claude Code.

This module implements the AgentTool that allows Claude to delegate tasks to sub-agents,
enabling concurrent execution of multiple operations and specialized processing.
"""

import json
import time
from collections.abc import Iterable
from typing import Any, final, override

import litellm
from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP
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
from mcp_claude_code.tools.common.context import DocumentContext, ToolContext, create_tool_context
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.filesystem import get_read_only_filesystem_tools
from mcp_claude_code.tools.jupyter import get_read_only_jupyter_tools
from mcp_claude_code.tools.project import get_project_tools
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
        return """Launch one or more agents that can perform tasks using read-only tools.

This tool creates agents for delegation of tasks such as multi-step searches, complex analyses, 
or other operations that benefit from focused processing. Multiple agents can work concurrently 
on independent tasks, improving performance for complex operations.

Each agent works with its own context and provides a response containing the results of its work.
Results from all agents are combined in the final response.

Args:
    prompts: A list of task descriptions, where each item launches an independent agent.

Returns:
    Combined results from all agent executions
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
                "prompts": {
                    "anyOf": [
                        {
                            "type": "string",
                            "description": "Single task for an agent to perform"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "List of tasks for agents to perform concurrently"
                        }
                    ],
                    "description": "Task(s) for agent(s) to perform"
                }
            },
            "required": ["prompts"],
            "type": "object",
        }

    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.

        Returns:
            List of required parameter names
        """
        return ["prompts"]

    def __init__(
            self, document_context: DocumentContext, permission_manager: PermissionManager, command_executor: CommandExecutor,
            model: str | None = None, api_key: str | None = None, max_tokens: int | None = None
    ) -> None:
        """Initialize the agent tool.

        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
            command_executor: Command executor for running shell commands
            model: Optional model name override in LiteLLM format (e.g., "openai/gpt-4o")
            api_key: Optional API key for the model provider
            max_tokens: Optional maximum tokens for model responses
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        self.command_executor = command_executor
        self.model_override = model
        self.api_key_override = api_key
        self.max_tokens_override = max_tokens
        self.available_tools :list[BaseTool] = []
        self.available_tools.extend(get_read_only_filesystem_tools(self.document_context, self.permission_manager))
        self.available_tools.extend(get_read_only_jupyter_tools(self.document_context, self.permission_manager))
        self.available_tools.extend(get_project_tools(self.document_context, self.permission_manager,self.command_executor))
        

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
        prompts = params.get("prompts")
        if prompts is None:
            await tool_ctx.error("Parameter 'prompts' is required but was not provided")
            return "Error: Parameter 'prompts' is required but was not provided"

        # Validate prompts parameter
        if isinstance(prompts, str):
            # Handle single string case
            if not prompts.strip():  # Empty string
                await tool_ctx.error("Prompt cannot be empty")
                return "Error: Prompt cannot be empty"
            prompts = [prompts]  # Convert to list for uniform handling
        elif isinstance(prompts, list):
            # Handle list case
            if not prompts:  # Empty list
                await tool_ctx.error("At least one prompt must be provided in the array")
                return "Error: At least one prompt must be provided in the array"
            # Check for empty strings in the list
            if any(not isinstance(p, str) or not p.strip() for p in prompts):
                await tool_ctx.error("All prompts must be non-empty strings")
                return "Error: All prompts must be non-empty strings"
        else:
            # Invalid type
            await tool_ctx.error("Parameter 'prompts' must be a string or an array of strings")
            return "Error: Parameter 'prompts' must be a string or an array of strings"
                
        # Decide execution strategy based on number of prompts
        if len(prompts) == 1:
            # Single agent case
            await tool_ctx.info(f"Launching agent with prompt: {prompts[0][:100]}...")
            result = await self._execute_single_agent(prompts[0], tool_ctx)
        else:
            # Multiple agents case
            await tool_ctx.info(f"Launching {len(prompts)} agents in parallel")
            result = await self._execute_multiple_agents(prompts, tool_ctx)
            
        # Calculate execution time
        execution_time = time.time() - start_time
        
        # Format the final result with metrics
        formatted_result = self._format_result(result, execution_time)
        
        # Log completion
        await tool_ctx.info(f"Agent execution completed in {execution_time:.2f}s")
        
        return formatted_result

    async def _execute_single_agent(self, prompt: str, tool_ctx: ToolContext) -> str:
        """Execute a single agent with the given prompt.

        Args:
            prompt: The prompt for the agent
            tool_ctx: Tool context for logging

        Returns:
            Agent execution result
        """
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
            
            return result
            
        except Exception as e:
            # Log and return any errors
            error_message = f"Error executing agent: {str(e)}"
            await tool_ctx.error(error_message)
            return f"Error: {error_message}"
            
    async def _execute_multiple_agents(self, prompts: list[str], tool_ctx: ToolContext) -> str:
        """Execute multiple agents concurrently with the given prompts.

        Args:
            prompts: List of prompts for the agents
            tool_ctx: Tool context for logging

        Returns:
            Combined agent execution results
        """
        # Get available tools for the agents (do this once to avoid redundant work)
        agent_tools = get_allowed_agent_tools(
            self.available_tools, 
            self.permission_manager,
        )
        
        # Convert tools to OpenAI format (do this once to avoid redundant work)
        openai_tools = convert_tools_to_openai_functions(agent_tools)
        
        # Log execution start
        await tool_ctx.info(f"Starting parallel execution of {len(prompts)} agents")
        
        # Create a list to store the tasks
        tasks = []
        results = []
        
        # Handle exceptions for individual agent executions
        for i, prompt in enumerate(prompts):
            try:
                # Create system prompt for this agent
                system_prompt = get_system_prompt(
                    agent_tools,
                    self.permission_manager,
                ).format(prompt=prompt)
                
                # Execute agent and collect the task
                await tool_ctx.info(f"Launching agent {i+1}/{len(prompts)}: {prompt[:50]}...")
                task = self._execute_agent_with_tools(
                    system_prompt, 
                    agent_tools, 
                    openai_tools, 
                    tool_ctx
                )
                tasks.append(task)
            except Exception as e:
                # Log and add error result
                error_message = f"Error preparing agent {i+1}: {str(e)}"
                await tool_ctx.error(error_message)
                results.append(f"Agent {i+1} Error: {error_message}")
        
        # Execute all pending tasks concurrently
        if tasks:
            import asyncio
            try:
                # Wait for all tasks to complete
                completed_results = await asyncio.gather(*tasks, return_exceptions=True)
                
                # Process results, handling any exceptions
                for i, result in enumerate(completed_results):
                    if isinstance(result, Exception):
                        results.append(f"Agent {i+1} Error: {str(result)}")
                    else:
                        results.append(f"Agent {i+1} Result:\n{result}")
            except Exception as e:
                # Handle any unexpected exceptions during gathering
                error_message = f"Error executing agents concurrently: {str(e)}"
                await tool_ctx.error(error_message)
                results.append(f"Error: {error_message}")
        
        # Combine results
        combined_result = "\n\n" + "\n\n---\n\n".join(results)
        return combined_result

    async def _execute_agent_with_tools(
        self,
        system_prompt: str,
        available_tools: list[BaseTool],
        openai_tools: list[ChatCompletionToolParam],
        tool_ctx: ToolContext,
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
        # Get model parameters and name
        model = get_default_model(self.model_override)
        params = get_model_parameters(max_tokens=self.max_tokens_override)
        
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
                # Configure model parameters based on capabilities
                completion_params = {
                    "model": model,
                    "messages": messages,
                    "tools": openai_tools,
                    "tool_choice": "auto",
                    "temperature": params["temperature"],
                    "timeout": params["timeout"],
                }

                if self.api_key_override:
                    completion_params["api_key"] = self.api_key_override
                
                # Add max_tokens if provided
                if params.get("max_tokens"):
                    completion_params["max_tokens"] = params.get("max_tokens")
                
                # Make the model call
                response = litellm.completion(
                        **completion_params #pyright: ignore
                )

                if len(response.choices) == 0: #pyright: ignore
                    raise ValueError("No response choices returned")

                message = response.choices[0].message #pyright: ignore

                # Add message to conversation history
                messages.append(message) #pyright: ignore

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
                            tool_result = await tool.call(ctx=tool_ctx.mcp_context, **function_args)
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
                # Avoid trying to JSON serialize message objects
                await tool_ctx.error(f"Message count: {len(messages)}")
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
                final_response = litellm.completion(
                    model=model,
                    messages=messages,
                    temperature=params["temperature"],
                    timeout=params["timeout"],
                    max_tokens=params.get("max_tokens"),
                )
                
                return final_response.choices[0].message.content or f"Agent reached {limit_type} limit without a response." #pyright: ignore
            except Exception as e:
                await tool_ctx.error(f"Error in final model call: {str(e)}")
                return f"Error in final response: {str(e)}"
        
        # Should not reach here but just in case
        return "Agent execution completed after maximum iterations."

    def _format_result(self, result: str, execution_time: float) -> str:
        """Format agent result with metrics.

        Args:
            result: Raw result from agent(s)
            execution_time: Execution time in seconds

        Returns:
            Formatted result with metrics
        """
        # Check if this is a multi-agent result (contains our separator pattern)
        if "\n\n---\n\n" in result and "Agent " in result:
            # This is a multi-agent response
            agent_count = result.count("Agent ")
            return f"""Multi-agent execution completed in {execution_time:.2f} seconds ({agent_count} agents).

{result}
"""
        else:
            # Single agent response
            return f"""Agent execution completed in {execution_time:.2f} seconds.

AGENT RESPONSE:
{result}
"""
    
    @override
    def register(self, mcp_server: FastMCP) -> None:
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def dispatch_agent(ctx: MCPContext, prompts: str | list[str]) -> str:
             return await tool_self.call(ctx, prompts=prompts) 
