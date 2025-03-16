"""Tests for the server module."""

import os
from unittest.mock import MagicMock, patch

import pytest

from mcp_claude_code.server import ClaudeCodeServer


class TestClaudeCodeServer:
    """Test the ClaudeCodeServer class."""
    
    @pytest.fixture
    def server(self):
        """Create a ClaudeCodeServer instance for testing."""
        with patch("mcp.server.fastmcp.FastMCP") as mock_fastmcp:
            # Create a mock FastMCP instance
            mock_mcp = MagicMock()
            mock_fastmcp.return_value = mock_mcp
            
            # Create the server
            server = ClaudeCodeServer(name="test-server")
            
            # Return both the server and the mock MCP
            yield server, mock_mcp
    
    def test_initialization(self, server):
        """Test initializing ClaudeCodeServer."""
        server_instance, mock_mcp = server
        
        # Verify components were initialized
        assert server_instance.mcp is mock_mcp
        assert server_instance.document_context is not None
        assert server_instance.permission_manager is not None
        assert server_instance.command_executor is not None
        assert server_instance.project_analyzer is not None
        assert server_instance.project_manager is not None
    
    def test_initialization_with_allowed_paths(self):
        """Test initializing with allowed paths."""
        allowed_paths = ["/test/path1", "/test/path2"]
        
        with patch("mcp.server.fastmcp.FastMCP") as mock_fastmcp, \
             patch("mcp_claude_code.tools.register_all_tools") as mock_register:
            
            # Create a mock FastMCP instance
            mock_mcp = MagicMock()
            mock_fastmcp.return_value = mock_mcp
            
            # Create the server with allowed paths
            server = ClaudeCodeServer(name="test-server", allowed_paths=allowed_paths)
            
            # Verify paths were added
            for path in allowed_paths:
                server.permission_manager.add_allowed_path.assert_any_call(path)
                server.document_context.add_allowed_path.assert_any_call(path)
            
            # Verify tools were registered
            mock_register.assert_called_once()
    
    def test_run(self, server):
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
    
    def test_run_with_allowed_paths(self, server):
        """Test running the server with additional allowed paths."""
        server_instance, mock_mcp = server

        # Run the server with allowed paths
        additional_paths = ["/additional/path1", "/additional/path2"]
        server_instance.run(allowed_paths=additional_paths)

        # Verify paths were added
        for path in additional_paths:
            server_instance.permission_manager.add_allowed_path.assert_any_call(path)
            server_instance.document_context.add_allowed_path.assert_any_call(path)

        # Verify the MCP server was run
        mock_mcp.run.assert_called_once()


def test_main():
    """Test the main function."""
    with patch("argparse.ArgumentParser.parse_args") as mock_parse_args, \
         patch("mcp_claude_code.server.ClaudeCodeServer") as mock_server_class:
        
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
        from mcp_claude_code.server import main
        main()
        
        # Verify server was created and run
        mock_server_class.assert_called_once_with(name="test-server", allowed_paths=["/test/path"])
        mock_server.run.assert_called_once_with(transport="stdio", allowed_paths=["/test/path"])
