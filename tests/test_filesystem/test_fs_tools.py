"""Tests for the refactored filesystem tools."""

import os
from typing import TYPE_CHECKING
import asyncio
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

if TYPE_CHECKING:
    from hanzo_mcp.tools.common.context import DocumentContext
    from hanzo_mcp.tools.common.permissions import PermissionManager

from hanzo_mcp.tools.filesystem import (
    ReadFilesTool,
    WriteFileTool,
    EditFileTool,
    get_filesystem_tools
)


class TestRefactoredFileTools:
    """Test the refactored filesystem tools."""

    @pytest.fixture
    def fs_tools(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Create filesystem tool instances for testing."""
        return get_filesystem_tools(document_context, permission_manager)

    @pytest.fixture
    def read_files_tool(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Create a ReadFilesTool instance for testing."""
        return ReadFilesTool(document_context, permission_manager)

    @pytest.fixture
    def write_file_tool(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Create a WriteFileTool instance for testing."""
        return WriteFileTool(document_context, permission_manager)

    @pytest.fixture
    def edit_file_tool(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Create an EditFileTool instance for testing."""
        return EditFileTool(document_context, permission_manager)

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
    async def test_read_files_single_allowed(
        self,
        read_files_tool: ReadFilesTool,
        setup_allowed_path: str,
        test_file: str,
        mcp_context: MagicMock,
    ):
        """Test reading a single allowed file with the refactored tool."""
        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "hanzo_mcp.tools.filesystem.base.create_tool_context",
            return_value=tool_ctx,
        ):
            # Call the tool directly
            result = await read_files_tool.call(ctx=mcp_context, paths=test_file)

            # Verify result
            assert "This is a test file content" in result
            tool_ctx.info.assert_called()

    @pytest.mark.asyncio
    async def test_write_file(
        self,
        write_file_tool: WriteFileTool,
        setup_allowed_path: str,
        mcp_context: MagicMock,
    ):
        """Test writing a file with the refactored tool."""
        # Create a test path within allowed path
        test_path = os.path.join(setup_allowed_path, "write_test.txt")
        test_content = "Test content for writing"

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "hanzo_mcp.tools.filesystem.base.create_tool_context",
            return_value=tool_ctx,
        ):
            # Call the tool directly
            result = await write_file_tool.call(
                ctx=mcp_context, path=test_path, content=test_content
            )

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
        edit_file_tool: EditFileTool,
        setup_allowed_path: str,
        test_file: str,
        mcp_context: MagicMock,
    ):
        """Test editing a file with the refactored tool."""
        # Set up edits
        edits = [
            {
                "oldText": "This is a test file content.",
                "newText": "This is modified content.",
            }
        ]

        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "hanzo_mcp.tools.filesystem.base.create_tool_context",
            return_value=tool_ctx,
        ):
            # Call the tool directly
            result = await edit_file_tool.call(
                ctx=mcp_context, path=test_file, edits=edits, dry_run=False
            )

            # Verify result
            assert "Successfully edited file" in result
            tool_ctx.info.assert_called()

            # Verify file was modified
            with open(test_file, "r") as f:
                content = f.read()
                assert "This is modified content." in content
