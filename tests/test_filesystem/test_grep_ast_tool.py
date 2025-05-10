"""Tests for the Grep AST tool."""

import asyncio
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from hanzo_mcp.tools.filesystem.grep_ast_tool import GrepAstTool


def test_grep_ast_simple():
    """Simple test to verify collection works."""
    assert True


@pytest.mark.asyncio
async def test_grep_ast_import():
    """Test that the GrepAstTool can be imported."""
    assert GrepAstTool is not None


class TestGrepAstTool:
    """Test the GrepAstTool class."""

    @pytest.fixture
    def grep_ast_tool(
        self,
        document_context,
        permission_manager,
    ):
        """Create a GrepAstTool instance for testing."""
        return GrepAstTool(document_context, permission_manager)

    @pytest.fixture
    def setup_allowed_path(
        self,
        permission_manager,
        document_context,
        temp_dir,
    ):
        """Set up an allowed path for testing."""
        permission_manager.add_allowed_path(temp_dir)
        document_context.add_allowed_path(temp_dir)
        return temp_dir

    @pytest.fixture
    def sample_python_file(self, setup_allowed_path):
        """Create a sample Python file for testing."""
        # Create a sample Python file with functions and classes
        file_path = os.path.join(setup_allowed_path, "sample_code.py")
        with open(file_path, "w") as f:
            f.write('''
def sample_function():
    """This is a sample function."""
    print("Hello, world!")
    return True

class SampleClass:
    """This is a sample class."""
    
    def __init__(self, name):
        self.name = name
        
    def say_hello(self):
        """Say hello to the name."""
        print(f"Hello, {self.name}!")
        return f"Hello, {self.name}!"
        
    def get_name(self):
        """Return the name."""
        return self.name
            ''')
        return file_path

    @pytest.mark.asyncio
    async def test_grep_ast_basic_search(
        self,
        grep_ast_tool,
        sample_python_file,
        mcp_context,
    ):
        """Test basic search functionality."""
        # Mock context calls
        tool_ctx = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                # Mock the TreeContext object to avoid actual parsing
                with patch('grep_ast.grep_ast.TreeContext') as mock_tree_context:
                    # Set up the mock to return matches
                    mock_instance = mock_tree_context.return_value
                    mock_instance.grep.return_value = [3, 10]  # Line numbers with matches
                    mock_instance.format.return_value = "def sample_function():\n    print(\"Hello, world!\")"
                    
                    result = await grep_ast_tool.call(
                        mcp_context,
                        pattern="Hello",
                        path=sample_python_file,
                        ignore_case=False,
                    )

        # Verify that the call was made correctly
        assert mock_tree_context.called
        mock_instance.grep.assert_called_with("Hello", False)
        
        # Verify that the result contains the expected output
        assert sample_python_file in result
        assert "def sample_function():" in result
        
    @pytest.mark.asyncio
    async def test_grep_ast_with_line_numbers(
        self,
        grep_ast_tool,
        sample_python_file,
        mcp_context,
    ):
        """Test search with line numbers."""
        # Mock context calls
        tool_ctx = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                # Mock the TreeContext object to avoid actual parsing
                with patch('grep_ast.grep_ast.TreeContext') as mock_tree_context:
                    # Set up the mock to return matches
                    mock_instance = mock_tree_context.return_value
                    mock_instance.grep.return_value = [3, 10]  # Line numbers with matches
                    mock_instance.format.return_value = "3: def sample_function():\n4:     print(\"Hello, world!\")"
                    
                    result = await grep_ast_tool.call(
                        mcp_context,
                        pattern="Hello",
                        path=sample_python_file,
                        ignore_case=False,
                        line_number=True,
                    )

        # Verify that the TreeContext was created with line_number=True
        mock_tree_context.assert_called_with(
            sample_python_file, 
            mock_tree_context.call_args[0][1],  # The code content
            color=False,
            verbose=False,
            line_number=True,
        )
        
        # Verify that the result contains line numbers
        assert "3: def" in result
        
    @pytest.mark.asyncio
    async def test_grep_ast_no_matches(
        self,
        grep_ast_tool,
        sample_python_file,
        mcp_context,
    ):
        """Test search with no matches."""
        # Mock context calls
        tool_ctx = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                # Mock the TreeContext object to avoid actual parsing
                with patch('grep_ast.grep_ast.TreeContext') as mock_tree_context:
                    # Set up the mock to return no matches
                    mock_instance = mock_tree_context.return_value
                    mock_instance.grep.return_value = []  # No matches
                    
                    result = await grep_ast_tool.call(
                        mcp_context,
                        pattern="NonExistentPattern",
                        path=sample_python_file,
                        ignore_case=False,
                    )

        # Verify result
        assert "No matches found" in result
        
    @pytest.mark.asyncio
    async def test_grep_ast_directory_search(
        self,
        grep_ast_tool,
        setup_allowed_path,
        mcp_context,
    ):
        """Test search in a directory."""
        # Create test directory with files
        test_dir = os.path.join(setup_allowed_path, "test_dir")
        os.makedirs(test_dir, exist_ok=True)
        
        # Create a Python file
        py_file = os.path.join(test_dir, "test.py")
        with open(py_file, "w") as f:
            f.write('''
def test_function():
    return "test"
''')
        
        # Create a text file (should be skipped in processing)
        txt_file = os.path.join(test_dir, "test.txt")
        with open(txt_file, "w") as f:
            f.write("This is a text file")
        
        # Mock context calls
        tool_ctx = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                # Mock the TreeContext object to avoid actual parsing
                with patch('grep_ast.grep_ast.TreeContext') as mock_tree_context:
                    # Set up the mock to return matches for the Python file
                    mock_instance = mock_tree_context.return_value
                    mock_instance.grep.return_value = [2]  # Line number with match
                    mock_instance.format.return_value = "def test_function():\n    return \"test\""
                    
                    result = await grep_ast_tool.call(
                        mcp_context,
                        pattern="test",
                        path=test_dir,
                        ignore_case=False,
                    )

        # Verify that the search was conducted
        assert py_file in result
        assert "def test_function()" in result
        
    @pytest.mark.asyncio
    async def test_grep_ast_parse_error(
        self,
        grep_ast_tool,
        setup_allowed_path,
        mcp_context,
    ):
        """Test handling of parse errors."""
        # Create a file with syntax errors
        error_file = os.path.join(setup_allowed_path, "syntax_error.py")
        with open(error_file, "w") as f:
            f.write('''
def broken_function(
    print("Missing closing parenthesis"
''')
        
        # Mock context calls
        tool_ctx = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch(
                "hanzo_mcp.tools.common.context.create_tool_context",
                return_value=tool_ctx,
            ):
                # Mock the TreeContext object to raise an exception
                with patch('grep_ast.grep_ast.TreeContext') as mock_tree_context:
                    # Set up the mock to raise an exception
                    mock_instance = mock_tree_context.return_value
                    mock_instance.grep.side_effect = Exception("Parse error")
                    
                    result = await grep_ast_tool.call(
                        mcp_context,
                        pattern="print",
                        path=error_file,
                        ignore_case=False,
                    )

        # Verify that warning was logged
        tool_ctx.warning.assert_called()
        
        # Verify result
        assert "No matches found" in result
        
    @pytest.mark.asyncio
    async def test_grep_ast_unauthorized_path(
        self,
        grep_ast_tool,
        mcp_context,
    ):
        """Test search with an unauthorized path."""
        # Path outside of allowed paths
        path = "/not/allowed/path.py"
        
        # Mock context calls
        tool_ctx = AsyncMock()
        tool_ctx.set_tool_info = AsyncMock()
        
        with patch.object(FilesystemBaseTool, 'set_tool_context_info', AsyncMock()):
            with patch.object(grep_ast_tool, 'is_path_allowed', return_value=False):
                with patch(
                    "hanzo_mcp.tools.common.context.create_tool_context",
                    return_value=tool_ctx,
                ):
                    result = await grep_ast_tool.call(
                        mcp_context,
                        pattern="test",
                        path=path,
                        ignore_case=False,
                    )

        # Verify result
        assert "Error" in result
        assert "Access denied" in result