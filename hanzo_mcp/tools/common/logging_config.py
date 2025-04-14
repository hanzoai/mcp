"""Logging configuration for Hanzo MCP.

This module sets up logging for the Hanzo MCP project.
"""

import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional


def setup_logging(
    log_level: str = "INFO", 
    log_to_file: bool = True, 
    log_to_console: bool = True,
    transport: Optional[str] = None,
    testing: bool = False
) -> None:
    """Set up logging configuration.
    
    Args:
        log_level: The logging level ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
        log_to_file: Whether to log to a file in addition to the console
        log_to_console: Whether to log to the console
        transport: The transport mechanism being used ("stdio" or "sse")
        testing: Set to True to disable file operations for testing
    """
    # Convert string log level to logging constant
    numeric_level = getattr(logging, log_level.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"Invalid log level: {log_level}")
    
    # Create logs directory if needed
    log_dir = Path.home() / ".hanzo" / "logs"
    if log_to_file and not testing:
        log_dir.mkdir(parents=True, exist_ok=True)
    
    # Generate log filename based on current date
    current_time = datetime.now().strftime("%Y-%m-%d")
    log_file = log_dir / f"hanzo-mcp-{current_time}.log"
    
    # Base configuration
    handlers = []
    
    # Console handler - Always use stderr to avoid interfering with stdio transport
    # Disable console logging when using stdio transport to avoid protocol corruption
    if log_to_console and (transport != "stdio"):
        console = logging.StreamHandler(sys.stderr)
        console.setLevel(numeric_level)
        console_formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        console.setFormatter(console_formatter)
        handlers.append(console)
    
    # File handler (if enabled)
    if log_to_file and not testing:
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(numeric_level)
        file_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s'
        )
        file_handler.setFormatter(file_formatter)
        handlers.append(file_handler)
    
    # Configure root logger
    logging.basicConfig(
        level=numeric_level,
        handlers=handlers,
        force=True  # Overwrite any existing configuration
    )
    
    # Set specific log levels for third-party libraries
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)
    
    # Log startup message
    root_logger = logging.getLogger()
    root_logger.info(f"Logging initialized at level {log_level}")
    if log_to_file and not testing:
        root_logger.info(f"Log file: {log_file}")
    if not log_to_console or transport == "stdio":
        root_logger.info("Console logging disabled")


def get_log_files() -> list[str]:
    """Get a list of all log files.
    
    Returns:
        List of log file paths
    """
    log_dir = Path.home() / ".hanzo" / "logs"
    if not log_dir.exists():
        return []
    
    log_files = [str(f) for f in log_dir.glob("hanzo-mcp-*.log")]
    return sorted(log_files, reverse=True)


def get_current_log_file() -> Optional[str]:
    """Get the path to the current log file.
    
    Returns:
        The path to the current log file, or None if no log file exists
    """
    log_dir = Path.home() / ".hanzo" / "logs"
    if not log_dir.exists():
        return None
    
    current_time = datetime.now().strftime("%Y-%m-%d")
    log_file = log_dir / f"hanzo-mcp-{current_time}.log"
    
    if log_file.exists():
        return str(log_file)
    return None
