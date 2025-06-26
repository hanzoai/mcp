"""Tool for viewing process logs."""

import os
from pathlib import Path
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
        description="Process ID from run_background",
        default=None,
    ),
]

LogFile = Annotated[
    Optional[str],
    Field(
        description="Path to specific log file",
        default=None,
    ),
]

Lines = Annotated[
    int,
    Field(
        description="Number of lines to show (default: 50, -1 for all)",
        default=50,
    ),
]

Follow = Annotated[
    bool,
    Field(
        description="Follow log output (tail -f)",
        default=False,
    ),
]

ListLogs = Annotated[
    bool,
    Field(
        description="List all available log files",
        default=False,
    ),
]


class LogsParams(TypedDict, total=False):
    """Parameters for viewing logs."""

    id: Optional[str]
    file: Optional[str]
    lines: int
    follow: bool
    list: bool


@final
class LogsTool(BaseTool):
    """Tool for viewing process logs."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the logs tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager
        self.log_dir = Path.home() / ".hanzo" / "logs"

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "logs"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """View logs from background processes.

Options:
- id: Process ID to view logs for
- file: Specific log file path
- lines: Number of lines to show (default: 50, -1 for all)
- list: List all available log files

Examples:
- logs --id abc123              # View logs for specific process
- logs --id abc123 --lines 100  # View last 100 lines
- logs --id abc123 --lines -1   # View entire log
- logs --list                   # List all log files
- logs --file /path/to/log      # View specific log file

Note: Follow mode (--follow) is not supported in MCP context.
Use run_command with 'tail -f' for continuous monitoring.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[LogsParams],
    ) -> str:
        """View process logs.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Log content or list of logs
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        process_id = params.get("id")
        log_file = params.get("file")
        lines = params.get("lines", 50)
        follow = params.get("follow", False)
        list_logs = params.get("list", False)

        try:
            # List available logs
            if list_logs:
                return await self._list_logs(tool_ctx)

            # Determine log file to read
            if process_id:
                # Find log file for process ID
                process = RunBackgroundTool.get_process(process_id)
                if not process:
                    return f"Process with ID '{process_id}' not found."
                
                if not process.log_file:
                    return f"Process '{process_id}' does not have logging enabled."
                
                log_path = process.log_file
                
            elif log_file:
                # Use specified log file
                log_path = Path(log_file)
                
                # Check if it's in the logs directory
                if not log_path.is_absolute():
                    log_path = self.log_dir / log_path
                
            else:
                return "Error: Must specify --id or --file"

            # Check permissions
            if not self.permission_manager.has_permission(str(log_path)):
                return f"Permission denied: {log_path}"

            # Check if file exists
            if not log_path.exists():
                return f"Log file not found: {log_path}"

            # Note about follow mode
            if follow:
                await tool_ctx.warning("Follow mode not supported in MCP. Showing latest lines instead.")

            # Read log file
            await tool_ctx.info(f"Reading log file: {log_path}")
            
            try:
                with open(log_path, 'r') as f:
                    if lines == -1:
                        # Read entire file
                        content = f.read()
                    else:
                        # Read last N lines
                        all_lines = f.readlines()
                        if len(all_lines) <= lines:
                            content = ''.join(all_lines)
                        else:
                            content = ''.join(all_lines[-lines:])
                
                if not content:
                    return f"Log file is empty: {log_path}"
                
                # Add header
                header = f"=== Log: {log_path.name} ===\n"
                if process_id:
                    process = RunBackgroundTool.get_process(process_id)
                    if process:
                        header += f"Process: {process.name} (ID: {process_id})\n"
                        header += f"Command: {process.command}\n"
                        status = "running" if process.is_running else f"finished (code: {process.return_code})"
                        header += f"Status: {status}\n"
                header += f"{'=' * 50}\n"
                
                return header + content
                
            except Exception as e:
                return f"Error reading log file: {str(e)}"

        except Exception as e:
            await tool_ctx.error(f"Failed to view logs: {str(e)}")
            return f"Error viewing logs: {str(e)}"

    async def _list_logs(self, tool_ctx) -> str:
        """List all available log files."""
        await tool_ctx.info("Listing available log files")
        
        if not self.log_dir.exists():
            return "No logs directory found."
        
        # Get all log files
        log_files = list(self.log_dir.glob("*.log"))
        
        if not log_files:
            return "No log files found."
        
        # Sort by modification time (newest first)
        log_files.sort(key=lambda x: x.stat().st_mtime, reverse=True)
        
        # Check which logs belong to active processes
        active_processes = RunBackgroundTool.get_processes()
        active_log_files = {str(p.log_file): (pid, p) for pid, p in active_processes.items() if p.log_file}
        
        # Build output
        output = []
        output.append("=== Available Log Files ===\n")
        
        for log_file in log_files[:50]:  # Limit to 50 most recent
            size = log_file.stat().st_size
            size_str = self._format_size(size)
            
            # Check if this belongs to an active process
            if str(log_file) in active_log_files:
                pid, process = active_log_files[str(log_file)]
                status = "active" if process.is_running else "finished"
                output.append(f"{log_file.name:<50} {size_str:>10} [{status}] (ID: {pid})")
            else:
                output.append(f"{log_file.name:<50} {size_str:>10}")
        
        output.append(f"\nTotal: {len(log_files)} log file(s)")
        output.append("\nUse 'logs --file <filename>' to view a specific log")
        output.append("Use 'logs --id <process-id>' to view logs for a running process")
        
        return "\n".join(output)

    def _format_size(self, size: int) -> str:
        """Format file size in human-readable format."""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024.0:
                return f"{size:.1f} {unit}"
            size /= 1024.0
        return f"{size:.1f} TB"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass