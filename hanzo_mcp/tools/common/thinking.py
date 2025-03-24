"""Thinking tool for Hanzo MCP.

This module provides a tool for Claude to engage in structured thinking
when performing complex multi-step operations or reasoning through policies.
Following the pattern described in Anthropic's "Claude Think Tool" article.
"""

from typing import final

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.context import create_tool_context


@final
class ThinkingTool:
    """Think tool for Hanzo MCP.

    This class provides a "think" tool that enables Claude to engage in more structured
    thinking when processing complex information or making multi-step decisions.
    """

    def __init__(self) -> None:
        """Initialize the thinking tool."""
        pass

    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register thinking tools with the MCP server.

        Args:
            mcp_server: The FastMCP server instance
        """

        @mcp_server.tool()
        async def think(thought: str, ctx: MCPContext) -> str:
            """Use the tool to think about something.

            It will not obtain new information or make any changes to the repository, but just log the thought. Use it when complex reasoning or brainstorming is needed. For example, if you explore the repo and discover the source of a bug, call this tool to brainstorm several unique ways of fixing the bug, and assess which change(s) are likely to be simplest and most effective. Alternatively, if you receive some test results, call this tool to brainstorm ways to fix the failing tests.

            Args:
                thought: Your thoughts or analysis

            Returns:
                Confirmation that the thinking process has been recorded
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("think")

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
