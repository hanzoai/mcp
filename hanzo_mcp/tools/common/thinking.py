"""Thinking tool for Hanzo MCP.

This module provides a tool for LLMs to engage in structured thinking
when performing complex multi-step operations or reasoning through policies.
The thinking can be enhanced by using external LLM providers when available.
"""

import os
import logging
from typing import final, Optional

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.llm_providers import provider_manager

# Set up logging
logger = logging.getLogger(__name__)


@final
class ThinkingTool:
    """Think tool for Hanzo MCP.

    This class provides a "think" tool that enables LLMs to engage in more structured
    thinking when processing complex information or making multi-step decisions.
    It can optionally use external LLM providers for enhanced thinking capabilities.
    """

    def __init__(self) -> None:
        """Initialize the thinking tool."""
        # Load configuration from environment variables
        self.enhanced_thinking = os.environ.get("HANZO_MCP_ENHANCED_THINKING", "true").lower() == "true"
        self.thinking_prompt_template = os.environ.get(
            "HANZO_MCP_THINKING_PROMPT_TEMPLATE",
            "Analyze the following problem and develop a detailed plan or solution:\n\n{thought}\n\n"
            "Consider multiple approaches, potential issues, and provide a clear recommendation."
        )

    async def _enhance_thought(self, thought: str) -> Optional[str]:
        """Enhance a thought using an external LLM provider if available.
        
        Args:
            thought: The original thought to enhance
            
        Returns:
            An enhanced thought if a provider is available, None otherwise
        """
        if not self.enhanced_thinking or not provider_manager.thinking_enabled:
            return None
        
        prompt = self.thinking_prompt_template.format(thought=thought)
        
        try:
            enhanced_thought = await provider_manager.generate_thought(
                prompt,
                max_tokens=4000,
                temperature=0.7
            )
            if enhanced_thought:
                logger.info("Successfully enhanced thought using external LLM")
                return enhanced_thought
        except Exception as e:
            logger.error(f"Error enhancing thought: {str(e)}")
        
        return None

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
                Confirmation that the thinking process has been recorded, possibly with enhanced analysis
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

            # Log the thought
            await tool_ctx.info("Processing thinking request")
            
            # Try to enhance the thought with an external LLM
            enhanced_thought = await self._enhance_thought(thought)
            
            if enhanced_thought:
                await tool_ctx.info("Enhanced thinking completed")
                return f"""I've recorded and analyzed your thinking process:

{enhanced_thought}

You can continue with your next action based on this analysis."""
            else:
                await tool_ctx.info("Basic thinking recorded")
                return "I've recorded your thinking process. You can continue with your next action based on this analysis."
