"""Common utilities for Hanzo MCP tools."""

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.base import ToolRegistry
from hanzo_mcp.tools.common.thinking_tool import ThinkingTool
from hanzo_mcp.tools.common.version_tool import VersionTool


def register_thinking_tool(
    mcp_server: FastMCP,
) -> None:
    """Register all thinking tools with the MCP server. 
    
    Args:
        mcp_server: The FastMCP server instance
    """
    thinking_tool = ThinkingTool()
    ToolRegistry.register_tool(mcp_server, thinking_tool)


def register_version_tool(
    mcp_server: FastMCP,
) -> None:
    """Register the version tool with the MCP server.
    
    Args:
        mcp_server: The FastMCP server instance
    """
    _ = VersionTool(mcp_server)  # Tool registers itself in constructor
