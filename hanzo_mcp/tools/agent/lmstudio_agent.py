"""LM Studio agent tool for parallel model execution.

This module provides a tool for running tasks in parallel across multiple LM Studio models.
"""

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import DocumentContext, create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.agent.lmstudio_provider import LMStudioProvider

logger = logging.getLogger(__name__)


@final
class LMStudioAgentTool(BaseTool):
    """Tool for parallel execution of tasks across multiple LM Studio models."""

    @property
    @override
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "lmstudio_dispatch"
        
    @property
    @override
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return """Run tasks in parallel across multiple LM Studio models.

This tool allows you to dispatch the same task or different tasks to multiple locally available
LM Studio models and execute them in parallel. This is useful for comparing model responses,
leveraging different model strengths, or simply speeding up processing by distributing tasks.

The task prompts can be the same for all models or different per model.

Args:
    model_tasks: A list of configurations, each with a 'model' name, and a 'prompt'.
                Optionally can include 'system_prompt', 'temperature', 'max_tokens' and 'top_p'

Returns:
    Combined results from all model executions with performance metrics
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
                "model_tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "model": {
                                "type": "string",
                                "description": "Name of the LM Studio model to use"
                            },
                            "identifier": {
                                "type": "string",
                                "description": "Optional identifier for the model instance"
                            },
                            "prompt": {
                                "type": "string",
                                "description": "Task prompt for the model"
                            },
                            "system_prompt": {
                                "type": "string",
                                "description": "Optional system prompt for the model"
                            },
                            "temperature": {
                                "type": "number",
                                "description": "Sampling temperature (defaults to 0.7)"
                            },
                            "max_tokens": {
                                "type": "integer",
                                "description": "Maximum tokens to generate (defaults to 2048)"
                            },
                            "top_p": {
                                "type": "number",
                                "description": "Top-p sampling parameter (defaults to 0.95)"
                            }
                        },
                        "required": ["model", "prompt"]
                    },
                    "description": "List of model task configurations to execute in parallel"
                }
            },
            "required": ["model_tasks"],
            "type": "object"
        }
        
    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return ["model_tasks"]
        
    def __init__(self, document_context: DocumentContext, permission_manager: PermissionManager) -> None:
        """Initialize the LM Studio agent tool.
        
        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        self.provider = LMStudioProvider()
        
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
        model_tasks = params.get("model_tasks")
        if not model_tasks:
            await tool_ctx.error("Parameter 'model_tasks' is required but was not provided")
            return "Error: Parameter 'model_tasks' is required but was not provided"
            
        if not isinstance(model_tasks, list):
            await tool_ctx.error("Parameter 'model_tasks' must be an array")
            return "Error: Parameter 'model_tasks' must be an array"
            
        if not model_tasks:
            await tool_ctx.error("At least one model task must be provided")
            return "Error: At least one model task must be provided"
            
        # Validate each model task
        for i, task in enumerate(model_tasks):
            if not isinstance(task, dict):
                await tool_ctx.error(f"Model task at index {i} must be an object")
                return f"Error: Model task at index {i} must be an object"
                
            if "model" not in task:
                await tool_ctx.error(f"Model task at index {i} must have a 'model' property")
                return f"Error: Model task at index {i} must have a 'model' property"
                
            if "prompt" not in task:
                await tool_ctx.error(f"Model task at index {i} must have a 'prompt' property")
                return f"Error: Model task at index {i} must have a 'prompt' property"
        
        # Initialize the provider if needed
        await self.provider.initialize()
        
        # Execute the tasks in parallel
        await tool_ctx.info(f"Executing {len(model_tasks)} tasks across LM Studio models")
        result = await self._execute_parallel_tasks(model_tasks, tool_ctx)
        
        # Calculate execution time
        execution_time = time.time() - start_time
        
        # Format the result
        formatted_result = self._format_result(result, execution_time)
        
        # Log completion
        await tool_ctx.info(f"LM Studio model execution completed in {execution_time:.2f}s")
        
        return formatted_result
    
    async def _execute_parallel_tasks(self, model_tasks: List[Dict[str, Any]], tool_ctx: Any) -> List[Dict[str, Any]]:
        """Execute multiple model tasks in parallel.
        
        Args:
            model_tasks: List of model task configurations
            tool_ctx: Tool context for logging
            
        Returns:
            List of task results
        """
        # Create tasks for loading models
        load_tasks = []
        
        for task in model_tasks:
            model_name = task["model"]
            identifier = task.get("identifier")
            
            await tool_ctx.info(f"Loading model: {model_name}" + (f" as {identifier}" if identifier else ""))
            load_tasks.append(self.provider.load_model(model_name, identifier))
            
        # Wait for all models to load
        try:
            model_ids = await asyncio.gather(*load_tasks)
        except Exception as e:
            await tool_ctx.error(f"Failed to load models: {str(e)}")
            return [{"error": f"Failed to load models: {str(e)}"}]
            
        # Create tasks for generating responses
        generation_tasks = []
        
        for i, (task, model_id) in enumerate(zip(model_tasks, model_ids)):
            prompt = task["prompt"]
            system_prompt = task.get("system_prompt")
            max_tokens = task.get("max_tokens", 2048)
            temperature = task.get("temperature", 0.7)
            top_p = task.get("top_p", 0.95)
            
            await tool_ctx.info(f"Generating with model {model_id}")
            generation_tasks.append(
                self._execute_single_task(
                    model_id=model_id,
                    prompt=prompt,
                    system_prompt=system_prompt,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    top_p=top_p,
                    task_index=i,
                    tool_ctx=tool_ctx,
                    original_task=task
                )
            )
            
        # Wait for all generation tasks to complete
        results = await asyncio.gather(*generation_tasks, return_exceptions=True)
        
        # Process results, handling any exceptions
        processed_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                processed_results.append({
                    "model": model_tasks[i]["model"],
                    "error": str(result),
                    "success": False
                })
            else:
                processed_results.append(result)
                
        return processed_results
    
    async def _execute_single_task(
        self,
        model_id: str,
        prompt: str,
        system_prompt: Optional[str],
        max_tokens: int,
        temperature: float,
        top_p: float,
        task_index: int,
        tool_ctx: Any,
        original_task: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Execute a single model task.
        
        Args:
            model_id: Model identifier
            prompt: Prompt for the model
            system_prompt: Optional system prompt
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature
            top_p: Top-p sampling parameter
            task_index: Index of the task
            tool_ctx: Tool context for logging
            original_task: Original task configuration
            
        Returns:
            Task result
        """
        task_start_time = time.time()
        
        try:
            # Generate response
            generated_text, metadata = await self.provider.generate(
                model_id=model_id,
                prompt=prompt,
                system_prompt=system_prompt,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p
            )
            
            # Calculate execution time
            task_execution_time = time.time() - task_start_time
            
            await tool_ctx.info(f"Task {task_index} completed in {task_execution_time:.2f}s")
            
            # Return result
            return {
                "model": original_task["model"],
                "identifier": model_id,
                "result": generated_text,
                "execution_time": task_execution_time,
                "success": True,
                "metadata": metadata
            }
        except Exception as e:
            await tool_ctx.error(f"Error executing task {task_index}: {str(e)}")
            return {
                "model": original_task["model"],
                "identifier": model_id,
                "error": str(e),
                "execution_time": time.time() - task_start_time,
                "success": False
            }
    
    def _format_result(self, results: List[Dict[str, Any]], total_execution_time: float) -> str:
        """Format the task results.
        
        Args:
            results: List of task results
            total_execution_time: Total execution time
            
        Returns:
            Formatted results
        """
        # Calculate summary statistics
        successful = [r for r in results if r.get("success", False)]
        failed = [r for r in results if not r.get("success", False)]
        
        # Create the result string
        output = [f"### LM Studio Dispatch Results\n"]
        output.append(f"**Total execution time:** {total_execution_time:.2f}s")
        output.append(f"**Models used:** {len(results)}")
        output.append(f"**Successful:** {len(successful)}")
        output.append(f"**Failed:** {len(failed)}\n")
        
        # Add the results for each model
        for i, result in enumerate(results):
            model_name = result.get("model", "Unknown model")
            model_id = result.get("identifier", model_name)
            
            output.append(f"## Model {i+1}: {model_name}")
            
            if result.get("success", False):
                exec_time = result.get("execution_time", 0)
                output.append(f"**Execution time:** {exec_time:.2f}s")
                
                # Add the result
                output.append("\n**Result:**\n")
                output.append(result.get("result", "No result"))
            else:
                output.append(f"**Error:** {result.get('error', 'Unknown error')}")
                
            output.append("\n" + "-" * 40 + "\n")
            
        return "\n".join(output)
    
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this tool with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def lmstudio_dispatch(ctx: MCPContext, model_tasks: List[Dict[str, Any]]) -> str:
            return await tool_self.call(ctx, model_tasks=model_tasks)
