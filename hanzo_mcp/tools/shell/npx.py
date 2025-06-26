"""Run Node.js packages with npx."""

import subprocess
import shutil
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager


Package = Annotated[
    str,
    Field(
        description="Package name to run (e.g., 'eslint', 'prettier', 'create-react-app')",
        min_length=1,
    ),
]

Args = Annotated[
    Optional[str],
    Field(
        description="Arguments to pass to the package",
        default=None,
    ),
]

Yes = Annotated[
    bool,
    Field(
        description="Auto-confirm package installation",
        default=True,
    ),
]

Timeout = Annotated[
    int,
    Field(
        description="Timeout in seconds (default 120)",
        default=120,
    ),
]


class NpxParams(TypedDict, total=False):
    """Parameters for npx tool."""

    package: str
    args: Optional[str]
    yes: bool
    timeout: int


@final
class NpxTool(BaseTool):
    """Tool for running Node.js packages with npx."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the npx tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "npx"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run Node.js packages using npx (Node package runner).

npx allows running Node.js packages without installing them globally.
It automatically downloads and executes packages on demand.

Common packages:
- eslint: JavaScript linter
- prettier: Code formatter
- typescript: TypeScript compiler
- create-react-app: Create React apps
- create-next-app: Create Next.js apps
- jest: Testing framework
- webpack: Module bundler
- vite: Build tool
- vercel: Deploy to Vercel
- netlify-cli: Deploy to Netlify

Examples:
- npx --package eslint --args "--init"
- npx --package prettier --args "--write src/**/*.js"
- npx --package "create-react-app" --args "my-app"
- npx --package typescript --args "--init"
- npx --package jest --args "--coverage"

For long-running servers, use npx_background instead.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[NpxParams],
    ) -> str:
        """Execute npx command.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Command output
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        package = params.get("package")
        if not package:
            return "Error: package is required"

        args = params.get("args", "")
        yes = params.get("yes", True)
        timeout = params.get("timeout", 120)

        # Check if npx is available
        if not shutil.which("npx"):
            return """Error: npx is not installed. Install Node.js and npm:

On macOS:
brew install node

On Ubuntu/Debian:
sudo apt update && sudo apt install nodejs npm

Or download from: https://nodejs.org/"""

        # Build command
        cmd = ["npx"]
        
        if yes:
            cmd.append("--yes")
        
        cmd.append(package)
        
        # Add package arguments
        if args:
            # Split args properly (basic parsing)
            import shlex
            cmd.extend(shlex.split(args))

        await tool_ctx.info(f"Running: {' '.join(cmd)}")

        try:
            # Execute command
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=True
            )

            output = []
            if result.stdout:
                output.append(result.stdout)
            if result.stderr:
                output.append(f"\nSTDERR:\n{result.stderr}")

            return "\n".join(output) if output else "Command completed successfully with no output."

        except subprocess.TimeoutExpired:
            return f"Error: Command timed out after {timeout} seconds. Use npx_background for long-running processes."
        except subprocess.CalledProcessError as e:
            error_msg = [f"Error: Command failed with exit code {e.returncode}"]
            if e.stdout:
                error_msg.append(f"\nSTDOUT:\n{e.stdout}")
            if e.stderr:
                error_msg.append(f"\nSTDERR:\n{e.stderr}")
            return "\n".join(error_msg)
        except Exception as e:
            await tool_ctx.error(f"Unexpected error: {str(e)}")
            return f"Error running npx: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
