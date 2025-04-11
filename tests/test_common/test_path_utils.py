"""Tests for the PathUtils module."""

import os
import unittest
from pathlib import Path

from hanzo_mcp.tools.common.path_utils import PathUtils


class TestPathUtils(unittest.TestCase):
    """Test cases for the PathUtils class."""

    def test_normalize_path(self):
        """Test that normalize_path correctly handles various path formats."""
        # Test tilde expansion
        home_dir = str(Path.home())
        self.assertEqual(PathUtils.normalize_path("~"), home_dir)
        self.assertEqual(PathUtils.normalize_path("~/"), home_dir)
        
        # Test path with tilde
        expected_path = os.path.join(home_dir, "test_dir")
        self.assertEqual(PathUtils.normalize_path("~/test_dir"), expected_path)
        
        # Test relative path
        relative_path = "relative/path"
        absolute_path = os.path.abspath(relative_path)
        self.assertEqual(PathUtils.normalize_path(relative_path), absolute_path)
        
        # Test absolute path remains unchanged (except for normalization)
        absolute_path = "/absolute/path"
        self.assertEqual(PathUtils.normalize_path(absolute_path), absolute_path)
        
        # Test handling of path with double slashes
        double_slash_path = "/path//with//double//slashes"
        normalized_path = "/path/with/double/slashes"
        self.assertEqual(PathUtils.normalize_path(double_slash_path), normalized_path)

    def test_is_dot_directory(self):
        """Test that is_dot_directory correctly identifies dot directories."""
        # Create a temporary directory for testing
        temp_dir = Path(os.path.dirname(os.path.abspath(__file__))) / "temp_test_dir"
        temp_dir.mkdir(exist_ok=True)
        
        # Create a dot directory for testing
        dot_dir = temp_dir / ".dot_dir"
        dot_dir.mkdir(exist_ok=True)
        
        # Create a regular directory for testing
        regular_dir = temp_dir / "regular_dir"
        regular_dir.mkdir(exist_ok=True)
        
        try:
            # Test dot directory detection
            self.assertTrue(PathUtils.is_dot_directory(dot_dir))
            
            # Test regular directory not detected as dot directory
            self.assertFalse(PathUtils.is_dot_directory(regular_dir))
            
            # Test that non-directories return False
            non_dir = temp_dir / "non_dir.txt"
            with open(non_dir, "w") as f:
                f.write("test")
            self.assertFalse(PathUtils.is_dot_directory(non_dir))
            
        finally:
            # Clean up test directories
            if non_dir.exists():
                non_dir.unlink()
            if dot_dir.exists():
                dot_dir.rmdir()
            if regular_dir.exists():
                regular_dir.rmdir()
            if temp_dir.exists():
                temp_dir.rmdir()


if __name__ == "__main__":
    unittest.main()
