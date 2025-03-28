"""External MCP server support for Hanzo MCP.

This package provides functionality to discover and manage external MCP servers.
It allows Hanzo MCP to proxy requests to other MCP servers.
"""

from hanzo_mcp.external.mcp_manager import ExternalMCPServer, ExternalMCPServerManager
from hanzo_mcp.external.config_manager import MCPServerConfig
from hanzo_mcp.external.registry import MCPServerRegistry
