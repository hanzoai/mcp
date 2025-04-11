"""MCP server implementing Hanzo capabilities."""

from typing import Literal, cast, final

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools import register_all_tools
from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.path_utils import PathUtils
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.project.analysis import ProjectAnalyzer, ProjectManager
from hanzo_mcp.tools.shell.command_executor import CommandExecutor


@final
class HanzoServer:
    """MCP server implementing Hanzo capabilities."""

    def __init__(
        self,
        name: str = "claude-code",
        allowed_paths: list[str] | None = None,
        project_dir: str | None = None,
        mcp_instance: FastMCP | None = None,
        agent_model: str | None = None,
        agent_max_tokens: int | None = None,
        agent_api_key: str | None = None,
        agent_max_iterations: int = 10,
        agent_max_tool_uses: int = 30,
        enable_agent_tool: bool = False,
    ):
        """Initialize the Hanzo server.

        Args:
            name: The name of the server
            allowed_paths: list of paths that the server is allowed to access
            project_dir: Optional project directory to use as initial working directory
            mcp_instance: Optional FastMCP instance for testing
            agent_model: Optional model name for agent tool in LiteLLM format
            agent_max_tokens: Optional maximum tokens for agent responses
            agent_api_key: Optional API key for the LLM provider
            agent_max_iterations: Maximum number of iterations for agent (default: 10)
            agent_max_tool_uses: Maximum number of total tool uses for agent (default: 30)
            enable_agent_tool: Whether to enable the agent tool (default: False)
        """
        self.mcp = mcp_instance if mcp_instance is not None else FastMCP(name)

        # Initialize context, permissions, and command executor
        self.document_context = DocumentContext()
        self.permission_manager = PermissionManager()

        # Initialize command executor
        self.command_executor = CommandExecutor(
            permission_manager=self.permission_manager,
            verbose=False,  # Set to True for debugging
        )
        
        # If project_dir is specified, set it as initial working directory for all sessions
        if project_dir:
            initial_session_id = name  # Use server name as default session ID
            self.command_executor.set_working_dir(initial_session_id, project_dir)

        # Initialize project analyzer
        self.project_analyzer = ProjectAnalyzer(self.command_executor)

        # Initialize project manager
        self.project_manager = ProjectManager(
            self.document_context, self.permission_manager, self.project_analyzer
        )

        # Add allowed paths
        if allowed_paths:
            for path in allowed_paths:
                # Path should already be normalized from CLI, but normalize here for safety
                normalized_path = PathUtils.normalize_path(path)
                self.permission_manager.add_allowed_path(normalized_path)
                self.document_context.add_allowed_path(normalized_path)

        # Store agent options
        self.agent_model = agent_model
        self.agent_max_tokens = agent_max_tokens
        self.agent_api_key = agent_api_key
        self.agent_max_iterations = agent_max_iterations
        self.agent_max_tool_uses = agent_max_tool_uses
        self.enable_agent_tool = enable_agent_tool
        
        # Register all tools
        register_all_tools(
            mcp_server=self.mcp,
            document_context=self.document_context,
            permission_manager=self.permission_manager,
            agent_model=self.agent_model,
            agent_max_tokens=self.agent_max_tokens,
            agent_api_key=self.agent_api_key,
            agent_max_iterations=self.agent_max_iterations,
            agent_max_tool_uses=self.agent_max_tool_uses,
            enable_agent_tool=self.enable_agent_tool,
        )

    def run(self, transport: str = "stdio", allowed_paths: list[str] | None = None):
        """Run the MCP server.

        Args:
            transport: The transport to use (stdio or sse)
            allowed_paths: list of paths that the server is allowed to access
        """
        # Add allowed paths if provided
        allowed_paths_list = allowed_paths or []
        for path in allowed_paths_list:
            # Normalize path before adding
            normalized_path = PathUtils.normalize_path(path)
            self.permission_manager.add_allowed_path(normalized_path)
            self.document_context.add_allowed_path(normalized_path)

        # Run the server
        transport_type = cast(Literal["stdio", "sse"], transport)
        self.mcp.run(transport=transport_type)


def main():
    """Run the Hanzo MCP server."""
    import argparse

    parser = argparse.ArgumentParser(
        description="MCP server implementing Hanzo capabilities"
    )

    _ = parser.add_argument(
        "--name",
        default="claude-code",
        help="Name of the MCP server (default: claude-code)",
    )

    _ = parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)",
    )

    _ = parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)",
    )

    args = parser.parse_args()

    # Type annotations for args to avoid Any warnings
    name: str = args.name
    transport: str = args.transport
    allowed_paths: list[str] | None = args.allowed_paths

    # Create and run the server
    server = HanzoServer(name=name, allowed_paths=allowed_paths)
    server.run(transport=transport, allowed_paths=allowed_paths or [])


if __name__ == "__main__":
    main()
