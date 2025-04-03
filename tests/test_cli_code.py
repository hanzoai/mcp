"""Tests for the hanzo-code CLI tool."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hanzo_mcp.cli_code import HanzoCodeCLI


@pytest.fixture
def cli():
    """Create a HanzoCodeCLI instance for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create a test file in the temp directory
        test_file = os.path.join(temp_dir, "test.txt")
        with open(test_file, "w") as f:
            f.write("test content")
        
        yield HanzoCodeCLI(allowed_paths=[temp_dir], project_dir=temp_dir, verbose=True)


@pytest.mark.asyncio
async def test_cli_read_file(cli):
    """Test reading a file."""
    # Create a test file
    test_file = os.path.join(cli.project_dir, "test.txt")
    
    # Execute read operation
    result = await cli.execute_operation("read", {"paths": [test_file]})
    
    # Check result
    assert result["success"] is True
    assert "data" in result
    assert "content" in result["data"]
    assert result["data"]["content"] == "test content"


@pytest.mark.asyncio
async def test_cli_directory_tree(cli):
    """Test getting a directory tree."""
    # Execute directory_tree operation
    result = await cli.execute_operation("directory_tree", {"path": cli.project_dir, "depth": 1})
    
    # Check result
    assert result["success"] is True
    assert "data" in result
    assert "tree" in result["data"]
    assert "test.txt" in result["data"]["tree"]


@pytest.mark.asyncio
async def test_cli_invalid_operation(cli):
    """Test invalid operation."""
    # Execute invalid operation
    result = await cli.execute_operation("invalid_operation", {})
    
    # Check result
    assert result["success"] is False
    assert "error" in result
    assert "Unknown operation" in result["error"]


@pytest.mark.asyncio
async def test_cli_search_content(cli):
    """Test searching for content in files."""
    # Create a test file with content to search
    test_file = os.path.join(cli.project_dir, "search_test.txt")
    with open(test_file, "w") as f:
        f.write("line 1: test content\nline 2: more content\nline 3: test again")
    
    # Execute search_content operation
    result = await cli.execute_operation("search_content", {
        "pattern": "test",
        "path": cli.project_dir,
        "file_pattern": "*.txt"
    })
    
    # Check result
    assert result["success"] is True
    assert "data" in result
    assert "matches" in result["data"]
    assert len(result["data"]["matches"]) == 2  # "test" appears on lines 1 and 3


@pytest.mark.asyncio
@patch("hanzo_mcp.cli_code.sys")
async def test_process_stdin_command(mock_sys, cli):
    """Test processing a command from stdin."""
    # Mock stdin and stdout
    mock_sys.stdin.readline.return_value = json.dumps({
        "operation": "read",
        "args": {"paths": [os.path.join(cli.project_dir, "test.txt")]}
    })
    
    # Call process_stdin_command
    await cli.process_stdin_command()
    
    # Check that stdout.write was called with the expected result
    assert mock_sys.stdout.write.called
    write_args = mock_sys.stdout.write.call_args[0][0]
    result = json.loads(write_args)
    assert result["success"] is True
    assert "data" in result
    assert "content" in result["data"]
    assert result["data"]["content"] == "test content"
