"""Open files or URLs in the default application."""

import platform
import subprocess
import webbrowser
from pathlib import Path
from typing import override
from urllib.parse import urlparse

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from mcp.server import FastMCP


class OpenTool(BaseTool):
    """Tool for opening files or URLs in the default application."""

    name = "open"
    
    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        tool_self = self
        
        @server.tool(name=self.name, description=self.description)
        async def open(
            path: str,
            ctx: MCPContext
        ) -> str:
            return await tool_self.run(ctx, path)
    
    async def call(self, ctx: MCPContext, **params) -> str:
        """Call the tool with arguments."""
        return await self.run(ctx, params["path"])

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Open files or URLs. Platform-aware.

Usage:
open https://example.com
open ./document.pdf
open /path/to/image.png"""

    @override
    async def run(self, ctx: MCPContext, path: str) -> str:
        """Open a file or URL in the default application.
        
        Args:
            ctx: MCP context
            path: File path or URL to open
            
        Returns:
            Success message
            
        Raises:
            RuntimeError: If opening fails
        """
        # Check if it's a URL
        parsed = urlparse(path)
        is_url = parsed.scheme in ('http', 'https', 'ftp', 'file')
        
        if is_url:
            # Open URL in default browser
            try:
                webbrowser.open(path)
                return f"Opened URL in browser: {path}"
            except Exception as e:
                raise RuntimeError(f"Failed to open URL: {e}")
        
        # It's a file path
        file_path = Path(path).expanduser().resolve()
        
        if not file_path.exists():
            raise RuntimeError(f"File not found: {file_path}")
        
        system = platform.system().lower()
        
        try:
            if system == "darwin":  # macOS
                subprocess.run(["open", str(file_path)], check=True)
            elif system == "linux":
                # Try xdg-open first (most common)
                try:
                    subprocess.run(["xdg-open", str(file_path)], check=True)
                except (subprocess.CalledProcessError, FileNotFoundError):
                    # Fallback to other common openers
                    for opener in ["gnome-open", "kde-open", "exo-open"]:
                        try:
                            subprocess.run([opener, str(file_path)], check=True)
                            break
                        except (subprocess.CalledProcessError, FileNotFoundError):
                            continue
                    else:
                        raise RuntimeError("No suitable file opener found on Linux")
            elif system == "windows":
                # Use os.startfile on Windows
                import os
                os.startfile(str(file_path))
            else:
                raise RuntimeError(f"Unsupported platform: {system}")
                
            return f"Opened file: {file_path}"
            
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Failed to open file: {e}")
        except Exception as e:
            raise RuntimeError(f"Error opening file: {e}")


# Create tool instance
open_tool = OpenTool()