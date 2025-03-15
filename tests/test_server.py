"""Tests for the MCP Claude Code server."""

import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
import sys
import os

# Add the parent directory to the path so we can import the package
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from mcp_claude_code.server import ClaudeCodeServer


class TestClaudeCodeServer(unittest.TestCase):
    """Test cases for the Claude Code server."""
    
    def test_server_initialization(self):
        """Test that the server initializes correctly."""
        server = ClaudeCodeServer(name="test-server")
        self.assertEqual(server.mcp.name, "test-server")


if __name__ == "__main__":
    unittest.main()
