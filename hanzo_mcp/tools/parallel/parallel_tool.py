"""Parallel tool execution implementation for Hanzo MCP.

This module implements the ParallelTool that allows Claude to execute multiple tool calls
in parallel using asyncio, improving performance for batch operations.
"""

import asyncio
import json
import time
from typing import Any, Dict, List, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp import tools as mcp_tools

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import DocumentContext, ToolContext, create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager


@final
class ParallelTool(BaseTool):
    """Tool for executing multiple tool calls in parallel.

    The ParallelTool allows Claude to execute multiple tool calls concurrently,
    improving performance for batch operations like reading multiple files.
    """

    @property
    @override
    def name(self) -> str:
        """Get the tool name.

        Returns:
            Tool name
        """
        return "parallel_execute"

    @property
    @override
    def description(self) -> str:
        """Get the tool description.

        Returns:
            Tool description
        """
        return """Execute multiple tool calls in parallel using asyncio.

This tool improves performance by running multiple operations concurrently. It's especially 
useful for batch operations like reading multiple files, searching across multiple directories,
or running multiple independent commands.

Each tool call is executed concurrently, and the results are combined in the final response.
The tool accepts a list of tool requests, where each request specifies the tool name and parameters.

For security reasons, certain tools like file write operations may not be allowed to run in parallel.

Args:
    requests: A list of tool requests, where each request has a "tool" name and "params" object.

Returns:
    Combined results from all parallel tool executions
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
                "requests": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": {
                                "type": "string",
                                "description": "Name of the tool to execute"
                            },
                            "params": {
                                "type": "object",
                                "description": "Parameters for the tool"
                            }
                        },
                        "required": ["tool", "params"]
                    },
                    "description": "List of tool requests to execute in parallel"
                }
            },
            "required": ["requests"],
            "type": "object",
        }

    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.

        Returns:
            List of required parameter names
        """
        return ["requests"]

    def __init__(
            self, document_context: DocumentContext, permission_manager: PermissionManager
    ) -> None:
        """Initialize the parallel tool.

        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        
        # List of tools that shouldn't be executed in parallel for safety reasons
        self.restricted_tools = {
            "write_file", 
            "edit_file", 
            "content_replace",
            "edit_notebook",
            "run_command",
            "run_script",
            "script_tool",
            # Don't allow nested parallel execution
            "parallel_execute",
            # Don't allow nested agent execution
            "dispatch_agent"
        }

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
        requests = params.get("requests")
        if requests is None:
            await tool_ctx.error("Parameter 'requests' is required but was not provided")
            return "Error: Parameter 'requests' is required but was not provided"

        if not isinstance(requests, list):
            await tool_ctx.error("Parameter 'requests' must be an array of tool requests")
            return "Error: Parameter 'requests' must be an array of tool requests"

        if not requests:  # Empty list
            await tool_ctx.error("At least one tool request must be provided in the array")
            return "Error: At least one tool request must be provided in the array"

        # Validate all requests
        for i, request in enumerate(requests):
            if not isinstance(request, dict):
                await tool_ctx.error(f"Request {i} must be an object")
                return f"Error: Request {i} must be an object"
                
            tool_name = request.get("tool")
            if not tool_name:
                await tool_ctx.error(f"Request {i} must specify a 'tool' name")
                return f"Error: Request {i} must specify a 'tool' name"
                
            params = request.get("params")
            if params is None:
                await tool_ctx.error(f"Request {i} must specify 'params' object")
                return f"Error: Request {i} must specify 'params' object"
            
            # Check if tool is in restricted list
            if tool_name in self.restricted_tools:
                await tool_ctx.error(f"Tool '{tool_name}' cannot be executed in parallel for safety reasons")
                return f"Error: Tool '{tool_name}' cannot be executed in parallel for safety reasons"
                
        # Log execution start
        await tool_ctx.info(f"Starting parallel execution of {len(requests)} tool calls")
        
        # Execute all tools in parallel
        results = await self._execute_parallel_tools(requests, tool_ctx)
        
        # Calculate execution time
        execution_time = time.time() - start_time
        
        # Format the result
        formatted_result = self._format_result(results, execution_time, len(requests))
        
        # Log completion
        await tool_ctx.info(f"Parallel execution completed in {execution_time:.2f}s")
        
        return formatted_result

    async def _execute_parallel_tools(self, requests: List[Dict[str, Any]], tool_ctx: ToolContext) -> List[Dict[str, Any]]:
        """Execute multiple tools in parallel.

        Args:
            requests: List of tool requests
            tool_ctx: Tool context for logging

        Returns:
            List of results from all tool executions
        """
        tasks = []
        results = []
        
        # Create tasks for all tool calls
        for i, request in enumerate(requests):
            try:
                tool_name = request.get("tool")
                tool_params = request.get("params", {})
                
                # Log tool execution
                await tool_ctx.info(f"Preparing tool {i+1}/{len(requests)}: {tool_name}")
                
                # Create task for tool execution
                task = asyncio.create_task(
                    self._execute_single_tool(
                        tool_name=tool_name,
                        tool_params=tool_params,
                        tool_ctx=tool_ctx,
                        request_index=i
                    )
                )
                tasks.append(task)
            except Exception as e:
                error_message = f"Error preparing tool {i+1}: {str(e)}"
                await tool_ctx.error(error_message)
                results.append({
                    "index": i,
                    "tool": request.get("tool", "unknown"),
                    "status": "error",
                    "result": error_message
                })
        
        # Execute all pending tasks concurrently
        if tasks:
            try:
                # Wait for all tasks to complete
                completed_results = await asyncio.gather(*tasks, return_exceptions=True)
                
                # Process results, handling any exceptions
                for result in completed_results:
                    if isinstance(result, Exception):
                        await tool_ctx.error(f"Error in task execution: {str(result)}")
                        # Find the index by checking which result is missing
                        missing_indices = [i for i in range(len(requests)) if not any(r.get("index") == i for r in results)]
                        if missing_indices:
                            index = missing_indices[0]
                            results.append({
                                "index": index,
                                "tool": requests[index].get("tool", "unknown"),
                                "status": "error",
                                "result": f"Error: {str(result)}"
                            })
                    else:
                        results.append(result)
            except Exception as e:
                # Handle any unexpected exceptions during gathering
                error_message = f"Error executing tools concurrently: {str(e)}"
                await tool_ctx.error(error_message)
                results.append({
                    "index": -1,
                    "tool": "parallel_execute",
                    "status": "error",
                    "result": f"Error: {error_message}"
                })
        
        # Sort results by index for consistent output
        results.sort(key=lambda r: r.get("index", 0))
        return results

    async def _execute_single_tool(
        self,
        tool_name: str,
        tool_params: Dict[str, Any],
        tool_ctx: ToolContext,
        request_index: int
    ) -> Dict[str, Any]:
        """Execute a single tool.

        Args:
            tool_name: Name of the tool to execute
            tool_params: Parameters for the tool
            tool_ctx: Tool context for logging
            request_index: Index of the request in the batch

        Returns:
            Result of the tool execution
        """
        try:
            # Log tool execution start
            await tool_ctx.info(f"Executing tool {request_index+1}: {tool_name}")
            
            # Get function from MCP context
            mcp_context = tool_ctx.mcp_context
            registry = mcp_tools.get_registry(mcp_context)
            
            if tool_name not in registry:
                raise ValueError(f"Tool '{tool_name}' not found in the registry")
            
            # Call the tool function
            tool_result = await registry[tool_name](mcp_context, **tool_params)
            
            # Log successful completion
            await tool_ctx.info(f"Tool {request_index+1} ({tool_name}) completed successfully")
            
            return {
                "index": request_index,
                "tool": tool_name,
                "status": "success",
                "result": tool_result
            }
        except Exception as e:
            # Log error
            error_message = f"Error executing tool {tool_name}: {str(e)}"
            await tool_ctx.error(error_message)
            
            return {
                "index": request_index,
                "tool": tool_name,
                "status": "error",
                "result": f"Error: {error_message}"
            }

    def _format_result(self, results: List[Dict[str, Any]], execution_time: float, request_count: int) -> str:
        """Format parallel execution results.

        Args:
            results: List of results from parallel execution
            execution_time: Execution time in seconds
            request_count: Number of tool requests

        Returns:
            Formatted result string
        """
        # Create JSON result structure
        json_result = {
            "execution_time": f"{execution_time:.2f}s",
            "total_requests": request_count,
            "successful": sum(1 for r in results if r.get("status") == "success"),
            "failed": sum(1 for r in results if r.get("status") != "success"),
            "results": results
        }
        
        # Format as JSON string with indentation
        return json.dumps(json_result, indent=2)
    
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register the tool with the MCP server.

        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def parallel_execute(ctx: MCPContext, requests: List[Dict[str, Any]]) -> str:
            """Execute multiple tool calls in parallel.

            Args:
                ctx: MCP context
                requests: List of tool requests to execute in parallel

            Returns:
                Combined results from all parallel tool executions
            """
            return await tool_self.call(ctx, requests=requests)
