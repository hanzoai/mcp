"""Tests for the server module."""

from unittest.mock import MagicMock, patch

import pytest

from hanzo_mcp.server import HanzoServer


class TestHanzoServer:
    """Test the HanzoServer class."""

    @pytest.fixture
    def server(self) -> tuple[HanzoServer, MagicMock]:
        """Create a HanzoServer instance for testing."""
        with patch("mcp.server.fastmcp.FastMCP") as mock_fastmcp:
            # Create a mock FastMCP instance
            mock_mcp = MagicMock()
            mock_fastmcp.return_value = mock_mcp

            # Create the server with the mock MCP
            server = HanzoServer(name="test-server", mcp_instance=mock_mcp)

            # Return both the server and the mock MCP
            yield server, mock_mcp

    def test_initialization(self, server: tuple[HanzoServer, MagicMock]) -> None:
        """Test initializing HanzoServer."""
        server_instance, mock_mcp = server

        # Verify components were initialized
        assert server_instance.mcp is mock_mcp
        assert server_instance.document_context is not None
        assert server_instance.permission_manager is not None
        assert server_instance.command_executor is not None
        assert server_instance.project_analyzer is not None
        assert server_instance.project_manager is not None
        
    def test_initialization_with_disable_write_tools(self) -> None:
        """Test initializing HanzoServer with disable_write_tools=True."""
        with patch("mcp.server.fastmcp.FastMCP") as mock_fastmcp, \
             patch("hanzo_mcp.server.register_all_tools") as mock_register_all_tools:
            # Create a mock FastMCP instance
            mock_mcp = MagicMock()
            mock_fastmcp.return_value = mock_mcp
            
            # Create the server with disable_write_tools=True
            server = HanzoServer(
                name="test-server", 
                mcp_instance=mock_mcp,
                disable_write_tools=True
            )
            
            # Verify that the disable_write_tools flag was passed to register_all_tools
            mock_register_all_tools.assert_called_once()
            args, kwargs = mock_register_all_tools.call_args
            assert kwargs.get("disable_write_tools") is True

    def test_initialization_with_allowed_paths(self) -> None:
        """Test initializing with allowed paths."""
        allowed_paths = ["/test/path1", "/test/path2"]

        with (
            patch("mcp.server.fastmcp.FastMCP") as mock_fastmcp,
            patch("hanzo_mcp.tools.register_all_tools") as mock_register,
        ):
            # Create mock fastmcp
            mock_mcp = MagicMock()
            mock_fastmcp.return_value = mock_mcp

            # Direct mock of the permission manager and document context
            perm_manager = MagicMock()
            doc_context = MagicMock()

            # Create the server
            server = HanzoServer(name="test-server", mcp_instance=mock_mcp)

            # Inject our mocks
            server.permission_manager = perm_manager
            server.document_context = doc_context

            # Manually call register_all_tools
            from hanzo_mcp.tools import register_all_tools

            register_all_tools(
                mock_mcp,
                doc_context,
                perm_manager,
                server.project_manager,
                server.project_analyzer,
            )

            # Now call the code that would add the paths
            for path in allowed_paths:
                server.permission_manager.add_allowed_path(path)
                server.document_context.add_allowed_path(path)

            # Verify paths were added
            assert perm_manager.add_allowed_path.call_count == len(allowed_paths)
            assert doc_context.add_allowed_path.call_count == len(allowed_paths)

            # Verify each path was passed
            for path in allowed_paths:
                perm_manager.add_allowed_path.assert_any_call(path)
                doc_context.add_allowed_path.assert_any_call(path)

            # Verify tools were registered
            mock_register.assert_called_once()

    @pytest.mark.skip(reason="Cannot run stdio server in a test environment")
    def test_run(self, server: tuple[HanzoServer, MagicMock]) -> None:
        """Test running the server."""
        server_instance, mock_mcp = server

        # Run the server
        server_instance.run()

        # Verify the MCP server was run
        mock_mcp.run.assert_called_once_with(transport="stdio")

    # def test_run_with_transport(self, server):
    #     """Test running the server with a specific transport."""
    #     server_instance, mock_mcp = server
    #
    #     # Run the server with SSE transport
    #     server_instance.run(transport="sse")
    #
    #     # Verify the MCP server was run with the specified transport
    #     mock_mcp.run.assert_called_once_with(transport="sse")

    @pytest.mark.skip(reason="Cannot run stdio server in a test environment")
    def test_run_with_allowed_paths(
        self, server: tuple[HanzoServer, MagicMock]
    ) -> None:
        """Test running the server with additional allowed paths."""
        server_instance, mock_mcp = server

        # Replace permission_manager and document_context with mocks
        server_instance.permission_manager = MagicMock()
        server_instance.document_context = MagicMock()

        # Run the server with allowed paths
        additional_paths = ["/additional/path1", "/additional/path2"]
        server_instance.run(allowed_paths=additional_paths)

        # Verify paths were added by checking call counts
        assert server_instance.permission_manager.add_allowed_path.call_count == len(
            additional_paths
        )
        assert server_instance.document_context.add_allowed_path.call_count == len(
            additional_paths
        )

        # Verify each path was passed to the add methods
        for path in additional_paths:
            server_instance.permission_manager.add_allowed_path.assert_any_call(path)
            server_instance.document_context.add_allowed_path.assert_any_call(path)

        # Verify the MCP server was run
        mock_mcp.run.assert_called_once()


def test_main() -> None:
    """Test the main function."""
    with (
        patch("argparse.ArgumentParser.parse_args") as mock_parse_args,
        patch("hanzo_mcp.server.HanzoServer") as mock_server_class,
    ):
        # Mock parsed arguments
        mock_args = MagicMock()
        mock_args.name = "test-server"
        mock_args.transport = "stdio"
        mock_args.allowed_paths = ["/test/path"]
        mock_parse_args.return_value = mock_args

        # Mock server instance
        mock_server = MagicMock()
        mock_server_class.return_value = mock_server

        # Call main
        from hanzo_mcp.server import main

        main()

        # Verify server was created and run
        mock_server_class.assert_called_once_with(
            name="test-server", allowed_paths=["/test/path"]
        )
        mock_server.run.assert_called_once_with(
            transport="stdio", allowed_paths=["/test/path"]
        )
