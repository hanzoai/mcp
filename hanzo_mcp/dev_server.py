"""Development server with hot reload for Hanzo AI."""

import asyncio
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional, Set

import watchdog.events
import watchdog.observers
from watchdog.events import FileSystemEventHandler

from hanzo_mcp.server import HanzoMCPServer


class MCPReloadHandler(FileSystemEventHandler):
    """Handler for file system events that triggers MCP server reload."""
    
    def __init__(self, restart_callback, ignore_patterns: Optional[Set[str]] = None):
        """Initialize the reload handler.
        
        Args:
            restart_callback: Function to call when files change
            ignore_patterns: Set of patterns to ignore
        """
        self.restart_callback = restart_callback
        self.ignore_patterns = ignore_patterns or {
            "__pycache__", ".pyc", ".pyo", ".git", ".pytest_cache",
            ".mypy_cache", ".ruff_cache", ".coverage", "*.log",
            ".env", ".venv", "venv", "node_modules"
        }
        self.last_reload = 0
        self.reload_delay = 0.5  # Debounce delay in seconds
    
    def should_ignore(self, path: str) -> bool:
        """Check if a path should be ignored."""
        path_obj = Path(path)
        
        # Check against ignore patterns
        for pattern in self.ignore_patterns:
            if pattern in str(path_obj):
                return True
            if path_obj.name.endswith(pattern):
                return True
        
        # Only watch Python files and config files
        if path_obj.is_file():
            allowed_extensions = {".py", ".json", ".yaml", ".yml", ".toml"}
            if path_obj.suffix not in allowed_extensions:
                return True
        
        return False
    
    def on_any_event(self, event):
        """Handle any file system event."""
        if event.is_directory:
            return
        
        if self.should_ignore(event.src_path):
            return
        
        # Debounce rapid changes
        current_time = time.time()
        if current_time - self.last_reload < self.reload_delay:
            return
        
        self.last_reload = current_time
        
        logger = logging.getLogger(__name__)
        logger.info(f"\n🔄 File changed: {event.src_path}")
        logger.info("🔄 Reloading MCP server...")
        
        self.restart_callback()


class DevServer:
    """Development server with hot reload capability."""
    
    def __init__(
        self,
        name: str = "hanzo-dev",
        allowed_paths: Optional[list[str]] = None,
        project_paths: Optional[list[str]] = None,
        project_dir: Optional[str] = None,
        **kwargs
    ):
        """Initialize the development server.
        
        Args:
            name: Server name
            allowed_paths: Allowed paths for the server
            project_paths: Project paths
            project_dir: Project directory
            **kwargs: Additional arguments for HanzoMCPServer
        """
        self.name = name
        self.allowed_paths = allowed_paths or []
        self.project_paths = project_paths
        self.project_dir = project_dir
        self.server_kwargs = kwargs
        self.server_process = None
        self.observer = None
        self.running = False
    
    def create_server(self) -> HanzoMCPServer:
        """Create a new MCP server instance."""
        return HanzoMCPServer(
            name=self.name,
            allowed_paths=self.allowed_paths,
            project_paths=self.project_paths,
            project_dir=self.project_dir,
            **self.server_kwargs
        )
    
    def start_file_watcher(self):
        """Start watching for file changes."""
        # Watch the hanzo_mcp package directory
        package_dir = Path(__file__).parent
        
        # Create observer and handler
        self.observer = watchdog.observers.Observer()
        handler = MCPReloadHandler(self.restart_server)
        
        # Watch the package directory
        self.observer.schedule(handler, str(package_dir), recursive=True)
        
        # Also watch any project directories
        if self.project_dir:
            self.observer.schedule(handler, self.project_dir, recursive=True)
        
        for path in self.allowed_paths:
            if Path(path).is_dir() and path not in [str(package_dir), self.project_dir]:
                self.observer.schedule(handler, path, recursive=True)
        
        self.observer.start()
        logger = logging.getLogger(__name__)
        logger.info(f"👀 Watching for changes in: {package_dir}")
        if self.project_dir:
            logger.info(f"👀 Also watching: {self.project_dir}")
    
    def stop_file_watcher(self):
        """Stop the file watcher."""
        if self.observer and self.observer.is_alive():
            self.observer.stop()
            self.observer.join(timeout=2)
    
    def restart_server(self):
        """Restart the MCP server."""
        # Since MCP servers run in the same process, we need to handle this differently
        # For now, we'll log a message indicating a restart is needed
        logger = logging.getLogger(__name__)
        logger.warning("\n⚠️  Server restart required. Please restart the MCP client to reload changes.")
        logger.info("💡 Tip: In development, consider using the MCP test client for easier reloading.")
    
    async def run_async(self, transport: str = "stdio"):
        """Run the development server asynchronously."""
        self.running = True
        
        logger = logging.getLogger(__name__)
        logger.info(f"\n🚀 Starting Hanzo AI in development mode...")
        logger.info(f"🔧 Hot reload enabled - watching for file changes")
        logger.info(f"📁 Project: {self.project_dir or 'current directory'}")
        logger.info(f"🌐 Transport: {transport}\n")
        
        # Start file watcher
        self.start_file_watcher()
        
        try:
            # Create and run server
            server = self.create_server()
            
            # Run the server (this will block)
            server.run(transport=transport)
            
        except KeyboardInterrupt:
            logger.info("\n\n🛑 Shutting down development server...")
        finally:
            self.running = False
            self.stop_file_watcher()
            logger.info("👋 Development server stopped")
    
    def run(self, transport: str = "stdio"):
        """Run the development server."""
        try:
            # Run the async version
            asyncio.run(self.run_async(transport))
        except KeyboardInterrupt:
            pass


def run_dev_server():
    """Entry point for development server."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Run Hanzo AI in development mode with hot reload")
    parser.add_argument(
        "--name",
        type=str,
        default="hanzo-dev",
        help="Name of the MCP server"
    )
    parser.add_argument(
        "--project-dir",
        type=str,
        help="Project directory to serve"
    )
    parser.add_argument(
        "--allowed-path",
        type=str,
        action="append",
        dest="allowed_paths",
        help="Additional allowed paths (can be specified multiple times)"
    )
    parser.add_argument(
        "--transport",
        type=str,
        default="stdio",
        choices=["stdio", "sse"],
        help="Transport type (default: stdio)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host for SSE transport"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=3000,
        help="Port for SSE transport"
    )
    
    args = parser.parse_args()
    
    # Create and run dev server
    dev_server = DevServer(
        name=args.name,
        allowed_paths=args.allowed_paths,
        project_dir=args.project_dir,
        host=args.host,
        port=args.port,
    )
    
    dev_server.run(transport=args.transport)


if __name__ == "__main__":
    run_dev_server()