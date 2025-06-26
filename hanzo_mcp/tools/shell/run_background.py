"""Background process execution tool."""

import asyncio
import os
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager


Command = Annotated[
    str,
    Field(
        description="The command to execute in the background",
        min_length=1,
    ),
]

WorkingDir = Annotated[
    Optional[str],
    Field(
        description="Working directory for the command",
        default=None,
    ),
]

Name = Annotated[
    Optional[str],
    Field(
        description="Name for the background process (for identification)",
        default=None,
    ),
]

LogToFile = Annotated[
    bool,
    Field(
        description="Whether to log output to file",
        default=True,
    ),
]

Env = Annotated[
    Optional[dict[str, str]],
    Field(
        description="Environment variables to set",
        default=None,
    ),
]


class RunBackgroundParams(TypedDict, total=False):
    """Parameters for running background commands."""

    command: str
    working_dir: Optional[str]
    name: Optional[str]
    log_to_file: bool
    env: Optional[dict[str, str]]


class BackgroundProcess:
    """Represents a running background process."""
    
    def __init__(
        self,
        process_id: str,
        command: str,
        name: str,
        working_dir: str,
        log_file: Optional[Path],
        process: subprocess.Popen,
    ):
        self.process_id = process_id
        self.command = command
        self.name = name
        self.working_dir = working_dir
        self.log_file = log_file
        self.process = process
        self.start_time = datetime.now()
        self.end_time: Optional[datetime] = None
        
    @property
    def is_running(self) -> bool:
        """Check if process is still running."""
        return self.process.poll() is None
    
    @property
    def pid(self) -> int:
        """Get process ID."""
        return self.process.pid
    
    @property
    def return_code(self) -> Optional[int]:
        """Get return code if process has finished."""
        return self.process.poll()
    
    def terminate(self) -> None:
        """Terminate the process."""
        if self.is_running:
            self.process.terminate()
            self.end_time = datetime.now()
    
    def kill(self) -> None:
        """Kill the process forcefully."""
        if self.is_running:
            self.process.kill()
            self.end_time = datetime.now()
    
    def to_dict(self) -> dict:
        """Convert to dictionary for display."""
        return {
            "id": self.process_id,
            "name": self.name,
            "command": self.command,
            "pid": self.pid,
            "working_dir": self.working_dir,
            "log_file": str(self.log_file) if self.log_file else None,
            "start_time": self.start_time.isoformat(),
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "is_running": self.is_running,
            "return_code": self.return_code,
        }


@final
class RunBackgroundTool(BaseTool):
    """Tool for running commands in the background."""
    
    # Class variable to store running processes
    _processes: dict[str, BackgroundProcess] = {}
    
    def __init__(self, permission_manager: PermissionManager):
        """Initialize the background runner tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager
        self.log_dir = Path.home() / ".hanzo" / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "run_background"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run a command in the background, allowing it to continue running.

Perfect for:
- Starting development servers (npm run dev, python -m http.server)
- Running long-running processes (file watchers, build processes)
- Starting services that need to keep running
- Running multiple processes concurrently

Features:
- Runs process in background, returns immediately
- Optional logging to ~/.hanzo/logs
- Process tracking with unique IDs
- Working directory support
- Environment variable support

Use 'processes' tool to list running processes
Use 'pkill' tool to terminate processes
Use 'logs' tool to view process output

Examples:
- run_background --command "npm run dev" --name "frontend-server"
- run_background --command "python app.py" --working-dir "/path/to/app"
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[RunBackgroundParams],
    ) -> str:
        """Execute a command in the background.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Information about the started process
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        command = params.get("command")
        if not command:
            return "Error: command is required"

        working_dir = params.get("working_dir", os.getcwd())
        name = params.get("name", command.split()[0])
        log_to_file = params.get("log_to_file", True)
        env = params.get("env")

        # Resolve absolute path for working directory
        abs_working_dir = os.path.abspath(working_dir)
        
        # Check permissions
        if not self.permission_manager.has_permission(abs_working_dir):
            return f"Permission denied: {abs_working_dir}"

        # Check if working directory exists
        if not os.path.exists(abs_working_dir):
            return f"Working directory does not exist: {abs_working_dir}"

        # Generate process ID
        process_id = str(uuid.uuid4())[:8]
        
        # Setup logging
        log_file = None
        if log_to_file:
            log_filename = f"{process_id}_{name.replace(' ', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
            log_file = self.log_dir / log_filename

        await tool_ctx.info(f"Starting background process: {name}")

        try:
            # Prepare environment
            process_env = os.environ.copy()
            if env:
                process_env.update(env)

            # Open log file for writing
            if log_file:
                log_handle = open(log_file, 'w')
                stdout = log_handle
                stderr = subprocess.STDOUT
            else:
                stdout = subprocess.DEVNULL
                stderr = subprocess.DEVNULL

            # Start the process
            process = subprocess.Popen(
                command,
                shell=True,
                cwd=abs_working_dir,
                env=process_env,
                stdout=stdout,
                stderr=stderr,
                # Don't wait for process to complete
                start_new_session=True,  # Detach from parent process group
            )

            # Create process object
            bg_process = BackgroundProcess(
                process_id=process_id,
                command=command,
                name=name,
                working_dir=abs_working_dir,
                log_file=log_file,
                process=process,
            )

            # Store in class variable
            RunBackgroundTool._processes[process_id] = bg_process
            
            # Clean up finished processes
            self._cleanup_finished_processes()

            await tool_ctx.info(f"Process started with ID: {process_id}, PID: {process.pid}")

            # Return process information
            return f"""Background process started successfully!

Process ID: {process_id}
Name: {name}
PID: {process.pid}
Command: {command}
Working Directory: {abs_working_dir}
Log File: {log_file if log_file else 'Not logging'}

Use 'processes' to list all running processes
Use 'pkill --id {process_id}' to stop this process
Use 'logs --id {process_id}' to view output (if logging enabled)
"""

        except Exception as e:
            await tool_ctx.error(f"Failed to start background process: {str(e)}")
            return f"Error starting background process: {str(e)}"

    @classmethod
    def get_processes(cls) -> dict[str, BackgroundProcess]:
        """Get all tracked processes."""
        return cls._processes

    @classmethod
    def get_process(cls, process_id: str) -> Optional[BackgroundProcess]:
        """Get a specific process by ID."""
        return cls._processes.get(process_id)

    def _cleanup_finished_processes(self) -> None:
        """Remove finished processes that have been terminated for a while."""
        now = datetime.now()
        to_remove = []
        
        for process_id, process in RunBackgroundTool._processes.items():
            if not process.is_running and process.end_time:
                # Keep finished processes for 5 minutes for log access
                if (now - process.end_time).total_seconds() > 300:
                    to_remove.append(process_id)
        
        for process_id in to_remove:
            del RunBackgroundTool._processes[process_id]

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass