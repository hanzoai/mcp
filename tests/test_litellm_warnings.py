#!/usr/bin/env python
"""Test that litellm deprecation warnings are properly suppressed."""

import subprocess
import sys
import os


def test_no_pydantic_warnings():
    """Test that running uvx hanzo-mcp doesn't show Pydantic deprecation warnings."""
    # Run the command and capture stderr
    result = subprocess.run(
        [sys.executable, "-m", "hanzo_mcp.cli", "--help"],
        capture_output=True,
        text=True
    )
    
    # Check for deprecation warnings in stderr
    assert "PydanticDeprecatedSince20" not in result.stderr, \
        f"Pydantic deprecation warning found in stderr: {result.stderr}"
    
    # Check that the command succeeded
    assert result.returncode == 0, f"Command failed with return code {result.returncode}"
    
    # Check that help text is shown
    assert "MCP server implementing Hanzo AI capabilities" in result.stdout


def test_agent_tool_no_warnings():
    """Test that importing agent tools doesn't produce warnings."""
    # Create a test script that imports agent tools
    test_script = '''
import warnings
import sys

# Capture warnings
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    
    # Import agent tools (which imports litellm)
    from hanzo_mcp.tools.agent import register_agent_tools
    
    # Check for deprecation warnings
    deprecation_warnings = [warning for warning in w if issubclass(warning.category, DeprecationWarning)]
    
    if deprecation_warnings:
        print("DEPRECATION WARNINGS FOUND:", file=sys.stderr)
        for warning in deprecation_warnings:
            print(f"  {warning.category.__name__}: {warning.message}", file=sys.stderr)
        sys.exit(1)
    else:
        print("No deprecation warnings found")
        sys.exit(0)
'''
    
    # Run the test script
    result = subprocess.run(
        [sys.executable, "-c", test_script],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": os.path.dirname(os.path.dirname(__file__))}
    )
    
    # Check that no warnings were found
    assert result.returncode == 0, f"Deprecation warnings found: {result.stderr}"
    assert "No deprecation warnings found" in result.stdout


if __name__ == "__main__":
    test_no_pydantic_warnings()
    test_agent_tool_no_warnings()
    print("✅ All litellm warning tests passed!")