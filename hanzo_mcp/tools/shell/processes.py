"""Tool for listing running background processes."""

import psutil
from datetime import datetime
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.shell.run_background import RunBackgroundTool


ShowAll = Annotated[
    bool,
    Field(
        description="Show all system processes (not just background processes)",
        default=False,
    ),
]

FilterName = Annotated[
    Optional[str],
    Field(
        description="Filter processes by name",
        default=None,
    ),
]

ShowDetails = Annotated[
    bool,
    Field(
        description="Show detailed process information",
        default=False,
    ),
]


class ProcessesParams(TypedDict, total=False):
    """Parameters for listing processes."""

    show_all: bool
    filter_name: Optional[str]
    show_details: bool


@final
class ProcessesTool(BaseTool):
    """Tool for listing running processes."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the processes tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "processes"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """List running background processes started with run_background.

Shows:
- Process ID (for use with pkill)
- Process name
- Command
- PID (system process ID)
- Status (running/finished)
- Start time
- Log file location

Options:
- show_all: Show all system processes (requires permissions)
- filter_name: Filter by process name
- show_details: Show CPU, memory usage

Examples:
- processes                     # List background processes
- processes --show-details      # Include resource usage
- processes --filter-name npm   # Show only npm processes
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ProcessesParams],
    ) -> str:
        """List running processes.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Process listing
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        show_all = params.get("show_all", False)
        filter_name = params.get("filter_name")
        show_details = params.get("show_details", False)

        try:
            if show_all:
                # Show all system processes
                await tool_ctx.info("Listing all system processes")
                return self._list_system_processes(filter_name, show_details)
            else:
                # Show only background processes
                await tool_ctx.info("Listing background processes")
                return self._list_background_processes(filter_name, show_details)

        except Exception as e:
            await tool_ctx.error(f"Failed to list processes: {str(e)}")
            return f"Error listing processes: {str(e)}"

    def _list_background_processes(
        self, filter_name: Optional[str], show_details: bool
    ) -> str:
        """List background processes started with run_background."""
        processes = RunBackgroundTool.get_processes()
        
        if not processes:
            return "No background processes are currently running."
        
        # Filter if requested
        filtered_processes = []
        for proc_id, process in processes.items():
            if filter_name:
                if filter_name.lower() not in process.name.lower():
                    continue
            filtered_processes.append((proc_id, process))
        
        if not filtered_processes:
            return f"No background processes found matching '{filter_name}'."
        
        # Build output
        output = []
        output.append("=== Background Processes ===\n")
        
        # Sort by start time (newest first)
        filtered_processes.sort(key=lambda x: x[1].start_time, reverse=True)
        
        for proc_id, process in filtered_processes:
            status = "running" if process.is_running else f"finished (code: {process.return_code})"
            runtime = datetime.now() - process.start_time
            runtime_str = str(runtime).split('.')[0]  # Remove microseconds
            
            output.append(f"ID: {proc_id}")
            output.append(f"Name: {process.name}")
            output.append(f"Status: {status}")
            output.append(f"PID: {process.pid}")
            output.append(f"Runtime: {runtime_str}")
            output.append(f"Command: {process.command}")
            output.append(f"Working Dir: {process.working_dir}")
            
            if process.log_file:
                output.append(f"Log File: {process.log_file}")
            
            if show_details and process.is_running:
                try:
                    # Get process details using psutil
                    p = psutil.Process(process.pid)
                    output.append(f"CPU: {p.cpu_percent(interval=0.1):.1f}%")
                    output.append(f"Memory: {p.memory_info().rss / 1024 / 1024:.1f} MB")
                    output.append(f"Threads: {p.num_threads()}")
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    output.append("Process details unavailable")
            
            output.append("-" * 40)
        
        output.append(f"\nTotal: {len(filtered_processes)} process(es)")
        output.append("\nUse 'pkill --id <ID>' to stop a process")
        output.append("Use 'logs --id <ID>' to view process logs")
        
        return "\n".join(output)

    def _list_system_processes(
        self, filter_name: Optional[str], show_details: bool
    ) -> str:
        """List all system processes."""
        try:
            processes = []
            
            # Get all running processes
            for proc in psutil.process_iter(['pid', 'name', 'cmdline', 'create_time']):
                try:
                    info = proc.info
                    name = info['name']
                    
                    # Filter if requested
                    if filter_name:
                        if filter_name.lower() not in name.lower():
                            continue
                    
                    # Get command line
                    cmdline = info.get('cmdline')
                    if cmdline:
                        cmd = ' '.join(cmdline)
                    else:
                        cmd = name
                    
                    # Truncate long commands
                    if len(cmd) > 80:
                        cmd = cmd[:77] + "..."
                    
                    process_info = {
                        'pid': info['pid'],
                        'name': name,
                        'cmd': cmd,
                        'create_time': info['create_time'],
                    }
                    
                    if show_details:
                        process_info['cpu'] = proc.cpu_percent(interval=0.1)
                        process_info['memory'] = proc.memory_info().rss / 1024 / 1024  # MB
                    
                    processes.append(process_info)
                    
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            
            if not processes:
                return f"No processes found matching '{filter_name}'."
            
            # Sort by PID
            processes.sort(key=lambda x: x['pid'])
            
            # Build output
            output = []
            output.append("=== System Processes ===\n")
            
            # Header
            if show_details:
                output.append(f"{'PID':>7} {'CPU%':>5} {'MEM(MB)':>8} {'NAME':<20} COMMAND")
                output.append("-" * 80)
                
                for proc in processes:
                    output.append(
                        f"{proc['pid']:>7} "
                        f"{proc['cpu']:>5.1f} "
                        f"{proc['memory']:>8.1f} "
                        f"{proc['name']:<20} "
                        f"{proc['cmd']}"
                    )
            else:
                output.append(f"{'PID':>7} {'NAME':<20} COMMAND")
                output.append("-" * 80)
                
                for proc in processes:
                    output.append(
                        f"{proc['pid']:>7} "
                        f"{proc['name']:<20} "
                        f"{proc['cmd']}"
                    )
            
            output.append(f"\nTotal: {len(processes)} process(es)")
            
            return "\n".join(output)
            
        except Exception as e:
            return f"Error listing system processes: {str(e)}\nYou may need elevated permissions."

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass