"""Pytest configuration for hanzo_mcp tests."""

import os
import pytest
from unittest.mock import MagicMock

# Set test mode
os.environ["MCP_TEST_MODE"] = "1"

from hanzo_mcp.tools.common.context import DocumentContext, ToolContext
from hanzo_mcp.tools.common.permissions import PermissionManager


@pytest.fixture
def document_context() -> DocumentContext:
    """Create a DocumentContext instance for testing."""
    return DocumentContext()


@pytest.fixture
def permission_manager() -> PermissionManager:
    """Create a PermissionManager instance for testing."""
    return PermissionManager()


@pytest.fixture
def tool_context() -> ToolContext:
    """Create a ToolContext instance for testing."""
    context = MagicMock()
    return ToolContext(context)
