"""Pytest configuration for the Hanzo MCP project."""

import pytest

# Set default fixture scope for asyncio
pytest_plugins = ["pytest_asyncio"]

def pytest_configure(config):
    """Configure pytest."""
    config.addinivalue_line(
        "markers", "asyncio: mark test as using asyncio"
    )
