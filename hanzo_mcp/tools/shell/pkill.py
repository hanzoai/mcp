"""Tool for terminating background processes."""

import os
import signal
import psutil
from datetime import datetime
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.shell.run_background import RunBackgroundTool


ProcessId = Annotated[
    Optional[str],
    Field(
        description="Process ID from run_background (use 'processes' to list)",
        default=None,
    ),
]

Pid = Annotated[
    Optional[int],
    Field(
        description="System process ID (PID)",
        default=None,
    ),
]

Name = Annotated[
    Optional[str],
    Field(
        description="Kill all processes matching this name",
        default=None,
    ),
]

Force = Annotated[
    bool,
    Field(
        description="Force kill (SIGKILL instead of SIGTERM)",
        default=False,
    ),
]

All = Annotated[
    bool,
    Field(
        description="Kill all background processes",
        default=False,
    ),
]


class PkillParams(TypedDict, total=False):
    """Parameters for killing processes."""

    id: Optional[str]
    pid: Optional[int]
    name: Optional[str]
    force: bool
    all: bool


@final
class PkillTool(BaseTool):
    """Tool for terminating processes."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the pkill tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "pkill"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Terminate running processes.

Can kill processes by:
- ID: Process ID from run_background (recommended)
- PID: System process ID
- Name: All processes matching name
- All: Terminate all background processes

Options:
- force: Use SIGKILL instead of SIGTERM
- all: Kill all background processes

Examples:
- pkill --id abc123            # Kill specific background process
- pkill --name "npm"           # Kill all npm processes
- pkill --pid 12345            # Kill by system PID
- pkill --all                  # Kill all background processes
- pkill --id abc123 --force    # Force kill
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[PkillParams],
    ) -> str:
        """Kill processes.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of kill operation
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        process_id = params.get("id")
        pid = params.get("pid")
        name = params.get("name")
        force = params.get("force", False)
        kill_all = params.get("all", False)

        # Validate that at least one target is specified
        if not any([process_id, pid, name, kill_all]):
            return "Error: Must specify --id, --pid, --name, or --all"

        killed_count = 0
        errors = []

        try:
            # Kill all background processes
            if kill_all:
                await tool_ctx.info("Killing all background processes")
                processes = RunBackgroundTool.get_processes()
                
                for proc_id, process in list(processes.items()):
                    if process.is_running:
                        try:
                            if force:
                                process.kill()
                            else:
                                process.terminate()
                            killed_count += 1
                            await tool_ctx.info(f"Killed process {proc_id} ({process.name})")
                        except Exception as e:
                            errors.append(f"Failed to kill {proc_id}: {str(e)}")
                
                if killed_count == 0:
                    return "No running background processes to kill."

            # Kill by process ID
            elif process_id:
                await tool_ctx.info(f"Killing process with ID: {process_id}")
                process = RunBackgroundTool.get_process(process_id)
                
                if not process:
                    return f"Process with ID '{process_id}' not found."
                
                if not process.is_running:
                    return f"Process '{process_id}' is not running (return code: {process.return_code})."
                
                try:
                    if force:
                        process.kill()
                    else:
                        process.terminate()
                    killed_count += 1
                    await tool_ctx.info(f"Successfully killed process {process_id}")
                except Exception as e:
                    return f"Failed to kill process: {str(e)}"

            # Kill by PID
            elif pid:
                await tool_ctx.info(f"Killing process with PID: {pid}")
                try:
                    p = psutil.Process(pid)
                    
                    if force:
                        p.kill()
                    else:
                        p.terminate()
                    
                    killed_count += 1
                    await tool_ctx.info(f"Successfully killed PID {pid}")
                    
                    # Check if this was a background process and update it
                    for proc_id, process in RunBackgroundTool.get_processes().items():
                        if process.pid == pid:
                            process.end_time = datetime.now()
                            break
                            
                except psutil.NoSuchProcess:
                    return f"Process with PID {pid} not found."
                except psutil.AccessDenied:
                    return f"Permission denied to kill PID {pid}."
                except Exception as e:
                    return f"Failed to kill PID {pid}: {str(e)}"

            # Kill by name
            elif name:
                await tool_ctx.info(f"Killing all processes matching: {name}")
                
                # First check background processes
                bg_processes = RunBackgroundTool.get_processes()
                for proc_id, process in list(bg_processes.items()):
                    if name.lower() in process.name.lower() and process.is_running:
                        try:
                            if force:
                                process.kill()
                            else:
                                process.terminate()
                            killed_count += 1
                            await tool_ctx.info(f"Killed background process {proc_id} ({process.name})")
                        except Exception as e:
                            errors.append(f"Failed to kill {proc_id}: {str(e)}")
                
                # Also check system processes
                for proc in psutil.process_iter(['pid', 'name']):
                    try:
                        if name.lower() in proc.info['name'].lower():
                            if force:
                                proc.kill()
                            else:
                                proc.terminate()
                            killed_count += 1
                            await tool_ctx.info(f"Killed {proc.info['name']} (PID: {proc.info['pid']})")
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
                    except Exception as e:
                        errors.append(f"Failed to kill PID {proc.info['pid']}: {str(e)}")

            # Build result message
            if killed_count > 0:
                result = f"Successfully killed {killed_count} process(es)."
            else:
                result = "No processes were killed."
            
            if errors:
                result += f"\n\nErrors:\n" + "\n".join(errors)
            
            return result

        except Exception as e:
            await tool_ctx.error(f"Failed to kill processes: {str(e)}")
            return f"Error killing processes: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass