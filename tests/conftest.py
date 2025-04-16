"""Pytest configuration for the Hanzo MCP project."""

import pytest
import os

# Set environment variables for testing
os.environ["TEST_MODE"] = "1"

# Configure pytest
def pytest_configure(config):
    """Configure pytest."""
    # Register asyncio marker
    config.addinivalue_line(
        "markers", "asyncio: mark test as using asyncio"
    )
    
    # Configure pytest-asyncio
    config._inicache["asyncio_default_fixture_loop_scope"] = "function"
