"""Tests for the file operations module."""

import os
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

if TYPE_CHECKING:
    from mcp_claude_code.tools.common.context import DocumentContext
    from mcp_claude_code.tools.common.permissions import PermissionManager

from mcp_claude_code.tools.filesystem.file_operations import FileOperations


class TestFileOperations:
    """Test the FileOperations class."""

    @pytest.fixture
    def file_operations(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Create a FileOperations instance for testing."""
        return FileOperations(document_context, permission_manager)

    @pytest.fixture
    def setup_allowed_path(
        self,
        permission_manager: "PermissionManager",
        document_context: "DocumentContext",
        temp_dir: str,
    ):
        """Set up an allowed path for testing."""
        permission_manager.add_allowed_path(temp_dir)
        document_context.add_allowed_path(temp_dir)
        return temp_dir

    def test_initialization(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Test initializing FileOperations."""
        file_ops = FileOperations(document_context, permission_manager)

        assert file_ops.document_context is document_context
        assert file_ops.permission_manager is permission_manager

    def test_register_tools(self, file_operations: FileOperations):
        """Test registering tools with MCP server."""
        mock_server = MagicMock()
        mock_server.tool = MagicMock(return_value=lambda x: x)

        file_operations.register_tools(mock_server)

        # Verify that tool decorators were called
        assert mock_server.tool.call_count > 0

    @pytest.mark.asyncio
    async def test_read_files_single_allowed(
        self,
        file_operations: FileOperations,
        setup_allowed_path: str,
        test_file: str,
        mcp_context: MagicMock,
    ):
        """Test reading a single allowed file."""
        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the read_files function directly
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted read_files function with a single file path string
            result = await tools["read_files"](test_file, mcp_context)

            # Verify result
            assert "This is a test file content" in result
            tool_ctx.info.assert_called()

    @pytest.mark.asyncio
    async def test_read_files_single_not_allowed(
        self, file_operations: FileOperations, mcp_context: MagicMock
    ):
        """Test reading a file that is not allowed."""
        # Path outside of allowed paths
        path = "/not/allowed/path.txt"

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the read_files function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted read_files function with a single file path string
            result = await tools["read_files"](path, mcp_context)

            # Verify result
            assert "Error: Access denied" in result
            tool_ctx.error.assert_called()

    @pytest.mark.asyncio
    async def test_write_file(
        self,
        file_operations: FileOperations,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
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
        self,
        file_operations: FileOperations,
        setup_allowed_path: str,
        test_file: str,
        mcp_context: MagicMock,
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
        self,
        file_operations: FileOperations,
        setup_allowed_path: str,
        mcp_context: MagicMock,
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
        self,
        file_operations: FileOperations,
        setup_allowed_path: str,
        mcp_context: MagicMock,
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

    @pytest.mark.asyncio
    async def test_read_files_multiple(
        self,
        file_operations: FileOperations,
        setup_allowed_path: str,
        test_file: str,
        mcp_context: MagicMock,
    ):
        """Test reading multiple files."""
        # Create a second test file
        second_file = os.path.join(setup_allowed_path, "test_file2.txt")
        with open(second_file, "w") as f:
            f.write("This is the second test file.")

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the read_files function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted read_files function with a list of file paths
            result = await tools["read_files"]([test_file, second_file], mcp_context)

            # Verify result contains both file contents
            assert "This is a test file content" in result
            assert "This is the second test file" in result
            assert "---" in result  # Separator between files
            tool_ctx.info.assert_called()

    @pytest.mark.asyncio
    async def test_read_files_empty_list(
        self,
        file_operations: FileOperations,
        mcp_context: MagicMock,
    ):
        """Test reading an empty list of files."""
        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the read_files function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Use the extracted read_files function with an empty list
            result = await tools["read_files"]([], mcp_context)

            # Verify result
            assert "Error: Parameter 'paths' is required" in result
            tool_ctx.error.assert_called()

    # Add more tests for remaining functionality...
