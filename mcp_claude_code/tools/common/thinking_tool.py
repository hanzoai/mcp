"""Thinking tool implementation.

This module provides the ThinkingTool for Claude to engage in structured thinking.
"""

from typing import Any, List, cast, final

from mcp.server.fastmcp import Context as MCPContext

from mcp_claude_code.tools.common.base import BaseTool
from mcp_claude_code.tools.common.context import create_tool_context


@final
class ThinkingTool(BaseTool):
    """Tool for Claude to engage in structured thinking."""
    
    @property
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "think"
        
    @property
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return """Use the tool to think about something.

It will not obtain new information or make any changes to the repository, but just log the thought. Use it when complex reasoning or brainstorming is needed. For example, if you explore the repo and discover the source of a bug, call this tool to brainstorm several unique ways of fixing the bug, and assess which change(s) are likely to be simplest and most effective. Alternatively, if you receive some test results, call this tool to brainstorm ways to fix the failing tests."""
        
    @property
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.
        
        Returns:
            Parameter specifications
        """
        return {
            "properties": {
                "thought": {
                    "title": "Thought",
                    "type": "string"
                }
            },
            "required": ["thought"],
            "title": "thinkArguments",
            "type": "object"
        }
        
    @property
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return ["thought"]
        
    def __init__(self) -> None:
        """Initialize the thinking tool."""
        pass
        
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.
        
        Args:
            ctx: MCP context
            **params: Tool parameters
            
        Returns:
            Tool result
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)
        
        # Extract parameters
        thought = params.get("thought")
        
        # Validate required thought parameter
        if not thought:
            await tool_ctx.error(
                "Parameter 'thought' is required but was None or empty"
            )
            return "Error: Parameter 'thought' is required but was None or empty"

        if thought.strip() == "":
            await tool_ctx.error("Parameter 'thought' cannot be empty")
            return "Error: Parameter 'thought' cannot be empty"

        # Log the thought but don't take action
        await tool_ctx.info("Thinking process recorded")

        # Return confirmation
        return "I've recorded your thinking process. You can continue with your next action based on this analysis."
