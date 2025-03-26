"""Common utilities for MCP Claude Code tools."""

from mcp.server.fastmcp import FastMCP

from mcp_claude_code.tools.common.base import ToolRegistry
from mcp_claude_code.tools.common.thinking_tool import ThinkingTool


def register_thinking_tool(
    mcp_server: FastMCP,
) -> None:
    """Register all thinking tools with the MCP server. 
    
    Args:
        mcp_server: The FastMCP server instance
    """
    thinking_tool = ThinkingTool()
    ToolRegistry.register_tool(mcp_server, thinking_tool)
