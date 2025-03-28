"""Tests for the cursor_rules module."""

import os
import tempfile
from unittest.mock import MagicMock

import pytest

# Check if yaml is available
try:
    import yaml
    has_yaml = True
except ImportError:
    has_yaml = False

from hanzo_mcp.tools.cursor_rules import CursorRulesHandler


class TestCursorRulesHandler:
    """Test the CursorRulesHandler class."""

    @pytest.fixture
    def handler(self):
        """Create a CursorRulesHandler instance for testing."""
        permission_manager = MagicMock()
        permission_manager.is_path_allowed.return_value = True
        return CursorRulesHandler(permission_manager)

    def test_is_path_allowed(self, handler):
        """Test the is_path_allowed method."""
        # The mocked permission manager always returns True
        assert handler.is_path_allowed("/some/path") is True

    def test_find_preinstalled_rules(self, handler):
        """Test finding pre-installed rules."""
        # This should find rules in the package
        rules = handler.find_preinstalled_rules()
        assert len(rules) > 0
        # At least some of these should be .rules files
        assert any(rule.endswith(".rules") for rule in rules)

    def test_find_preinstalled_rules_with_tech(self, handler):
        """Test finding pre-installed rules for a specific technology."""
        # This should find Python rules
        rules = handler.find_preinstalled_rules("python")
        assert len(rules) > 0
        # All of these should contain "python" in the path
        assert all("python" in rule.lower() for rule in rules)

    @pytest.mark.skipif(not has_yaml, reason="PyYAML not installed")
    def test_load_rule_file(self, handler):
        """Test loading a rule file."""
        # Create a temporary rule file
        with tempfile.NamedTemporaryFile(suffix=".rules", mode="w+", delete=False) as f:
            f.write("""---
name: Test Rule
description: Test rule file
technologies:
  - Python
  - Testing
---

# Test Rule Content
This is a test rule file.
""")
            temp_path = f.name

        try:
            # Load the rule file
            rule = handler.load_rule_file(temp_path)
            
            # Check the rule content
            assert "error" not in rule
            assert rule["filename"] == os.path.basename(temp_path)
            assert "Python" in rule["technologies"]
            assert "Testing" in rule["technologies"]
            assert "Test Rule Content" in rule["content"]
            assert rule["frontmatter"]["name"] == "Test Rule"
        finally:
            # Clean up
            os.unlink(temp_path)

    @pytest.mark.skipif(not has_yaml, reason="PyYAML not installed")
    def test_search_rules(self, handler):
        """Test searching for rules."""
        # Search for Python rules
        rules = handler.search_rules("python")
        assert len(rules) > 0
        
        # All of these should be related to Python
        for rule in rules:
            assert (
                "python" in rule["path"].lower() or
                any("python" in tech.lower() for tech in rule["technologies"])
            )
