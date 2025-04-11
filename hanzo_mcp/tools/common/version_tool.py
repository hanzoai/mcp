"""Version tool for displaying project version information."""

from typing import Any, Dict, TypedDict, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context


class VersionToolResponse(TypedDict):
    """Response from the version tool."""

    version: str
    package_name: str


@final
class VersionTool(BaseTool):
    """Tool for displaying version information about the Hanzo MCP package."""

    @property
    @override
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "version"
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return "Display the current version of hanzo-mcp"
    
    @property
    @override
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.
        
        Returns:
            Parameter specifications
        """
        return {
            "properties": {},
            "required": [],
            "title": "versionArguments",
            "type": "object"
        }
    
    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return []
        
    def __init__(self, mcp_server: FastMCP) -> None:
        """Initialize the version tool and register it with the server.

        Args:
            mcp_server: The MCP server to register with
        """
        self.register(mcp_server)

    @override
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.
        
        Args:
            ctx: MCP context
            **params: Tool parameters
            
        Returns:
            Tool result with version information
        """
        tool_ctx = create_tool_context(ctx)
        tool_ctx.set_tool_info(self.name)
        
        version_info = self.get_version()
        await tool_ctx.info(f"Hanzo MCP version: {version_info['version']}")
        
        return f"Hanzo MCP version: {version_info['version']}"

    def get_version(self) -> VersionToolResponse:
        """Get the current version of the hanzo-mcp package.

        Returns:
            A dictionary containing the package name and version
        """
        # Directly use the __version__ from the hanzo_mcp package
        from hanzo_mcp import __version__
        
        return {"version": __version__, "package_name": "hanzo-mcp"}
        
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this version tool with the MCP server.
        
        Creates a wrapper function that calls this tool's call method and
        registers it with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def version(ctx: MCPContext) -> str:
            return await tool_self.call(ctx)
