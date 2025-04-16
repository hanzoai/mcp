"""Tests for the context module."""

import json
import asyncio
import os
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from hanzo_mcp.tools.common.context import (

    DocumentContext,
    ToolContext,
    create_tool_context,
)


class TestDocumentContext:
    """Test the DocumentContext class."""

    def test_add_allowed_path(self, temp_dir: str):
        """Test adding an allowed path."""
        context = DocumentContext()
        context.add_allowed_path(temp_dir)

        resolved_path = Path(temp_dir).resolve()
        assert resolved_path in context.allowed_paths

    def test_is_path_allowed(self, temp_dir: str):
        """Test checking if a path is allowed."""
        context = DocumentContext()
        context.add_allowed_path(temp_dir)

        # Test allowed path
        test_file = os.path.join(temp_dir, "test.txt")
        assert context.is_path_allowed(test_file)

        # Test disallowed path
        outside_file = os.path.join(os.path.dirname(temp_dir), "outside.txt")
        assert not context.is_path_allowed(outside_file)

    def test_add_document(self, test_file: str):
        """Test adding a document to the context."""
        context = DocumentContext()
        content = "Test content"

        context.add_document(test_file, content)

        assert test_file in context.documents
        assert context.documents[test_file] == content
        assert test_file in context.document_metadata

    def test_get_document(self, test_file: str):
        """Test getting a document from the context."""
        context = DocumentContext()
        content = "Test content"

        context.add_document(test_file, content)
        retrieved = context.get_document(test_file)

        assert retrieved == content

        # Test non-existent document
        assert context.get_document("nonexistent.txt") is None

    def test_get_document_metadata(self, test_file: str):
        """Test getting document metadata."""
        context = DocumentContext()
        content = "Test content"

        context.add_document(test_file, content)
        metadata = context.get_document_metadata(test_file)

        assert metadata is not None
        assert "extension" in metadata
        assert metadata["extension"] == ".txt"
        assert metadata["size"] == len(content)

        # Test non-existent document
        assert context.get_document_metadata("nonexistent.txt") is None

    def test_update_document(self, test_file: str):
        """Test updating a document in the context."""
        context = DocumentContext()
        original_content = "Original content"
        updated_content = "Updated content"

        # Add document
        context.add_document(test_file, original_content)
        assert context.documents[test_file] == original_content

        # Update document
        context.update_document(test_file, updated_content)
        assert context.documents[test_file] == updated_content

    def test_remove_document(self, test_file: str):
        """Test removing a document from the context."""
        context = DocumentContext()
        content = "Test content"

        # Add document
        context.add_document(test_file, content)
        assert test_file in context.documents

        # Remove document
        context.remove_document(test_file)
        assert test_file not in context.documents
        assert test_file not in context.document_metadata
        assert test_file not in context.modified_times

    def test_infer_metadata(self, temp_dir: str):
        """Test metadata inference for different file types."""
        context = DocumentContext()

        # Test Python file
        py_file = os.path.join(temp_dir, "test.py")
        py_content = "def test():\n    pass\n"
        metadata = context._infer_metadata(py_file, py_content)

        assert metadata["language"] == "python"
        assert metadata["extension"] == ".py"
        assert metadata["line_count"] == 3

        # Test JSON file
        json_file = os.path.join(temp_dir, "test.json")
        json_content = '{"key": "value"}'
        metadata = context._infer_metadata(json_file, json_content)

        assert metadata["language"] == "json"
        assert metadata["extension"] == ".json"
        assert metadata["size"] == len(json_content)

    def test_to_json(self, test_file: str):
        """Test converting the context to JSON."""
        context = DocumentContext()
        content = "Test content"

        context.add_document(test_file, content)
        context.add_allowed_path(os.path.dirname(test_file))

        json_str = context.to_json()
        data = json.loads(json_str)

        assert "documents" in data
        assert test_file in data["documents"]
        assert data["documents"][test_file] == content
        assert "metadata" in data
        assert "allowed_paths" in data

    def test_from_json(self, test_file: str):
        """Test creating a context from JSON."""
        original = DocumentContext()
        content = "Test content"

        original.add_document(test_file, content)
        original.add_allowed_path(os.path.dirname(test_file))

        json_str = original.to_json()
        reconstructed = DocumentContext.from_json(json_str)

        assert test_file in reconstructed.documents
        assert reconstructed.documents[test_file] == content
        assert len(reconstructed.allowed_paths) == len(original.allowed_paths)

    @pytest.mark.parametrize(
        "exclude_patterns", [None, [".git", "__pycache__"], ["*.txt"]]
    )
    def test_load_directory(self, temp_dir: str, exclude_patterns: list[str] | None):
        """Test loading a directory into the context."""
        # Skip actual test implementation for now as it requires
        # complex directory setup
        # This is a placeholder for the test structure
        pass


class TestToolContext:
    """Test the ToolContext class."""

    def test_initialization(self, mcp_context: MagicMock):
        """Test initializing a ToolContext."""
        tool_context = ToolContext(mcp_context)

        assert tool_context.mcp_context == mcp_context
        assert tool_context.request_id == mcp_context.request_id
        assert tool_context.client_id == mcp_context.client_id

    def test_set_tool_info(self, mcp_context: MagicMock):
        """Test setting tool info."""
        tool_context = ToolContext(mcp_context)
        tool_name = "test_tool"
        execution_id = "123456"

        tool_context.set_tool_info(tool_name, execution_id)

        # Test internal state
        assert tool_context._tool_name == tool_name
        assert tool_context._execution_id == execution_id

    @pytest.mark.asyncio
    async def test_logging_methods(self, mcp_context: MagicMock):
        """Test logging methods."""
        tool_context = ToolContext(mcp_context)
        tool_context.set_tool_info("test_tool")

        # Test info logging
        await tool_context.info("Test info")
        mcp_context.info.assert_called_once_with("[test_tool] Test info")

        # Test debug logging
        await tool_context.debug("Test debug")
        mcp_context.debug.assert_called_once_with("[test_tool] Test debug")

        # Test warning logging
        await tool_context.warning("Test warning")
        mcp_context.warning.assert_called_once_with("[test_tool] Test warning")

        # Test error logging
        await tool_context.error("Test error")
        mcp_context.error.assert_called_once_with("[test_tool] Test error")

    def test_format_message(self, mcp_context: MagicMock):
        """Test message formatting."""
        tool_context = ToolContext(mcp_context)

        # No tool info
        message = tool_context._format_message("Test message")
        assert message == "Test message"

        # With tool name
        tool_context.set_tool_info("test_tool")
        message = tool_context._format_message("Test message")
        assert message == "[test_tool] Test message"

        # With tool name and execution id
        tool_context.set_tool_info("test_tool", "123456")
        message = tool_context._format_message("Test message")
        assert message == "[test_tool:123456] Test message"

    @pytest.mark.asyncio
    async def test_report_progress(self, mcp_context: MagicMock):
        """Test progress reporting."""
        tool_context = ToolContext(mcp_context)

        await tool_context.report_progress(50, 100)
        mcp_context.report_progress.assert_called_once_with(50, 100)

    @pytest.mark.asyncio
    async def test_read_resource(self, mcp_context: MagicMock):
        """Test reading a resource."""
        tool_context = ToolContext(mcp_context)

        await tool_context.read_resource("resource://test")
        mcp_context.read_resource.assert_called_once_with("resource://test")


def test_create_tool_context(mcp_context: MagicMock):
    """Test creating a tool context."""
    tool_context = create_tool_context(mcp_context)

    assert isinstance(tool_context, ToolContext)
    assert tool_context.mcp_context == mcp_context
