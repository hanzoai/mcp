"""Authentication tool implementation for Hanzo MCP.

This module implements the AuthTool that allows authentication with Hanzo API
and services, enabling secure access to Hanzo resources.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import DocumentContext, ToolContext, create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager


@final
class AuthTool(BaseTool):
    """Tool for authenticating with Hanzo API and services.

    The AuthTool provides functionality for logging in to Hanzo services,
    managing API keys, and handling authentication for API requests.
    """

    @property
    @override
    def name(self) -> str:
        """Get the tool name.

        Returns:
            Tool name
        """
        return "hanzo_login"

    @property
    @override
    def description(self) -> str:
        """Get the tool description.

        Returns:
            Tool description
        """
        return """Authenticate with Hanzo API and services.

This tool allows logging in to Hanzo services using API credentials.
Credentials are securely stored in the user's home directory for future use.
The default API endpoint is https://api.hanzo.ai.

Args:
    api_key: Hanzo API key for authentication
    api_endpoint: Optional custom API endpoint (default: https://api.hanzo.ai)

Returns:
    Authentication result
"""

    @property
    @override
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.

        Returns:
            Parameter specifications
        """
        return {
            "properties": {
                "api_key": {
                    "type": "string",
                    "description": "Hanzo API key for authentication"
                },
                "api_endpoint": {
                    "type": "string",
                    "description": "Optional custom API endpoint (default: https://api.hanzo.ai)",
                    "default": "https://api.hanzo.ai"
                }
            },
            "required": ["api_key"],
            "type": "object",
        }

    @property
    @override
    def required(self) -> list[str]:
        """Get the list of required parameter names.

        Returns:
            List of required parameter names
        """
        return ["api_key"]

    def __init__(
            self, document_context: DocumentContext, permission_manager: PermissionManager
    ) -> None:
        """Initialize the auth tool.

        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        
        # Config directory in user home
        self.config_dir = Path.home() / ".hanzo"
        
        # Ensure config directory exists
        self.config_dir.mkdir(parents=True, exist_ok=True)
        
        # Credentials file
        self.credentials_file = self.config_dir / "credentials.json"

    @override
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Tool execution result
        """
        # Create tool context
        tool_ctx = create_tool_context(ctx)
        tool_ctx.set_tool_info(self.name)

        # Extract parameters
        api_key = params.get("api_key")
        if api_key is None:
            await tool_ctx.error("Parameter 'api_key' is required but was not provided")
            return "Error: Parameter 'api_key' is required but was not provided"

        api_endpoint = params.get("api_endpoint", "https://api.hanzo.ai")
        
        # Save credentials
        try:
            await self._save_credentials(api_key, api_endpoint, tool_ctx)
            return f"Successfully authenticated with Hanzo API at {api_endpoint}"
        except Exception as e:
            error_message = f"Error authenticating with Hanzo API: {str(e)}"
            await tool_ctx.error(error_message)
            return f"Error: {error_message}"

    async def _save_credentials(self, api_key: str, api_endpoint: str, tool_ctx: ToolContext) -> None:
        """Save credentials to the config file.

        Args:
            api_key: Hanzo API key
            api_endpoint: API endpoint
            tool_ctx: Tool context for logging
        """
        # Create credentials object
        credentials = {
            "api_key": api_key,
            "api_endpoint": api_endpoint
        }
        
        # Save to file with secure permissions
        try:
            # Write to JSON file
            with open(self.credentials_file, "w") as f:
                json.dump(credentials, f, indent=2)
            
            # Set file permissions (0600 - user read/write only)
            os.chmod(self.credentials_file, 0o600)
            
            await tool_ctx.info(f"Credentials saved to {self.credentials_file}")
        except Exception as e:
            await tool_ctx.error(f"Error saving credentials: {str(e)}")
            raise

    @staticmethod
    def load_credentials() -> Dict[str, str]:
        """Load saved credentials.

        Returns:
            Dictionary with API credentials or empty dict if not found
        """
        # Config directory in user home
        config_dir = Path.home() / ".hanzo"
        credentials_file = config_dir / "credentials.json"
        
        # Check if credentials file exists
        if not credentials_file.exists():
            return {}
        
        # Load credentials
        try:
            with open(credentials_file, "r") as f:
                return json.load(f)
        except Exception:
            return {}

    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register the tool with the MCP server.

        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure
        
        @mcp_server.tool(name=self.name, description=self.mcp_description)
        async def hanzo_login(ctx: MCPContext, api_key: str, api_endpoint: str = "https://api.hanzo.ai") -> str:
            """Authenticate with Hanzo API and services.

            Args:
                ctx: MCP context
                api_key: Hanzo API key for authentication
                api_endpoint: Optional custom API endpoint (default: https://api.hanzo.ai)

            Returns:
                Authentication result
            """
            return await tool_self.call(ctx, api_key=api_key, api_endpoint=api_endpoint)
