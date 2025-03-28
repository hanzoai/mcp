"""Thinking tool for Hanzo MCP.

This module provides a tool for LLMs to engage in structured thinking
when performing complex multi-step operations or reasoning through policies.
The thinking can be enhanced by using external LLM providers when available.
"""

import os
import logging
import json
from typing import final, Optional, Dict, Any, Union

# Optional import for HTTP client
try:
    import aiohttp
    has_aiohttp = True
except ImportError:
    has_aiohttp = False

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
        
        # External LLM configuration
        self.use_external_llm = os.environ.get("HANZO_USE_EXTERNAL_LLM", "false").lower() == "true"
        self.hanzo_api_key = os.environ.get("HANZO_API_KEY", "")
        self.hanzo_api_endpoint = os.environ.get("HANZO_API_ENDPOINT", "https://api.hanzo.ai/v1/completions")
        self.external_llm_model = os.environ.get("HANZO_LLM_MODEL", "claude-3-opus-20240229")
        self.external_llm_temperature = float(os.environ.get("HANZO_LLM_TEMPERATURE", "0.7"))
        self.return_to_claude = os.environ.get("HANZO_RETURN_TO_CLAUDE", "true").lower() == "true"

    async def _call_external_llm(self, prompt: str) -> Optional[str]:
        """Call an external LLM using the Hanzo API.
        
        Args:
            prompt: The prompt to send to the external LLM
            
        Returns:
            The response from the external LLM, or None if there was an error
        """
        if not self.hanzo_api_key:
            logger.error("External LLM requested but HANZO_API_KEY not set")
            return None
            
        if not has_aiohttp:
            logger.error("External LLM requested but aiohttp is not installed")
            return None
            
        try:
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.hanzo_api_key}"
            }
            
            payload = {
                "model": self.external_llm_model,
                "prompt": prompt,
                "temperature": self.external_llm_temperature,
                "max_tokens": 4000
            }
            
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.hanzo_api_endpoint,
                    headers=headers,
                    json=payload
                ) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error(f"Error calling external LLM: {error_text}")
                        return None
                        
                    data = await response.json()
                    return data.get("choices", [{}])[0].get("text", "").strip()
                    
        except Exception as e:
            logger.error(f"Error calling external LLM: {str(e)}")
            return None

    async def _enhance_thought(self, thought: str) -> Optional[str]:
        """Enhance a thought using an external LLM provider if available.
        
        Args:
            thought: The original thought to enhance
            
        Returns:
            An enhanced thought if a provider is available, None otherwise
        """
        if not self.enhanced_thinking:
            return None
        
        prompt = self.thinking_prompt_template.format(thought=thought)
        
        try:
            # Use external LLM if configured and aiohttp is available
            if self.use_external_llm and self.hanzo_api_key and has_aiohttp:
                enhanced_thought = await self._call_external_llm(prompt)
                if enhanced_thought:
                    logger.info("Successfully enhanced thought using external LLM")
                    return enhanced_thought
            
            # Fall back to using the provider manager
            if provider_manager.thinking_enabled:
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
            
            # Check if we should return the thought to Claude or use the enhanced version
            if self.return_to_claude and not enhanced_thought:
                await tool_ctx.info("Returning thought for further Claude processing")
                return "I've noted your thinking. Please continue this line of thought by developing your analysis further."
            
            if enhanced_thought:
                await tool_ctx.info("Enhanced thinking completed")
                return f"""I've recorded and analyzed your thinking process:

{enhanced_thought}

You can continue with your next action based on this analysis."""
            else:
                await tool_ctx.info("Basic thinking recorded")
                return "I've recorded your thinking process. You can continue with your next action based on this analysis."
