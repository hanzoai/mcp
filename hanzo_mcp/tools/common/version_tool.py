"""Version tool for displaying project version information."""

import importlib.metadata
from typing import final, TypedDict, Any, Dict, cast

from mcp.server.fastmcp import FastMCP


class VersionToolResponse(TypedDict):
    """Response from the version tool."""

    version: str
    package_name: str


@final
class VersionTool:
    """Tool for displaying version information about the Hanzo MCP package."""

    def __init__(self, mcp_server: FastMCP) -> None:
        """Initialize the version tool.

        Args:
            mcp_server: The MCP server to register with
        """
        self.mcp_server = mcp_server
        self._register()

    def _register(self) -> None:
        """Register the version tool with the MCP server."""
        self.mcp_server.register_function(
            "version",
            self.get_version,
            "Display the current version of hanzo-mcp",
            Dict[str, Any],
            VersionToolResponse,
        )

    def get_version(self) -> VersionToolResponse:
        """Get the current version of the hanzo-mcp package.

        Returns:
            A dictionary containing the package name and version
        """
        try:
            version = importlib.metadata.version("hanzo-mcp")
        except importlib.metadata.PackageNotFoundError:
            # If package not installed, try to read from pyproject.toml
            import os
            import tomllib
            
            try:
                root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
                toml_path = os.path.join(root_dir, "pyproject.toml")
                
                with open(toml_path, "rb") as f:
                    pyproject = tomllib.load(f)
                    version = cast(str, pyproject.get("project", {}).get("version", "unknown"))
            except Exception:
                version = "unknown"
        
        return {"version": version, "package_name": "hanzo-mcp"}
