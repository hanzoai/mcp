"""Run Node.js packages in background with npx."""

import subprocess
import shutil
import uuid
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.shell.run_background import BackgroundProcess, RunBackgroundTool


Package = Annotated[
    str,
    Field(
        description="Package name to run (e.g., 'http-server', 'json-server', 'serve')",
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

Name = Annotated[
    Optional[str],
    Field(
        description="Process name for identification",
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

LogOutput = Annotated[
    bool,
    Field(
        description="Log output to file in ~/.hanzo/logs",
        default=True,
    ),
]

WorkingDir = Annotated[
    Optional[str],
    Field(
        description="Working directory for the process",
        default=None,
    ),
]


class NpxBackgroundParams(TypedDict, total=False):
    """Parameters for npx background tool."""

    package: str
    args: Optional[str]
    name: Optional[str]
    yes: bool
    log_output: bool
    working_dir: Optional[str]


@final
class NpxBackgroundTool(BaseTool):
    """Tool for running Node.js packages in background with npx."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the npx background tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "npx_background"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run Node.js packages in the background using npx.

Perfect for running servers and long-running Node.js applications.
The process continues running even after the command returns.

Common server packages:
- http-server: Simple HTTP server
- json-server: REST API mock server
- serve: Static file server
- live-server: Dev server with reload
- webpack-dev-server: Webpack dev server
- nodemon: Auto-restart on changes
- localtunnel: Expose local server
- ngrok: Secure tunnels

Examples:
- npx_background --package http-server --args "-p 8080" --name web-server
- npx_background --package json-server --args "db.json --port 3001" --name api
- npx_background --package serve --args "-s build -p 5000" --name static
- npx_background --package live-server --args "--port=8081" --name dev-server

Use 'processes' to list running processes and 'pkill' to stop them.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[NpxBackgroundParams],
    ) -> str:
        """Execute npx command in background.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Process information
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        package = params.get("package")
        if not package:
            return "Error: package is required"

        args = params.get("args", "")
        name = params.get("name", f"npx-{package}")
        yes = params.get("yes", True)
        log_output = params.get("log_output", True)
        working_dir = params.get("working_dir")

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

        # Generate process ID
        process_id = str(uuid.uuid4())[:8]
        
        # Prepare log file if needed
        log_file = None
        if log_output:
            from pathlib import Path
            log_dir = Path.home() / ".hanzo" / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            log_file = log_dir / f"{name}_{process_id}.log"

        await tool_ctx.info(f"Starting background process: {' '.join(cmd)}")

        try:
            # Start process
            if log_output and log_file:
                with open(log_file, "w") as f:
                    process = subprocess.Popen(
                        cmd,
                        stdout=f,
                        stderr=subprocess.STDOUT,
                        cwd=working_dir,
                        start_new_session=True
                    )
            else:
                process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    cwd=working_dir,
                    start_new_session=True
                )

            # Create background process object
            bg_process = BackgroundProcess(
                process_id=process_id,
                command=" ".join(cmd),
                name=name,
                process=process,
                log_file=str(log_file) if log_file else None,
                working_dir=working_dir
            )

            # Register with RunBackgroundTool
            RunBackgroundTool._add_process(bg_process)

            output = [
                f"Started npx background process:",
                f"  ID: {process_id}",
                f"  Name: {name}",
                f"  Package: {package}",
                f"  PID: {process.pid}",
                f"  Command: {' '.join(cmd)}",
            ]
            
            if working_dir:
                output.append(f"  Working Dir: {working_dir}")
            
            if log_file:
                output.append(f"  Log: {log_file}")
            
            output.extend([
                "",
                "Use 'processes' to list running processes.",
                f"Use 'logs --process-id {process_id}' to view output.",
                f"Use 'pkill --process-id {process_id}' to stop."
            ])

            return "\n".join(output)

        except Exception as e:
            await tool_ctx.error(f"Failed to start process: {str(e)}")
            return f"Error starting npx background process: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
