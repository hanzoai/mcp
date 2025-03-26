"""Tool adapters for converting between MCP tools and OpenAI tools.

This module handles conversion between MCP tool formats and OpenAI function
formats, making MCP tools available to the OpenAI API, and processing tool inputs
and outputs for agent execution.
"""

from collections.abc import Iterable

from openai.types import FunctionParameters
from openai.types.chat import ChatCompletionToolParam

from mcp_claude_code.tools.common.base import BaseTool


def convert_tools_to_openai_functions(tools: list[BaseTool]) -> Iterable[ChatCompletionToolParam]:
    """Convert MCP tools to OpenAI function format.

    Args:
        tools: List of MCP tools

    Returns:
        List of tools formatted for OpenAI API
    """
    openai_tools:Iterable[ChatCompletionToolParam] = []
    for tool in tools:
        openai_tool:ChatCompletionToolParam = {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": convert_tool_parameters(tool),
            },
        }
        openai_tools.append(openai_tool)
    return openai_tools


def convert_tool_parameters(tool: BaseTool) -> FunctionParameters:
    """Convert tool parameters to OpenAI format.

    Args:
        tool: MCP tool

    Returns:
        Parameter schema in OpenAI format
    """
    # Start with a copy of the parameters
    params = tool.parameters.copy()
    
    # Ensure the schema has the right format for OpenAI
    if "properties" not in params:
        params["properties"] = {}
        
    if "type" not in params:
        params["type"] = "object"
        
    if "required" not in params:
        params["required"] = tool.required
        
    return params
