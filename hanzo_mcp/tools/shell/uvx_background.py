"""Run Python packages in background with uvx."""

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
        description="Package name to run (e.g., 'streamlit', 'jupyter-lab', 'mkdocs')",
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

PythonVersion = Annotated[
    Optional[str],
    Field(
        description="Python version to use (e.g., '3.11', '3.12')",
        default=None,
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


class UvxBackgroundParams(TypedDict, total=False):
    """Parameters for uvx background tool."""

    package: str
    args: Optional[str]
    name: Optional[str]
    python_version: Optional[str]
    log_output: bool
    working_dir: Optional[str]


@final
class UvxBackgroundTool(BaseTool):
    """Tool for running Python packages in background with uvx."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the uvx background tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "uvx_background"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run Python packages in the background using uvx.

Perfect for running servers and long-running Python applications.
The process continues running even after the command returns.

Common server packages:
- streamlit: Data app framework
- jupyter-lab: Jupyter Lab server
- mkdocs: Documentation server
- fastapi: FastAPI with uvicorn
- flask: Flask development server
- gradio: ML model demos
- panel: Data app framework

Examples:
- uvx_background --package streamlit --args "run app.py --port 8501" --name streamlit-app
- uvx_background --package jupyter-lab --args "--port 8888" --name jupyter
- uvx_background --package mkdocs --args "serve --dev-addr 0.0.0.0:8000" --name docs
- uvx_background --package gradio --args "app.py" --name ml-demo

Use 'processes' to list running processes and 'pkill' to stop them.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[UvxBackgroundParams],
    ) -> str:
        """Execute uvx command in background.

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
        name = params.get("name", f"uvx-{package}")
        python_version = params.get("python_version")
        log_output = params.get("log_output", True)
        working_dir = params.get("working_dir")

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
                f"Started uvx background process:",
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
            return f"Error starting uvx background process: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
