"""Basic tests for the MCP Claude Code server."""

import os
import sys
import unittest
from pathlib import Path
import tempfile
import asyncio

# Add the parent directory to the path so we can import the package
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from mcp_claude_code.server import ClaudeCodeServer
from mcp_claude_code.context import DocumentContext
from mcp_claude_code.permissions import PermissionManager
from mcp_claude_code.enhanced_commands import EnhancedCommandExecutor


class TestBasicFunctionality(unittest.TestCase):
    """Basic functionality tests for the Claude Code server components."""
    
    def setUp(self):
        """Set up temporary directories and files for testing."""
        # Create a temporary directory
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        
        # Create a temporary file
        self.test_file = self.temp_path / "test.txt"
        with open(self.test_file, 'w') as f:
            f.write("This is a test file.")
    
    def tearDown(self):
        """Clean up temporary files and directories."""
        self.temp_dir.cleanup()
    
    def test_document_context(self):
        """Test the DocumentContext class."""
        context = DocumentContext()
        context.add_allowed_path(str(self.temp_path))
        
        # Test adding a document
        context.add_document(str(self.test_file), "This is a test file.")
        
        # Test retrieving a document
        content = context.get_document(str(self.test_file))
        self.assertEqual(content, "This is a test file.")
        
        # Test updating a document
        context.update_document(str(self.test_file), "Updated content.")
        content = context.get_document(str(self.test_file))
        self.assertEqual(content, "Updated content.")
        
        # Test removing a document
        context.remove_document(str(self.test_file))
        content = context.get_document(str(self.test_file))
        self.assertIsNone(content)
    
    def test_permission_manager(self):
        """Test the PermissionManager class."""
        manager = PermissionManager()
        manager.add_allowed_path(str(self.temp_path))
        
        # Test allowed path
        self.assertTrue(manager.is_path_allowed(str(self.test_file)))
        
        # Test disallowed path
        self.assertFalse(manager.is_path_allowed("/etc/passwd"))
        
        # Test operation approval
        manager.approve_operation(str(self.test_file), "read")
        self.assertTrue(manager.is_operation_approved(str(self.test_file), "read"))
        
        # Test operation not approved
        self.assertFalse(manager.is_operation_approved(str(self.test_file), "write"))
    
    async def async_test_command_executor(self):
        """Test the CommandExecutor class."""
        manager = PermissionManager()
        executor = EnhancedCommandExecutor(manager)
        
        # Test executing a command
        result = await executor.execute_command("echo Hello, World!")
        self.assertTrue(result.is_success)
        self.assertEqual(result.stdout.strip(), "Hello, World!")
        
        # Test executing a script
        result = await executor.execute_script("echo Hello from script!", interpreter="bash")
        self.assertTrue(result.is_success)
        self.assertEqual(result.stdout.strip(), "Hello from script!")
    
    def test_command_executor(self):
        """Run the async test for CommandExecutor."""
        asyncio.run(self.async_test_command_executor())


if __name__ == "__main__":
    unittest.main()
