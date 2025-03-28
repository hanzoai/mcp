"""MCP server for accessing Hanzo APIs and Platform capabilities."""

from typing import Literal, cast, final

import os

from mcp.server.fastmcp import FastMCP

from hanzo_mcp.tools import register_all_tools
from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.project.analysis import ProjectAnalyzer, ProjectManager
from hanzo_mcp.tools.shell.command_executor import CommandExecutor
# Conditional import for vector store manager
try:
    from hanzo_mcp.tools.vector.store_manager import VectorStoreManager
    has_vector_store = True
except ImportError:
    has_vector_store = False
    VectorStoreManager = None
from hanzo_mcp.tools.dev_tool import DevTool
from hanzo_mcp.tools.mcp_orchestrator import MCPOrchestrator
from hanzo_mcp.tools.llm_file_manager import LLMFileManager
from hanzo_mcp.external.proxy_tools import ProxyTools


@final
class HanzoMCPServer:
    """MCP server for accessing Hanzo APIs and Platform capabilities."""

    def __init__(
        self,
        name: str = "hanzo",
        allowed_paths: list[str] | None = None,
        mcp_instance: FastMCP | None = None,
        enable_external_servers: bool = True,
    ):
        """Initialize the Hanzo server.

        Args:
            name: The name of the server
            allowed_paths: list of paths that the server is allowed to access
            mcp_instance: Optional FastMCP instance for testing
            enable_external_servers: Whether to enable external MCP servers
        """
        self.mcp = mcp_instance if mcp_instance is not None else FastMCP(name)

        # Initialize context, permissions, and command executor
        self.document_context = DocumentContext()
        self.permission_manager = PermissionManager()
        
        # Initialize LLM.md file manager
        self.llm_file_manager = LLMFileManager(self.permission_manager)

        # Initialize command executor
        self.command_executor = CommandExecutor(
            permission_manager=self.permission_manager,
            verbose=False,  # Set to True for debugging
        )

        # Initialize project analyzer
        self.project_analyzer = ProjectAnalyzer(self.command_executor)

        # Initialize project manager
        self.project_manager = ProjectManager(
            self.document_context, self.permission_manager, self.project_analyzer
        )
        
        # Initialize vector store manager if available
        if has_vector_store:
            self.vector_store_manager = VectorStoreManager(
                self.document_context, self.permission_manager
            )
        else:
            self.vector_store_manager = None

        # Add allowed paths
        if allowed_paths:
            for path in allowed_paths:
                self.permission_manager.add_allowed_path(path)
                self.document_context.add_allowed_path(path)

        # Register all tools asynchronously
        import asyncio
        asyncio.run(
            register_all_tools(
                mcp_server=self.mcp,
                document_context=self.document_context,
                permission_manager=self.permission_manager,
                project_manager=self.project_manager,
                project_analyzer=self.project_analyzer,
                vector_store_manager=self.vector_store_manager,
            )
        )
        
        # Initialize MCP orchestrator for managing sub-MCP servers
        self.mcp_orchestrator = MCPOrchestrator(self.mcp)
        self.mcp_orchestrator.initialize()
        
        # Register external MCP server tools if enabled
        if enable_external_servers:
            self.proxy_tools = ProxyTools()
            self.proxy_tools.register_tools(self.mcp)

    def cleanup(self):
        """Clean up resources before shutdown."""
        # Clean up MCP orchestrator if available
        if hasattr(self, 'mcp_orchestrator'):
            self.mcp_orchestrator.cleanup()
            
        # Clean up external proxy tools if available
        if hasattr(self, 'proxy_tools'):
            self.proxy_tools.cleanup()
    
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
            self.document_context.add_allowed_path(path)
            
        # Initialize LLM.md for each allowed path that is a directory
        for path in allowed_paths_list:
            if os.path.isdir(path):
                success, content, created = self.llm_file_manager.initialize_for_project(path)
                if success:
                    if created:
                        print(f"Created new LLM.md file in {path}")
                    else:
                        print(f"Loaded existing LLM.md file from {path}")
                else:
                    print(f"Warning: Failed to initialize LLM.md for {path}: {content}")

        # Run the server
        transport_type = cast(Literal["stdio", "sse"], transport)
        self.mcp.run(transport=transport_type)


def main():
    """Run the Hanzo MCP server."""
    import argparse

    parser = argparse.ArgumentParser(
        description="MCP server for accessing Hanzo APIs and Platform capabilities"
    )

    _ = parser.add_argument(
        "--name",
        default="hanzo",
        help="Name of the MCP server (default: hanzo)",
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
    server = HanzoMCPServer(name=name, allowed_paths=allowed_paths)
    server.run(transport=transport, allowed_paths=allowed_paths or [])


if __name__ == "__main__":
    main()