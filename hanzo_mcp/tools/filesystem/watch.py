"""Watch files for changes."""

import asyncio
import os
from pathlib import Path
from typing import override
import time
from datetime import datetime

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from mcp.server import FastMCP


class WatchTool(BaseTool):
    """Tool for watching files for changes."""

    name = "watch"
    
    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        
        @server.tool(name=self.name, description=self.description)
        async def watch_handler(
            ctx: MCPContext,
            path: str,
            pattern: str = "*",
            interval: int = 1,
            recursive: bool = True,
            exclude: str = "",
            duration: int = 30
        ) -> str:
            """Handle watch tool calls."""
            return await self.run(
                ctx,
                path=path,
                pattern=pattern,
                interval=interval,
                recursive=recursive,
                exclude=exclude,
                duration=duration,
            )
    
    async def call(self, ctx: MCPContext, **params) -> str:
        """Call the tool with arguments."""
        return await self.run(
            ctx,
            path=params["path"],
            pattern=params.get("pattern", "*"),
            interval=params.get("interval", 1),
            recursive=params.get("recursive", True),
            exclude=params.get("exclude", ""),
            duration=params.get("duration", 30)
        )

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Watch files for changes. Reports modifications.

Usage:
watch ./src --pattern "*.py" --interval 2
watch config.json
watch . --recursive --exclude "__pycache__"
"""

    @override
    async def run(
        self, 
        ctx: MCPContext, 
        path: str,
        pattern: str = "*",
        interval: int = 1,
        recursive: bool = True,
        exclude: str = "",
        duration: int = 30,
    ) -> str:
        """Watch files for changes.
        
        Args:
            ctx: MCP context
            path: Path to watch (file or directory)
            pattern: Glob pattern for files to watch (default: "*")
            interval: Check interval in seconds (default: 1)
            recursive: Watch subdirectories (default: True)
            exclude: Patterns to exclude (comma-separated)
            duration: Max watch duration in seconds (default: 30)
            
        Returns:
            Report of file changes
        """
        watch_path = Path(path).expanduser().resolve()
        
        if not watch_path.exists():
            raise ValueError(f"Path does not exist: {watch_path}")
        
        # Parse exclude patterns
        exclude_patterns = [p.strip() for p in exclude.split(",") if p.strip()]
        
        # Track file states
        file_states = {}
        changes = []
        start_time = time.time()
        
        def should_exclude(file_path: Path) -> bool:
            """Check if file should be excluded."""
            for pattern in exclude_patterns:
                if pattern in str(file_path):
                    return True
                if file_path.match(pattern):
                    return True
            return False
        
        def get_files() -> dict[Path, float]:
            """Get all matching files with their modification times."""
            files = {}
            
            if watch_path.is_file():
                # Watching a single file
                if not should_exclude(watch_path):
                    try:
                        files[watch_path] = watch_path.stat().st_mtime
                    except:
                        pass
            else:
                # Watching a directory
                if recursive:
                    paths = watch_path.rglob(pattern)
                else:
                    paths = watch_path.glob(pattern)
                
                for file_path in paths:
                    if file_path.is_file() and not should_exclude(file_path):
                        try:
                            files[file_path] = file_path.stat().st_mtime
                        except:
                            pass
            
            return files
        
        # Initial scan
        file_states = get_files()
        initial_count = len(file_states)
        
        output = [f"Watching {watch_path} (pattern: {pattern})"]
        output.append(f"Found {initial_count} files to monitor")
        if exclude_patterns:
            output.append(f"Excluding: {', '.join(exclude_patterns)}")
        output.append(f"Monitoring for {duration} seconds...\n")
        
        # Monitor for changes
        try:
            while (time.time() - start_time) < duration:
                await asyncio.sleep(interval)
                
                current_files = get_files()
                
                # Check for new files
                for file_path, mtime in current_files.items():
                    if file_path not in file_states:
                        timestamp = datetime.now().strftime("%H:%M:%S")
                        change = f"[{timestamp}] CREATED: {file_path.relative_to(watch_path.parent)}"
                        changes.append(change)
                        output.append(change)
                
                # Check for deleted files
                for file_path in list(file_states.keys()):
                    if file_path not in current_files:
                        timestamp = datetime.now().strftime("%H:%M:%S")
                        change = f"[{timestamp}] DELETED: {file_path.relative_to(watch_path.parent)}"
                        changes.append(change)
                        output.append(change)
                        del file_states[file_path]
                
                # Check for modified files
                for file_path, mtime in current_files.items():
                    if file_path in file_states and mtime != file_states[file_path]:
                        timestamp = datetime.now().strftime("%H:%M:%S")
                        change = f"[{timestamp}] MODIFIED: {file_path.relative_to(watch_path.parent)}"
                        changes.append(change)
                        output.append(change)
                        file_states[file_path] = mtime
                
                # Update file states for new files
                for file_path, mtime in current_files.items():
                    if file_path not in file_states:
                        file_states[file_path] = mtime
                
        except asyncio.CancelledError:
            output.append("\nWatch cancelled")
        
        # Summary
        output.append(f"\nWatch completed after {int(time.time() - start_time)} seconds")
        output.append(f"Total changes detected: {len(changes)}")
        
        return "\n".join(output)


# Create tool instance
watch_tool = WatchTool()