"""Tests for parameter validation in MCP Claude Code tools."""

from mcp_claude_code.tools.common.validation import (
    validate_parameter,
    validate_parameters,
    validate_path_parameter,
)


def test_validate_parameter_with_none():
    """Test validation of None parameters."""
    result = validate_parameter(None, "test_param")
    assert result.is_error
    assert "test_param" in result.error_message
    assert "None" in result.error_message


def test_validate_parameter_with_empty_string():
    """Test validation of empty string parameters."""
    result = validate_parameter("", "test_param")
    assert result.is_error
    assert "test_param" in result.error_message
    assert "empty string" in result.error_message

    # Test with whitespace only
    result = validate_parameter("  ", "test_param")
    assert result.is_error
    assert "test_param" in result.error_message

    # Test with allow_empty=True
    result = validate_parameter("", "test_param", allow_empty=True)
    assert not result.is_error


def test_validate_parameter_with_empty_collections():
    """Test validation of empty collections."""
    # Empty list
    result = validate_parameter([], "test_list")
    assert result.is_error
    assert "test_list" in result.error_message
    assert "empty list" in result.error_message

    # Empty dict
    result = validate_parameter({}, "test_dict")
    assert result.is_error
    assert "test_dict" in result.error_message
    assert "empty dict" in result.error_message

    # Allow empty collections
    result = validate_parameter([], "test_list", allow_empty=True)
    assert not result.is_error


def test_validate_parameter_with_valid_values():
    """Test validation of valid parameters."""
    # Valid string
    result = validate_parameter("hello", "test_param")
    assert not result.is_error

    # Valid list with items
    result = validate_parameter([1, 2, 3], "test_list")
    assert not result.is_error

    # Valid dict with items
    result = validate_parameter({"key": "value"}, "test_dict")
    assert not result.is_error

    # Valid zero value
    result = validate_parameter(0, "test_zero")
    assert not result.is_error

    # Valid boolean False
    result = validate_parameter(False, "test_bool")
    assert not result.is_error


def test_validate_path_parameter():
    """Test validation of path parameters."""
    # None path
    result = validate_path_parameter(None)
    assert result.is_error
    assert "path" in result.error_message.lower()  # Default name is 'path'

    # Empty path
    result = validate_path_parameter("")
    assert result.is_error
    assert "empty string" in result.error_message

    # Whitespace only path
    result = validate_path_parameter("  ")
    assert result.is_error

    # Valid path
    result = validate_path_parameter("/valid/path")
    assert not result.is_error

    # Custom parameter name
    result = validate_path_parameter(None, "project_dir")
    assert result.is_error
    assert "project_dir" in result.error_message


def test_validate_parameters():
    """Test validation of multiple parameters."""
    # All valid parameters
    result = validate_parameters(name="test", age=30, items=[1, 2, 3])
    assert not result.is_error

    # One invalid parameter
    result = validate_parameters(name="test", age=None, items=[1, 2, 3])
    assert result.is_error
    assert "age" in result.error_message

    # Multiple invalid parameters, but only first is reported
    result = validate_parameters(name=None, age=None, items=[])
    assert result.is_error
    # The error message should contain one of the invalid parameters
    assert any(param in result.error_message for param in ["name", "age", "items"])
