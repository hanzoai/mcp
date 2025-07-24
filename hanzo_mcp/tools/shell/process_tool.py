"""Process management tool."""

import signal
from typing import Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.shell.base_process import ProcessManager
from mcp.server import FastMCP


class ProcessTool(BaseTool):
    """Tool for process management."""
    
    name = "process"
    
    def __init__(self):
        """Initialize the process tool."""
        super().__init__()
        self.process_manager = ProcessManager()
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Manage background processes. Actions: list (default), kill, logs.

Usage:
process
process --action list
process --action kill --id npx_abc123
process --action logs --id uvx_def456
process --action logs --id bash_ghi789 --lines 50"""
    
    @override
    async def run(
        self,
        ctx: MCPContext,
        action: str = "list",
        id: Optional[str] = None,
        signal_type: str = "TERM",
        lines: int = 100,
    ) -> str:
        """Manage background processes.
        
        Args:
            ctx: MCP context
            action: Action to perform (list, kill, logs)
            id: Process ID (for kill/logs actions)
            signal_type: Signal type for kill (TERM, KILL, INT)
            lines: Number of log lines to show
            
        Returns:
            Action result
        """
        if action == "list":
            processes = self.process_manager.list_processes()
            if not processes:
                return "No background processes running"
            
            output = ["Background processes:"]
            for proc_id, info in processes.items():
                status = "running" if info["running"] else f"stopped (exit code: {info.get('return_code', 'unknown')})"
                output.append(f"- {proc_id}: PID {info['pid']} - {status}")
                if info.get("log_file"):
                    output.append(f"  Log: {info['log_file']}")
            
            return "\n".join(output)
        
        elif action == "kill":
            if not id:
                return "Error: Process ID required for kill action"
            
            process = self.process_manager.get_process(id)
            if not process:
                return f"Process {id} not found"
            
            # Map signal names to signal numbers
            signal_map = {
                "TERM": signal.SIGTERM,
                "KILL": signal.SIGKILL,
                "INT": signal.SIGINT,
            }
            
            sig = signal_map.get(signal_type.upper(), signal.SIGTERM)
            
            try:
                process.send_signal(sig)
                return f"Sent {signal_type} signal to process {id} (PID: {process.pid})"
            except Exception as e:
                return f"Failed to kill process {id}: {e}"
        
        elif action == "logs":
            if not id:
                return "Error: Process ID required for logs action"
            
            log_file = self.process_manager.get_log_file(id)
            if not log_file or not log_file.exists():
                return f"No log file found for process {id}"
            
            try:
                with open(log_file, "r") as f:
                    log_lines = f.readlines()
                
                # Get last N lines
                if len(log_lines) > lines:
                    log_lines = log_lines[-lines:]
                
                output = [f"Logs for process {id} (last {lines} lines):"]
                output.append("-" * 50)
                output.extend(line.rstrip() for line in log_lines)
                
                return "\n".join(output)
            except Exception as e:
                return f"Error reading logs: {e}"
        
        else:
            return f"Unknown action: {action}. Use 'list', 'kill', or 'logs'"

    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        tool_self = self
        
        @server.tool(name=self.name, description=self.description)
        async def process(
            ctx: MCPContext,
            action: str = "list",
            id: Optional[str] = None,
            signal_type: str = "TERM",
            lines: int = 100
        ) -> str:
            return await tool_self.run(
                ctx,
                action=action,
                id=id,
                signal_type=signal_type,
                lines=lines
            )
    
    async def call(self, ctx: MCPContext, **params) -> str:
        """Call the tool with arguments."""
        return await self.run(
            ctx,
            action=params.get("action", "list"),
            id=params.get("id"),
            signal_type=params.get("signal_type", "TERM"),
            lines=params.get("lines", 100)
        )


# Create tool instance
process_tool = ProcessTool()