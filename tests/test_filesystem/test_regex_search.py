"""Tests for the regex search functionality in file operations."""

import os
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

if TYPE_CHECKING:
    from mcp_claude_code.tools.common.context import DocumentContext
    from mcp_claude_code.tools.common.permissions import PermissionManager

from mcp_claude_code.tools.filesystem.file_operations import FileOperations


class TestRegexSearch:
    """Test the regex search functionality in FileOperations."""

    @pytest.fixture
    def file_operations(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
    ):
        """Create a FileOperations instance for testing."""
        return FileOperations(document_context, permission_manager)

    @pytest.fixture
    def setup_test_files(self, temp_dir: str):
        """Create test files with content for regex testing."""
        # Create a test directory
        test_dir = os.path.join(temp_dir, "regex_test_dir")
        os.makedirs(test_dir, exist_ok=True)
        
        # Create a file with various patterns for regex testing
        test_file_path = os.path.join(test_dir, "regex_test.txt")
        
        with open(test_file_path, "w") as f:
            f.write("start of a line with some text\n")
            f.write("this line has digits 12345 in the middle\n")
            f.write("this line has special characters: $^*[]\n")
            f.write("this line contains consecutive vowels like aeiou\n")
            f.write("a line that ends with end\n")
            f.write("not a matching line\n")
            f.write("another line with phone: 555-123-4567\n")
            f.write("email@example.com is an email address\n")
            f.write("UPPERCASE text mixed with lowercase\n")
            f.write("something at the end of this line\n")
            f.write("the word endzone contains end but isn't at the end\n")
            f.write("this line ends with the word send")

        
        return {
            "test_dir": test_dir,
            "test_file": test_file_path
        }

    @pytest.mark.asyncio
    async def test_regex_search_simple(
        self,
        file_operations: FileOperations,
        setup_test_files: dict,
        mcp_context: MagicMock,
    ):
        """Test simple string search still works as expected."""
        test_file = setup_test_files["test_file"]
        
        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the search_content function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Ensure the path is allowed
            file_operations.permission_manager.add_allowed_path(test_file)
            
            # Test simple substring search
            result = await tools["search_content"](mcp_context, "digits", test_file, "*")

            # Verify the line with "digits" is found
            assert "this line has digits 12345 in the middle" in result
            
    @pytest.mark.asyncio
    async def test_regex_search_patterns(
        self,
        file_operations: FileOperations,
        setup_test_files: dict,
        mcp_context: MagicMock,
    ):
        """Test various regex patterns that wouldn't work with simple substring search."""
        test_file = setup_test_files["test_file"]
        
        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the search_content function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Ensure the path is allowed
            file_operations.permission_manager.add_allowed_path(test_file)
            
            # Test 1: Match any sequence of digits
            result1 = await tools["search_content"](mcp_context, r"\d+", test_file, "*")
            assert "this line has digits 12345 in the middle" in result1
            assert "another line with phone: 555-123-4567" in result1
            
            # Test 2: Match lines that begin with the word "start"
            result2 = await tools["search_content"](mcp_context, r"^start", test_file, "*")
            assert "start of a line with some text" in result2
            assert "another line" not in result2 # Line doesn't start with 'start'
            
            # Test 3: Match lines that contain "word" followed by any word ending with the line
            result3 = await tools["search_content"](mcp_context, r"word\s+\w+$", test_file, "*")
            assert "this line ends with the word send" in result3  # matches the pattern
            assert "a line that ends with end" not in result3  # doesn't match the pattern
            assert "the word endzone contains end but isn't at the end" not in result3  # doesn't match the pattern
            
            # Test 4: Match two consecutive vowels
            result4 = await tools["search_content"](mcp_context, r"[aeiou]{2}", test_file, "*")
            assert "this line contains consecutive vowels like aeiou" in result4
            assert "email@example.com is an email address" in result4
            
            # Test 5: Match email pattern
            result5 = await tools["search_content"](mcp_context, r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b", test_file, "*")
            assert "email@example.com is an email address" in result5
            assert "this line has digits" not in result5
            
            # Test 6: Case-insensitive search
            result6 = await tools["search_content"](mcp_context, r"(?i)uppercase", test_file, "*")
            assert "UPPERCASE text mixed with lowercase" in result6
            
    @pytest.mark.asyncio
    async def test_regex_search_metacharacters(
        self,
        file_operations: FileOperations,
        setup_test_files: dict,
        mcp_context: MagicMock,
    ):
        """Test searching for lines with regex metacharacters."""
        test_file = setup_test_files["test_file"]
        
        # Mock context calls
        tool_ctx = AsyncMock()
        with patch(
            "mcp_claude_code.tools.filesystem.file_operations.create_tool_context",
            return_value=tool_ctx,
        ):
            # Extract the search_content function
            mock_server = MagicMock()
            tools = {}

            def mock_decorator():
                def decorator(func):
                    tools[func.__name__] = func
                    return func

                return decorator

            mock_server.tool = mock_decorator
            file_operations.register_tools(mock_server)

            # Ensure the path is allowed
            file_operations.permission_manager.add_allowed_path(test_file)
            
            # Test searching for lines with regex metacharacters
            result = await tools["search_content"](mcp_context, r"\$\^\*\[\]", test_file, "*")
            assert "this line has special characters: $^*[]" in result
