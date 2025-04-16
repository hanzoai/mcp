"""Tests for the write_file tool."""

import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hanzo_mcp.tools.common.context import DocumentContext
    from hanzo_mcp.tools.common.permissions import PermissionManager

from hanzo_mcp.tools.filesystem.write_file import WriteFileTool
from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool
import asyncio


class TestWriteFileTool:
    """Test the WriteFileTool class."""

    @pytest.fixture
    def write_file_tool(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Create a WriteFileTool instance for testing."""
        return WriteFileTool(document_context, permission_manager)

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

    @pytest.mark.asyncio
    async def test_write_file_success(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test successful file writing."""
        # Create a test path within allowed path
        test_path = os.path.join(setup_allowed_path, "write_test.txt")
        test_content = "Test content for writing"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=test_content)

        # Verify result
        assert "Successfully wrote file" in result
        assert f"{test_path}" in result
        assert f"{len(test_content)} bytes" in result

        # Verify file was written
        assert os.path.exists(test_path)
        with open(test_path, "r") as f:
            assert f.read() == test_content

    @pytest.mark.asyncio
    async def test_write_file_missing_path(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with a missing path parameter."""
        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=None, content="test content")

        # Verify result
        assert "Error: Parameter 'path' is required but was None" in result

    @pytest.mark.asyncio
    async def test_write_file_empty_path(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with an empty path parameter."""
        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path="", content="test content")

        # Verify result
        assert "Error: Parameter 'path' is required but was None" in result or "Error: Parameter 'path' cannot be empty" in result

    @pytest.mark.asyncio
    async def test_write_file_missing_content(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with missing content parameter."""
        # Create a test path within allowed path
        test_path = os.path.join(setup_allowed_path, "missing_content.txt")

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=None)

        # Verify result
        assert "Error: Parameter 'content' is required but was None" in result

    @pytest.mark.asyncio
    async def test_write_file_path_not_allowed(
        self,
        write_file_tool: WriteFileTool,
        mcp_context: MagicMock,
    ):
        """Test writing a file with a path that is not allowed."""
        # Path outside of allowed paths
        test_path = "/not/allowed/path.txt"
        test_content = "This should not be written"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=test_content)

        # Verify result indicates error
        assert "Error: Access denied" in result or "Error: Path not allowed" in result

    @pytest.mark.asyncio
    async def test_write_file_parent_dir_not_allowed(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with a parent directory that is not allowed."""
        # Create a path where the parent dir is not allowed
        test_path = os.path.join("/not/allowed/parent", "file.txt")
        test_content = "This should not be written"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=test_content)

        # Verify result indicates error
        assert "Error: Access denied" in result or "Error: Path not allowed" in result

    @pytest.mark.asyncio
    async def test_write_file_parent_dir_creation(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with parent directories that don't exist yet."""
        # Create a test path with parent dirs that don't exist
        nested_dir = os.path.join(setup_allowed_path, "nested", "dirs", "to", "create")
        test_path = os.path.join(nested_dir, "nested_file.txt")
        test_content = "Content in a nested directory"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=test_content)

        # Verify result
        assert "Successfully wrote file" in result
        assert test_path in result

        # Verify parent dirs were created and file was written
        assert os.path.exists(test_path)
        with open(test_path, "r") as f:
            assert f.read() == test_content

    @pytest.mark.asyncio
    async def test_write_file_overwrite_existing(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test overwriting an existing file."""
        # Create a test file with initial content
        test_path = os.path.join(setup_allowed_path, "overwrite_test.txt")
        initial_content = "Initial content that will be overwritten"
        with open(test_path, "w") as f:
            f.write(initial_content)

        # New content to overwrite
        new_content = "New content that overwrites the old content"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=new_content)

        # Verify result
        assert "Successfully wrote file" in result
        assert test_path in result

        # Verify file was overwritten
        with open(test_path, "r") as f:
            content = f.read()
            assert content == new_content
            assert initial_content not in content

    @pytest.mark.asyncio
    async def test_write_file_large_content(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with large content."""
        # Create a test path for large content
        test_path = os.path.join(setup_allowed_path, "large_content.txt")
        # Generate large content (1MB)
        large_content = "X" * (1024 * 1024)  # 1MB of 'X' characters

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=large_content)

        # Verify result
        assert "Successfully wrote file" in result
        assert test_path in result
        assert "1048576 bytes" in result  # 1MB in bytes

        # Verify file was written with correct size
        assert os.path.exists(test_path)
        assert os.path.getsize(test_path) == 1024 * 1024

    @pytest.mark.asyncio
    async def test_write_file_binary_content(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with content that includes binary/special characters."""
        # Create a test path for binary content
        test_path = os.path.join(setup_allowed_path, "binary_content.txt")
        # Content with various special characters
        special_content = "Special chars: \x00\x01\x02\xff\xfe\n\r\t\b\v\f\a"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=special_content)

        # Verify result
        assert "Successfully wrote file" in result
        assert test_path in result

        # Verify file was written
        assert os.path.exists(test_path)
        # Since we're writing text, not all binary characters may be preserved as-is
        with open(test_path, "r", errors="replace") as f:
            content = f.read()
            assert "Special chars:" in content

    @pytest.mark.asyncio
    async def test_write_file_unicode_content(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with unicode content."""
        # Create a test path for unicode content
        test_path = os.path.join(setup_allowed_path, "unicode_content.txt")
        # Content with various unicode characters
        unicode_content = "Unicode: 你好, привет, こんにちは, 안녕하세요, مرحبا, שלום"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the base class method
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                result = await write_file_tool.call(mcp_context, path=test_path, content=unicode_content)

        # Verify result
        assert "Successfully wrote file" in result
        assert test_path in result

        # Verify file was written with correct unicode content
        assert os.path.exists(test_path)
        with open(test_path, "r", encoding="utf-8") as f:
            content = f.read()
            assert content == unicode_content

    @pytest.mark.asyncio
    async def test_write_file_with_write_exception(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test handling of exceptions during file writing."""
        # Create a test path
        test_path = os.path.join(setup_allowed_path, "exception_test.txt")
        test_content = "Content that won't be written due to exception"

        # Mock context calls
        tool_ctx = AsyncMock()
        
        # Mock the open function to raise an exception
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                with patch("builtins.open", side_effect=IOError("Simulated I/O error")):
                    result = await write_file_tool.call(mcp_context, path=test_path, content=test_content)

        # Verify result indicates error
        assert "Error writing file" in result
        assert "Simulated I/O error" in result

    @pytest.mark.asyncio
    async def test_write_file_register_method(
        self,
        write_file_tool: WriteFileTool,
        mcp_context: MagicMock,
    ):
        """Test the register method of WriteFileTool."""
        # Create a mock MCP server
        mock_mcp_server = MagicMock()
        mock_mcp_server.tool = MagicMock(return_value=lambda f: f)

        # Call register method
        write_file_tool.register(mock_mcp_server)

        # Verify tool was registered
        mock_mcp_server.tool.assert_called_once()
        args, kwargs = mock_mcp_server.tool.call_args
        assert kwargs["name"] == "write_file"
        assert "description" in kwargs
