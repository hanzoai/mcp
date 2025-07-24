"""MCP management tools."""

from hanzo_mcp.tools.mcp.mcp_tool import MCPTool

# Legacy imports
from hanzo_mcp.tools.mcp.mcp_add import McpAddTool
from hanzo_mcp.tools.mcp.mcp_remove import McpRemoveTool
from hanzo_mcp.tools.mcp.mcp_stats import McpStatsTool

__all__ = [
    "MCPTool",
    "McpAddTool",
    "McpRemoveTool",
    "McpStatsTool",
]
