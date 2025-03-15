"""Tests for the enhanced command execution system."""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path

from mcp_claude_code.enhanced_commands import CommandResult, EnhancedCommandExecutor
from mcp_claude_code.tools.common.permissions import PermissionManager


class MockPermissionManager:
    """Mock permission manager for testing."""
    
    def __init__(self, allowed_paths=None):
        """Initialize with optional allowed paths."""
        self.allowed_paths = allowed_paths or [os.getcwd()]
    
    def is_path_allowed(self, path):
        """Check if a path is allowed."""
        for allowed_path in self.allowed_paths:
            if str(path).startswith(str(allowed_path)):
                return True
        return False


class TestCommandResult(unittest.TestCase):
    """Test the CommandResult class."""
    
    def test_is_success(self):
        """Test the is_success property."""
        # Success case (return code 0)
        result = CommandResult(return_code=0, stdout="success")
        self.assertTrue(result.is_success)
        
        # Failure case (non-zero return code)
        result = CommandResult(return_code=1, stderr="error")
        self.assertFalse(result.is_success)
    
    def test_format_output(self):
        """Test the format_output method."""
        # Test with all fields
        result = CommandResult(
            return_code=1,
            stdout="standard output",
            stderr="standard error",
            error_message="something went wrong"
        )
        output = result.format_output()
        self.assertIn("Error: something went wrong", output)
        self.assertIn("Exit code: 1", output)
        self.assertIn("STDOUT:\nstandard output", output)
        self.assertIn("STDERR:\nstandard error", output)
        
        # Test success case with only stdout
        result = CommandResult(
            return_code=0,
            stdout="standard output",
            stderr=""
        )
        output = result.format_output()
        self.assertIn("STDOUT:\nstandard output", output)
        self.assertNotIn("STDERR", output)


class TestEnhancedCommandExecutor(unittest.IsolatedAsyncioTestCase):
    """Test the EnhancedCommandExecutor class."""
    
    def setUp(self):
        """Set up test environment."""
        self.perm_manager = MockPermissionManager()
        self.executor = EnhancedCommandExecutor(
            permission_manager=self.perm_manager,
            verbose=True  # Enable verbose mode for testing
        )
        
        # Create a test file
        self.test_dir = tempfile.mkdtemp()
        self.test_file = os.path.join(self.test_dir, "test.txt")
        with open(self.test_file, "w") as f:
            f.write("test content")
    
    def tearDown(self):
        """Clean up test environment."""
        # Remove test directory
        import shutil
        shutil.rmtree(self.test_dir)
    
    async def test_execute_command(self):
        """Test executing a simple command."""
        # Test a simple echo command
        result = await self.executor.execute_command("echo 'hello world'")
        self.assertTrue(result.is_success)
        self.assertEqual(result.return_code, 0)
        self.assertIn("hello world", result.stdout)
        
        # Test a failing command
        result = await self.executor.execute_command("command_that_does_not_exist")
        self.assertFalse(result.is_success)
        self.assertNotEqual(result.return_code, 0)
        self.assertTrue(result.stderr or result.error_message)
    
    async def test_command_blacklist(self):
        """Test command blacklisting."""
        # Test a blacklisted command
        result = await self.executor.execute_command("rm -rf /")
        self.assertFalse(result.is_success)
        self.assertEqual(result.return_code, 1)
        self.assertIn("Command not allowed", result.error_message or "")
        
        # Test allowing a previously blacklisted command
        self.executor.allow_command("rm")
        # We still won't actually run this, just check if it's allowed
        self.assertTrue(self.executor.is_command_allowed("rm -rf test"))
        
        # Add it back to the blacklist
        self.executor.deny_command("rm")
        self.assertFalse(self.executor.is_command_allowed("rm -rf test"))
    
    async def test_working_directory(self):
        """Test command execution with specific working directory."""
        # Create a unique filename in the test directory
        unique_filename = f"unique_file_{os.getpid()}.txt"
        unique_file_path = os.path.join(self.test_dir, unique_filename)
        
        # Run touch command to create the file
        result = await self.executor.execute_command(
            f"touch {unique_filename}",
            cwd=self.test_dir
        )
        self.assertTrue(result.is_success)
        
        # Verify the file was created in the right location
        self.assertTrue(os.path.exists(unique_file_path))
    
    async def test_execute_script(self):
        """Test script execution."""
        # Test a simple bash script
        bash_script = "#!/bin/bash\necho 'Hello from bash'\nexit 0"
        result = await self.executor.execute_script(
            script=bash_script,
            interpreter="bash"
        )
        self.assertTrue(result.is_success)
        self.assertEqual(result.return_code, 0)
        self.assertIn("Hello from bash", result.stdout)
        
        # Test a Python script
        python_script = "print('Hello from Python')\nprint(2 + 2)"
        result = await self.executor.execute_script(
            script=python_script,
            interpreter="python"
        )
        self.assertTrue(result.is_success)
        self.assertEqual(result.return_code, 0)
        self.assertIn("Hello from Python", result.stdout)
        self.assertIn("4", result.stdout)
        
        # Test a failing script
        failing_script = "exit 1"
        result = await self.executor.execute_script(
            script=failing_script,
            interpreter="bash"
        )
        self.assertFalse(result.is_success)
        self.assertEqual(result.return_code, 1)
    
    async def test_execute_script_from_file(self):
        """Test script execution from file."""
        # Test a Python script
        python_script = "import sys\nprint('Hello from Python')\nprint(f'Arguments: {sys.argv[1:]}')"
        args = ["arg1", "arg2"]
        
        result = await self.executor.execute_script_from_file(
            script=python_script,
            language="python",
            args=args
        )
        self.assertTrue(result.is_success)
        self.assertEqual(result.return_code, 0)
        self.assertIn("Hello from Python", result.stdout)
        self.assertIn("Arguments: ['arg1', 'arg2']", result.stdout)
        
        # Test an unsupported language
        result = await self.executor.execute_script_from_file(
            script="console.log('hello')",
            language="unsupported_language"
        )
        self.assertFalse(result.is_success)
        self.assertIn("Unsupported language", result.error_message or "")


if __name__ == "__main__":
    unittest.main()
