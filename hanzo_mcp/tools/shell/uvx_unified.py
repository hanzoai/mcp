"""UVX tool for both sync and background execution."""

from pathlib import Path
from typing import Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.shell.base_process import BaseBinaryTool
from mcp.server import FastMCP


class UvxTool(BaseBinaryTool):
    """Tool for running uvx commands."""
    
    name = "uvx"
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run Python packages with uvx. Actions: run (default), background.

Usage:
uvx ruff check .
uvx --action background mkdocs serve
uvx black --check src/
uvx --action background jupyter lab --port 8888"""
    
    @override
    def get_binary_name(self) -> str:
        """Get the binary name."""
        return "uvx"
    
    @override
    async def run(
        self,
        ctx: MCPContext,
        package: str,
        args: str = "",
        action: str = "run",
        cwd: Optional[str] = None,
        python: Optional[str] = None,
    ) -> str:
        """Run a uvx command.
        
        Args:
            ctx: MCP context
            package: Python package to run
            args: Additional arguments
            action: Action to perform (run, background)
            cwd: Working directory
            python: Python version constraint
            
        Returns:
            Command output or process info
        """
        # Prepare working directory
        work_dir = Path(cwd).resolve() if cwd else Path.cwd()
        
        # Prepare flags
        flags = []
        if python:
            flags.extend(["--python", python])
        
        # Build full command
        full_args = args.split() if args else []
        
        if action == "background":
            result = await self.execute_background(
                package,
                cwd=work_dir,
                flags=flags,
                args=full_args
            )
            return (
                f"Started uvx process in background\n"
                f"Process ID: {result['process_id']}\n"
                f"PID: {result['pid']}\n"
                f"Log file: {result['log_file']}"
            )
        else:
            # Default to sync execution
            return await self.execute_sync(
                package,
                cwd=work_dir,
                flags=flags,
                args=full_args,
                timeout=300  # 5 minute timeout for uvx
            )

    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        tool_self = self
        
        @server.tool(name=self.name, description=self.description)
        async def uvx(
            ctx: MCPContext,
            package: str,
            args: str = "",
            action: str = "run",
            cwd: Optional[str] = None,
            python: Optional[str] = None,
        ) -> str:
            return await tool_self.run(
                ctx,
                package=package,
                args=args,
                action=action,
                cwd=cwd,
                python=python
            )
    
    async def call(self, ctx: MCPContext, **params) -> str:
        """Call the tool with arguments."""
        return await self.run(
            ctx,
            package=params["package"],
            args=params.get("args", ""),
            action=params.get("action", "run"),
            cwd=params.get("cwd"),
            python=params.get("python")
        )


# Create tool instance
uvx_tool = UvxTool()