"""Run Python packages with uvx."""

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
        description="Package name to run (e.g., 'ruff', 'black', 'pytest')",
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

PythonVersion = Annotated[
    Optional[str],
    Field(
        description="Python version to use (e.g., '3.11', '3.12')",
        default=None,
    ),
]

Timeout = Annotated[
    int,
    Field(
        description="Timeout in seconds (default 120)",
        default=120,
    ),
]


class UvxParams(TypedDict, total=False):
    """Parameters for uvx tool."""

    package: str
    args: Optional[str]
    python_version: Optional[str]
    timeout: int


@final
class UvxTool(BaseTool):
    """Tool for running Python packages with uvx."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the uvx tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "uvx"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run Python packages using uvx (Python package runner).

uvx allows running Python applications in isolated environments without 
installing them globally. It automatically manages dependencies and Python versions.

Common packages:
- ruff: Fast Python linter and formatter
- black: Python code formatter
- pytest: Testing framework
- mypy: Static type checker
- pipx: Install Python apps
- httpie: HTTP client
- poetry: Dependency management

Examples:
- uvx --package ruff --args "check ."
- uvx --package black --args "--check src/"
- uvx --package pytest --args "-v tests/"
- uvx --package httpie --args "GET httpbin.org/get"
- uvx --package mypy --args "--strict src/"

For long-running servers, use uvx_background instead.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[UvxParams],
    ) -> str:
        """Execute uvx command.

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
        python_version = params.get("python_version")
        timeout = params.get("timeout", 120)

        # Check if uvx is available
        if not shutil.which("uvx"):
            await tool_ctx.info("uvx not found, attempting to install...")
            
            # Try to auto-install uvx
            install_cmd = "curl -LsSf https://astral.sh/uv/install.sh | sh"
            
            try:
                # Run installation
                install_result = subprocess.run(
                    install_cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                
                if install_result.returncode == 0:
                    await tool_ctx.info("uvx installed successfully!")
                    
                    # Add to PATH for current session
                    import os
                    home = os.path.expanduser("~")
                    os.environ["PATH"] = f"{home}/.cargo/bin:{os.environ.get('PATH', '')}"
                    
                    # Check again
                    if not shutil.which("uvx"):
                        return """Error: uvx installed but not found in PATH. 
Please add ~/.cargo/bin to your PATH and restart your shell.

Add to ~/.zshrc or ~/.bashrc:
export PATH="$HOME/.cargo/bin:$PATH"
"""
                else:
                    return f"""Error: Failed to install uvx automatically.
                    
Install manually with:
curl -LsSf https://astral.sh/uv/install.sh | sh

Or on macOS:
brew install uv

Error details: {install_result.stderr}"""
                    
            except subprocess.TimeoutExpired:
                return """Error: Installation timed out. Install uvx manually with:
curl -LsSf https://astral.sh/uv/install.sh | sh"""
            except Exception as e:
                return f"""Error: Failed to auto-install uvx: {str(e)}
                
Install manually with:
curl -LsSf https://astral.sh/uv/install.sh | sh"""

        # Build command
        cmd = ["uvx"]
        
        if python_version:
            cmd.extend(["--python", python_version])
        
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
            return f"Error: Command timed out after {timeout} seconds. Use uvx_background for long-running processes."
        except subprocess.CalledProcessError as e:
            error_msg = [f"Error: Command failed with exit code {e.returncode}"]
            if e.stdout:
                error_msg.append(f"\nSTDOUT:\n{e.stdout}")
            if e.stderr:
                error_msg.append(f"\nSTDERR:\n{e.stderr}")
            return "\n".join(error_msg)
        except Exception as e:
            await tool_ctx.error(f"Unexpected error: {str(e)}")
            return f"Error running uvx: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
