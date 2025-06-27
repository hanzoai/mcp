"""NPX tool for both sync and background execution."""

from pathlib import Path
from typing import Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.shell.base_process import BaseBinaryTool
from mcp.server import FastMCP


class NpxTool(BaseBinaryTool):
    """Tool for running npx commands."""
    
    name = "npx"
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Run npx packages. Actions: run (default), background.

Usage:
npx create-react-app my-app
npx --action background http-server -p 8080
npx prettier --write "**/*.js"
npx --action background json-server db.json"""
    
    @override
    def get_binary_name(self) -> str:
        """Get the binary name."""
        return "npx"
    
    @override
    async def run(
        self,
        ctx: MCPContext,
        package: str,
        args: str = "",
        action: str = "run",
        cwd: Optional[str] = None,
        yes: bool = True,
    ) -> str:
        """Run an npx command.
        
        Args:
            ctx: MCP context
            package: NPX package to run
            args: Additional arguments
            action: Action to perform (run, background)
            cwd: Working directory
            yes: Auto-confirm package installation
            
        Returns:
            Command output or process info
        """
        # Prepare working directory
        work_dir = Path(cwd).resolve() if cwd else Path.cwd()
        
        # Prepare flags
        flags = []
        if yes:
            flags.append("-y")
        
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
                f"Started npx process in background\n"
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
                timeout=300  # 5 minute timeout for npx
            )

    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        tool_self = self
        
        @server.tool(name=self.name, description=self.description)
        async def npx(
            ctx: MCPContext,
            package: str,
            args: str = "",
            action: str = "run",
            cwd: Optional[str] = None,
            yes: bool = True,
        ) -> str:
            return await tool_self.run(
                ctx,
                package=package,
                args=args,
                action=action,
                cwd=cwd,
                yes=yes
            )
    
    async def call(self, ctx: MCPContext, **params) -> str:
        """Call the tool with arguments."""
        return await self.run(
            ctx,
            package=params["package"],
            args=params.get("args", ""),
            action=params.get("action", "run"),
            cwd=params.get("cwd"),
            yes=params.get("yes", True)
        )


# Create tool instance
npx_tool = NpxTool()