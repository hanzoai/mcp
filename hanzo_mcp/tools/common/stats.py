"""Comprehensive system and MCP statistics."""

import os
import psutil
import shutil
from typing import TypedDict, Unpack, final, override
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.shell.run_background import RunBackgroundTool
from hanzo_mcp.tools.mcp.mcp_add import McpAddTool
from hanzo_mcp.tools.database.database_manager import DatabaseManager


class StatsParams(TypedDict, total=False):
    """Parameters for stats tool."""
    pass


@final
class StatsTool(BaseTool):
    """Tool for showing comprehensive system and MCP statistics."""

    def __init__(self, db_manager: DatabaseManager = None):
        """Initialize the stats tool.
        
        Args:
            db_manager: Optional database manager for DB stats
        """
        self.db_manager = db_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "stats"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Show comprehensive system and Hanzo AI statistics.

Displays:
- System resources (CPU, memory, disk)
- Running processes
- Database usage
- MCP server status
- Tool usage statistics
- Warnings for high resource usage

Example:
- stats
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[StatsParams],
    ) -> str:
        """Get comprehensive statistics.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Comprehensive statistics
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        output = []
        warnings = []
        
        # Header
        output.append("=== Hanzo AI System Statistics ===")
        output.append(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        output.append("")
        
        # System Resources
        output.append("=== System Resources ===")
        
        # CPU
        cpu_percent = psutil.cpu_percent(interval=1)
        cpu_count = psutil.cpu_count()
        output.append(f"CPU Usage: {cpu_percent}% ({cpu_count} cores)")
        if cpu_percent > 90:
            warnings.append(f"⚠️  HIGH CPU USAGE: {cpu_percent}%")
        
        # Memory
        memory = psutil.virtual_memory()
        memory_used_gb = memory.used / (1024**3)
        memory_total_gb = memory.total / (1024**3)
        memory_percent = memory.percent
        output.append(f"Memory: {memory_used_gb:.1f}/{memory_total_gb:.1f} GB ({memory_percent}%)")
        if memory_percent > 90:
            warnings.append(f"⚠️  HIGH MEMORY USAGE: {memory_percent}%")
        
        # Disk
        disk = psutil.disk_usage('/')
        disk_used_gb = disk.used / (1024**3)
        disk_total_gb = disk.total / (1024**3)
        disk_percent = disk.percent
        disk_free_gb = disk.free / (1024**3)
        output.append(f"Disk: {disk_used_gb:.1f}/{disk_total_gb:.1f} GB ({disk_percent}%)")
        output.append(f"Free Space: {disk_free_gb:.1f} GB")
        if disk_percent > 90:
            warnings.append(f"⚠️  LOW DISK SPACE: Only {disk_free_gb:.1f} GB free ({100-disk_percent:.1f}% remaining)")
        
        output.append("")
        
        # Background Processes
        output.append("=== Background Processes ===")
        processes = RunBackgroundTool.get_processes()
        running_count = 0
        total_memory_mb = 0
        
        if processes:
            for proc in processes.values():
                if proc.is_running():
                    running_count += 1
                    try:
                        ps_proc = psutil.Process(proc.process.pid)
                        memory_mb = ps_proc.memory_info().rss / (1024**2)
                        total_memory_mb += memory_mb
                    except:
                        pass
            
            output.append(f"Running Processes: {running_count}")
            output.append(f"Total Memory Usage: {total_memory_mb:.1f} MB")
            
            # List top processes by memory
            if running_count > 0:
                output.append("\nTop Processes:")
                proc_list = []
                for proc_id, proc in processes.items():
                    if proc.is_running():
                        try:
                            ps_proc = psutil.Process(proc.process.pid)
                            memory_mb = ps_proc.memory_info().rss / (1024**2)
                            cpu = ps_proc.cpu_percent(interval=0.1)
                            proc_list.append((proc.name, memory_mb, cpu, proc_id))
                        except:
                            proc_list.append((proc.name, 0, 0, proc_id))
                
                proc_list.sort(key=lambda x: x[1], reverse=True)
                for name, mem, cpu, pid in proc_list[:5]:
                    output.append(f"  - {name} ({pid}): {mem:.1f} MB, {cpu:.1f}% CPU")
        else:
            output.append("No background processes running")
        
        output.append("")
        
        # Database Usage
        if self.db_manager:
            output.append("=== Database Usage ===")
            db_dir = Path.home() / ".hanzo" / "db"
            total_db_size = 0
            
            if db_dir.exists():
                for db_file in db_dir.rglob("*.db"):
                    size = db_file.stat().st_size
                    total_db_size += size
                
                output.append(f"Total Database Size: {total_db_size / (1024**2):.1f} MB")
                output.append(f"Active Projects: {len(self.db_manager.projects)}")
                
                # List largest databases
                db_sizes = []
                for db_file in db_dir.rglob("*.db"):
                    size = db_file.stat().st_size / (1024**2)
                    if size > 0.1:  # Only show DBs > 100KB
                        project = db_file.parent.parent.name
                        db_type = db_file.stem
                        db_sizes.append((project, db_type, size))
                
                if db_sizes:
                    db_sizes.sort(key=lambda x: x[2], reverse=True)
                    output.append("\nLargest Databases:")
                    for project, db_type, size in db_sizes[:5]:
                        output.append(f"  - {project}/{db_type}: {size:.1f} MB")
            else:
                output.append("No databases found")
        
        output.append("")
        
        # MCP Servers
        output.append("=== MCP Servers ===")
        mcp_servers = McpAddTool.get_servers()
        if mcp_servers:
            running_mcp = sum(1 for s in mcp_servers.values() if s.get("status") == "running")
            total_mcp_tools = sum(len(s.get("tools", [])) for s in mcp_servers.values())
            
            output.append(f"Total Servers: {len(mcp_servers)}")
            output.append(f"Running: {running_mcp}")
            output.append(f"Total Tools Available: {total_mcp_tools}")
        else:
            output.append("No MCP servers configured")
        
        output.append("")
        
        # Hanzo AI Specifics
        output.append("=== Hanzo AI ===")
        
        # Log directory size
        log_dir = Path.home() / ".hanzo" / "logs"
        if log_dir.exists():
            log_size = sum(f.stat().st_size for f in log_dir.rglob("*") if f.is_file())
            log_count = len(list(log_dir.rglob("*.log")))
            output.append(f"Log Files: {log_count} ({log_size / (1024**2):.1f} MB)")
            
            if log_size > 100 * 1024**2:  # > 100MB
                warnings.append(f"⚠️  Large log directory: {log_size / (1024**2):.1f} MB")
        
        # Config directory
        config_dir = Path.home() / ".hanzo" / "mcp"
        if config_dir.exists():
            config_count = len(list(config_dir.rglob("*.json")))
            output.append(f"Config Files: {config_count}")
        
        # Tool status (if available)
        # TODO: Track tool usage statistics
        output.append("\nTool Categories:")
        output.append("  - File Operations: grep, find_files, read, write, edit")
        output.append("  - Shell: bash, run_background, processes, pkill")
        output.append("  - Database: sql_query, graph_query, vector_search")
        output.append("  - Package Runners: uvx, npx, uvx_background, npx_background")
        output.append("  - MCP Management: mcp_add, mcp_remove, mcp_stats")
        
        # Warnings Section
        if warnings:
            output.append("\n=== ⚠️  WARNINGS ===")
            for warning in warnings:
                output.append(warning)
            output.append("")
        
        # Recommendations
        output.append("=== Recommendations ===")
        if disk_free_gb < 5:
            output.append("- Free up disk space (< 5GB remaining)")
        if memory_percent > 80:
            output.append("- Close unused applications to free memory")
        if running_count > 10:
            output.append("- Consider stopping unused background processes")
        if log_size > 50 * 1024**2:
            output.append("- Clean up old log files in ~/.hanzo/logs")
        
        if not any([disk_free_gb < 5, memory_percent > 80, running_count > 10, log_size > 50 * 1024**2]):
            output.append("✅ System resources are healthy")
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
