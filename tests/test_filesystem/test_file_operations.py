"""Tests for the file operations module."""

import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mcp_claude_code.tools.filesystem.file_operations import FileOperations


class TestFileOperations:
    """Test the FileOperations class."""

    @pytest.fixture
    def file_operations(self, document_context, permission_manager):
        """Create a FileOperations instance for testing."""
        return FileOperations(document_context, permission_manager)

    @pytest.fixture
    def setup_allowed_path(self, permission_manager, document_context, temp_dir):
        """Set up an allowed path for testing."""
        permission_manager.add_allowed_path(temp_dir)
        document_context.add_allowed_path(temp_dir)
        return temp_dir

    def test_initialization(self, document_context, permission_manager):
        """Test initializing FileOperations."""
        file_ops = FileOperations(document_context, permission_manager)

        assert file_ops.document_context is document_context
        assert file_ops.permission_manager is permission_manager

    def test_register_tools(self, file_operations):
        """Test registering tools with MCP server."""
        mock_server = MagicMock()
        mock_server.tool = MagicMock(return_value=lambda x: x)

        file_operations.register_tools(mock_server)

        # Verify that tool decorators were called
        assert mock_server.tool.call_count > 0

    @pytest.mark.asyncio
    async def test_read_file_allowed(
        self, file_operations, setup_allowed_path, test_file, mcp_context
    ):
        """Test reading an allowed file."""
        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the read_file function directly
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted read_file function
            result = await tools["read_file"](test_file, mcp_context)

            # Verify result
            assert "This is a test file content" in result
            tool_ctx.info.assert_called()

    @pytest.mark.asyncio
    async def test_read_file_not_allowed(self, file_operations, mcp_context):
        """Test reading a file that is not allowed."""
        # Path outside of allowed paths
        path = "/not/allowed/path.txt"

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the read_file function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted read_file function
            result = await tools["read_file"](path, mcp_context)

            # Verify result
            assert "Error: Access denied" in result
            tool_ctx.error.assert_called()

    @pytest.mark.asyncio
    async def test_write_file(self, file_operations, setup_allowed_path, mcp_context):
        """Test writing a file."""
        # Create a test path within allowed path
        test_path = os.path.join(setup_allowed_path, "write_test.txt")
        test_content = "Test content for writing"

        # Mock permission approval

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the write_file function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted write_file function
            result = await tools["write_file"](test_path, test_content, mcp_context)

            # Verify result
            assert "Successfully wrote file" in result
            tool_ctx.info.assert_called()

            # Verify file was written
            assert os.path.exists(test_path)
            with open(test_path, "r") as f:
                assert f.read() == test_content

    @pytest.mark.asyncio
    async def test_edit_file(
        self, file_operations, setup_allowed_path, test_file, mcp_context
    ):
        """Test editing a file."""
        # Set up edits
        edits = [
            {
                "oldText": "This is a test file content.",
                "newText": "This is modified content.",
            }
        ]

        # Mock permission approval

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the edit_file function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted edit_file function
            result = await tools["edit_file"](test_file, edits, False, mcp_context)

            # Verify result
            assert "Successfully edited file" in result
            tool_ctx.info.assert_called()

            # Verify file was modified
            with open(test_file, "r") as f:
                content = f.read()
                assert "This is modified content." in content

    @pytest.mark.asyncio
    async def test_create_directory(
        self, file_operations, setup_allowed_path, mcp_context
    ):
        """Test creating a directory."""
        # Create a test directory path
        test_dir = os.path.join(setup_allowed_path, "test_create_dir")

        # Mock permission approval

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the create_directory function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted create_directory function
            result = await tools["create_directory"](test_dir, mcp_context)

            # Verify result
            assert "Successfully created directory" in result
            tool_ctx.info.assert_called()

            # Verify directory was created
            assert os.path.exists(test_dir)
            assert os.path.isdir(test_dir)

    @pytest.mark.asyncio
    async def test_list_directory(
        self, file_operations, setup_allowed_path, mcp_context
    ):
        """Test listing a directory."""
        # Create test content
        test_subdir = os.path.join(setup_allowed_path, "test_subdir")
        os.makedirs(test_subdir, exist_ok=True)

        test_file_path = os.path.join(setup_allowed_path, "list_test.txt")
        with open(test_file_path, "w") as f:
            f.write("Test content")

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the list_directory function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted list_directory function
            result = await tools["list_directory"](setup_allowed_path, mcp_context)

            # Verify result
            assert "[DIR] test_subdir" in result
            assert "[FILE] list_test.txt" in result
            tool_ctx.info.assert_called()

    # Add more tests for remaining functionality...
