"""Tests for the logging configuration module.

This module contains tests for the logging configuration module.
"""

import logging
import os
import sys
from io import StringIO
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from hanzo_mcp.tools.common.logging_config import setup_logging, get_log_files, get_current_log_file


def test_setup_logging_levels():
    """Test that the logging level is set correctly."""
    # Test with different log levels
    for level in ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]:
        with patch("logging.basicConfig") as mock_basic_config:
            setup_logging(log_level=level, log_to_file=False, testing=True)
            # Get the numeric level that was passed to basicConfig
            numeric_level = mock_basic_config.call_args[1]["level"]
            # Convert expected level string to numeric level
            expected_level = getattr(logging, level)
            assert numeric_level == expected_level, f"Level {level} not set correctly"


def test_setup_logging_with_invalid_level():
    """Test that an invalid log level raises an exception."""
    with pytest.raises(ValueError):
        setup_logging(log_level="INVALID_LEVEL", testing=True)


def test_console_handler_configuration():
    """Test that the console handler is configured correctly when enabled."""
    # Test with console logging explicitly enabled
    with patch("logging.StreamHandler") as mock_stream_handler,\
         patch("logging.basicConfig") as mock_basic_config,\
         patch("logging.getLogger") as mock_get_logger:
        # Setup mocks
        mock_handler = MagicMock()
        mock_handler.level = logging.INFO  # Set the level attribute properly
        mock_stream_handler.return_value = mock_handler
        
        # Mock the root logger
        mock_logger = MagicMock()
        mock_get_logger.return_value = mock_logger
        
        # Explicitly enable console logging
        setup_logging(log_to_file=False, log_to_console=True, testing=True)
        
        # Check that the stream handler was created with sys.stderr
        mock_stream_handler.assert_called_once_with(sys.stderr)
        # Check that the handler has a formatter
        assert mock_handler.setFormatter.called


def test_console_logging_disabled_by_default():
    """Test that console logging is disabled by default."""
    with patch("logging.StreamHandler") as mock_stream_handler,\
         patch("logging.basicConfig") as mock_basic_config,\
         patch("logging.getLogger") as mock_get_logger:
        # Mock the root logger
        mock_logger = MagicMock()
        mock_get_logger.return_value = mock_logger
        
        # Call with default parameters for console logging
        setup_logging(log_to_file=False, testing=True)  # log_to_console defaults to False
        
        # Check that the stream handler was not created
        assert not mock_stream_handler.called


def test_console_logging_never_used_with_stdio_transport():
    """Test that console logging is never used with stdio transport, even if explicitly enabled."""
    with patch("logging.StreamHandler") as mock_stream_handler,\
         patch("logging.basicConfig") as mock_basic_config,\
         patch("logging.getLogger") as mock_get_logger:
        # Mock the root logger
        mock_logger = MagicMock()
        mock_get_logger.return_value = mock_logger
        
        # Explicitly try to enable console logging, but use stdio transport
        setup_logging(log_to_file=False, log_to_console=True, transport="stdio", testing=True)
        
        # Check that the stream handler was still not created (stdio transport takes precedence)
        assert not mock_stream_handler.called


# Modify how we test the file handler to avoid patching datetime.now
def test_file_handler_configuration_simpler():
    """Test that the file handler is configured correctly using a simpler approach."""
    # Mock Path.home() to use a test directory
    with patch("pathlib.Path.home", return_value=Path(".")), \
         patch("pathlib.Path.mkdir") as mock_mkdir, \
         patch("logging.FileHandler") as mock_file_handler, \
         patch("logging.basicConfig") as mock_basic_config, \
         patch("logging.getLogger") as mock_get_logger:
        
        mock_handler = MagicMock()
        mock_handler.level = logging.INFO  # Set the level attribute properly
        mock_file_handler.return_value = mock_handler
        
        # Mock the root logger
        mock_logger = MagicMock()
        mock_get_logger.return_value = mock_logger
        
        setup_logging(log_to_file=True, testing=False)
        
        # Check that the logs directory was created
        mock_mkdir.assert_called_once_with(parents=True, exist_ok=True)
        
        # Check that the file handler was created
        assert mock_file_handler.called
        
        # Check that the handler has a formatter
        assert mock_handler.setFormatter.called


def test_disable_file_logging():
    """Test that file logging can be disabled."""
    with patch("logging.FileHandler") as mock_file_handler,\
         patch("logging.basicConfig") as mock_basic_config,\
         patch("logging.getLogger") as mock_get_logger:
        # Mock the root logger
        mock_logger = MagicMock()
        mock_get_logger.return_value = mock_logger
        
        setup_logging(log_to_file=False, testing=True)
        
        # Check that the file handler was not created
        assert not mock_file_handler.called


@pytest.mark.skip(reason="Cannot patch datetime.now in Python 3.13+")
def test_file_handler_configuration_with_date():
    """Test that the file handler is configured correctly with date patching.
    
    Note: This test is skipped as datetime.now cannot be patched in Python 3.13+.
    """
    test_log_dir = Path("test_logs")
    test_log_file = test_log_dir / "test.log"
    # Implementation omitted since this test is skipped
    pass


@pytest.mark.skipif(os.environ.get("CI") == "true", reason="Skipping in CI environment")
def test_get_log_files():
    """Test that the log files can be retrieved."""
    # This test assumes that the log directory exists
    # If it doesn't, the function should return an empty list
    log_files = get_log_files()
    
    # Either the directory doesn't exist, or we have a list of files
    assert isinstance(log_files, list)


@pytest.mark.skipif(os.environ.get("CI") == "true", reason="Skipping in CI environment")
def test_get_current_log_file():
    """Test that the current log file can be retrieved."""
    # This test assumes that the log directory exists
    # If it doesn't, the function should return None
    log_file = get_current_log_file()
    
    # Either the file doesn't exist, or we have a valid path
    assert log_file is None or isinstance(log_file, str)
