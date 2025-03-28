"""Tests for the Tool Context module."""

import json
from unittest.mock import MagicMock

import pytest

from hanzo_mcp.tools.common.context import ToolContext


class TestToolContext:
    """Test the ToolContext class."""

    @pytest.fixture
    def tool_ctx(self):
        """Create a ToolContext instance for testing."""
        mcp_context = MagicMock()
        return ToolContext(mcp_context)

    def test_operation_tracking(self, tool_ctx):
        """Test tracking operations and parameters."""
        # Set operation tracking values
        tool_ctx.current_operation = "read"
        tool_ctx.operation_params = {"paths": "/path/to/file.txt"}
        
        # Test success response
        result = tool_ctx.success("Successfully read file", {
            "content": "File content here",
            "path": "/path/to/file.txt"
        })
        
        # Parse the result as JSON
        response = json.loads(result)
        
        # Verify the response includes the operation name
        assert response["status"] == "success"
        assert response["message"] == "Successfully read file"
        assert response["data"]["tool"] == "read"
        assert response["data"]["content"] == "File content here"
        assert response["data"]["path"] == "/path/to/file.txt"
        
        # Verify the params are included
        assert response["data"]["params"]["paths"] == "/path/to/file.txt"
    
    def test_mcp_operation_tracking(self, tool_ctx):
        """Test tracking MCP operations with subcommands and targets."""
        # Set operation tracking values for an MCP operation
        tool_ctx.current_operation = "run_mcp"
        tool_ctx.operation_params = {
            "subcommand": "start",
            "server_name": "browser-use"
        }
        
        # Test success response
        result = tool_ctx.success("Successfully started MCP server", {
            "pid": 12345
        })
        
        # Parse the result as JSON
        response = json.loads(result)
        
        # Verify the response includes the MCP operation details
        assert response["status"] == "success"
        assert response["message"] == "Successfully started MCP server"
        assert response["data"]["tool"] == "run_mcp"
        assert response["data"]["subcommand"] == "start"
        assert response["data"]["target"] == "browser-use"
        assert response["data"]["pid"] == 12345
    
    def test_sensitive_param_filtering(self, tool_ctx):
        """Test filtering of sensitive parameters."""
        # Set operation with sensitive parameters
        tool_ctx.current_operation = "connect"
        tool_ctx.operation_params = {
            "url": "https://example.com",
            "username": "user123",
            "password": "secret123",
            "api_key": "sk-1234567890",
            "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        }
        
        # Test success response
        result = tool_ctx.success("Successfully connected")
        
        # Parse the result as JSON
        response = json.loads(result)
        
        # Verify only non-sensitive params are included
        assert response["data"]["tool"] == "connect"
        assert "url" in response["data"]["params"]
        assert "username" in response["data"]["params"]
        assert "password" not in response["data"]["params"]
        assert "api_key" not in response["data"]["params"]
        assert "token" not in response["data"]["params"]
