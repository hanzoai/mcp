"""MCP server implementing Hanzo capabilities."""

import atexit
import signal
import threading
import time
from typing import Literal, cast, final

from fastmcp import FastMCP

from hanzo_mcp.prompts import register_all_prompts
from hanzo_mcp.tools import register_all_tools

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.shell.session_storage import SessionStorage


@final
class HanzoMCPServer:
    """MCP server implementing Hanzo capabilities."""

    def __init__(
        self,
        name: str = "hanzo",
        allowed_paths: list[str] | None = None,
        project_paths: list[str] | None = None,
        project_dir: str | None = None,
        mcp_instance: FastMCP | None = None,
        agent_model: str | None = None,
        agent_max_tokens: int | None = None,
        agent_api_key: str | None = None,
        agent_base_url: str | None = None,
        agent_max_iterations: int = 10,
        agent_max_tool_uses: int = 30,
        enable_agent_tool: bool = False,
        command_timeout: float = 120.0,
        disable_write_tools: bool = False,
        disable_search_tools: bool = False,
        host: str = "127.0.0.1",
        port: int = 3000,
        enabled_tools: dict[str, bool] | None = None,
        disabled_tools: list[str] | None = None,
    ):
        """Initialize the Hanzo MCP server.

        Args:
            name: The name of the server
            allowed_paths: list of paths that the server is allowed to access
            project_paths: list of project paths to generate prompts for
            project_dir: single project directory (added to allowed_paths and project_paths)
            mcp_instance: Optional FastMCP instance for testing
            agent_model: Optional model name for agent tool in LiteLLM format
            agent_max_tokens: Optional maximum tokens for agent responses
            agent_api_key: Optional API key for the LLM provider
            agent_base_url: Optional base URL for the LLM provider API endpoint
            agent_max_iterations: Maximum number of iterations for agent (default: 10)
            agent_max_tool_uses: Maximum number of total tool uses for agent (default: 30)
            enable_agent_tool: Whether to enable the agent tool (default: False)
            command_timeout: Default timeout for command execution in seconds (default: 120.0)
            disable_write_tools: Whether to disable write tools (default: False)
            disable_search_tools: Whether to disable search tools (default: False)
            host: Host for SSE server (default: 127.0.0.1)
            port: Port for SSE server (default: 3000)
            enabled_tools: Dictionary of individual tool enable states (default: None)
            disabled_tools: List of tool names to disable (default: None)
        """
        self.mcp = mcp_instance if mcp_instance is not None else FastMCP(name)

        # Initialize permissions and command executor
        self.permission_manager = PermissionManager()

        # Handle project_dir parameter
        if project_dir:
            if allowed_paths is None:
                allowed_paths = []
            if project_dir not in allowed_paths:
                allowed_paths.append(project_dir)
            if project_paths is None:
                project_paths = []
            if project_dir not in project_paths:
                project_paths.append(project_dir)

        # Add allowed paths
        if allowed_paths:
            for path in allowed_paths:
                self.permission_manager.add_allowed_path(path)

        # Store paths and options
        self.project_paths = project_paths
        self.project_dir = project_dir
        self.disable_write_tools = disable_write_tools
        self.disable_search_tools = disable_search_tools
        self.host = host
        self.port = port
        self.enabled_tools = enabled_tools or {}
        self.disabled_tools = disabled_tools or []

        # Store agent options
        self.agent_model = agent_model
        self.agent_max_tokens = agent_max_tokens
        self.agent_api_key = agent_api_key
        self.agent_base_url = agent_base_url
        self.agent_max_iterations = agent_max_iterations
        self.agent_max_tool_uses = agent_max_tool_uses
        self.enable_agent_tool = enable_agent_tool
        self.command_timeout = command_timeout

        # Initialize cleanup tracking
        self._cleanup_thread: threading.Thread | None = None
        self._shutdown_event = threading.Event()
        self._cleanup_registered = False

        # Apply disabled_tools to enabled_tools
        final_enabled_tools = self.enabled_tools.copy()
        for tool_name in self.disabled_tools:
            final_enabled_tools[tool_name] = False
        
        # Store the final processed tool configuration
        self.enabled_tools = final_enabled_tools

        # Register all tools
        register_all_tools(
            mcp_server=self.mcp,
            permission_manager=self.permission_manager,
            agent_model=self.agent_model,
            agent_max_tokens=self.agent_max_tokens,
            agent_api_key=self.agent_api_key,
            agent_base_url=self.agent_base_url,
            agent_max_iterations=self.agent_max_iterations,
            agent_max_tool_uses=self.agent_max_tool_uses,
            enable_agent_tool=self.enable_agent_tool,
            disable_write_tools=self.disable_write_tools,
            disable_search_tools=self.disable_search_tools,
            enabled_tools=final_enabled_tools,
        )

        register_all_prompts(mcp_server=self.mcp, projects=self.project_paths)

    def _setup_cleanup_handlers(self) -> None:
        """Set up signal handlers and background cleanup thread."""
        if self._cleanup_registered:
            return

        # Register cleanup on normal exit
        atexit.register(self._cleanup_sessions)

        # Register signal handlers for graceful shutdown
        def signal_handler(signum, frame):
            self._cleanup_sessions()
            self._shutdown_event.set()

        signal.signal(signal.SIGTERM, signal_handler)
        signal.signal(signal.SIGINT, signal_handler)

        # Start background cleanup thread for periodic cleanup
        self._cleanup_thread = threading.Thread(
            target=self._background_cleanup, daemon=True
        )
        self._cleanup_thread.start()

        self._cleanup_registered = True

    def _background_cleanup(self) -> None:
        """Background thread for periodic session cleanup."""
        while not self._shutdown_event.is_set():
            try:
                # Clean up expired sessions every 2 minutes
                # Using shorter TTL of 5 minutes (300 seconds)
                SessionStorage.cleanup_expired_sessions(max_age_seconds=300)

                # Wait for 2 minutes or until shutdown
                self._shutdown_event.wait(timeout=120)
            except Exception:
                # Ignore cleanup errors and continue
                pass

    def _cleanup_sessions(self) -> None:
        """Clean up all active sessions."""
        try:
            cleared_count = SessionStorage.clear_all_sessions()
            if cleared_count > 0:
                print(f"Cleaned up {cleared_count} tmux sessions on shutdown")
        except Exception:
            # Ignore cleanup errors during shutdown
            pass

    def run(self, transport: str = "stdio", allowed_paths: list[str] | None = None):
        """Run the MCP server.

        Args:
            transport: The transport to use (stdio or sse)
            allowed_paths: list of paths that the server is allowed to access
        """
        # Add allowed paths if provided
        allowed_paths_list = allowed_paths or []
        for path in allowed_paths_list:
            self.permission_manager.add_allowed_path(path)

        # Set up cleanup handlers before running
        self._setup_cleanup_handlers()

        # Run the server
        transport_type = cast(Literal["stdio", "sse"], transport)
        self.mcp.run(transport=transport_type)
