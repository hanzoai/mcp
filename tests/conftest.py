"""Test fixtures for the Hanzo MCP project."""

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hanzo_mcp.tools.common.context import DocumentContext, ToolContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.project.analysis import ProjectAnalyzer
from hanzo_mcp.tools.shell.command_executor import CommandExecutor

# Simplifying asyncio test support

# Register asyncio marker
def pytest_configure(config):
    config.addinivalue_line("markers", "asyncio: mark test as using asyncio")

# Add support for asyncio tests without pytest-asyncio plugin
# This uses a direct approach to handle coroutine functions
@pytest.hookimpl(trylast=True)
def pytest_runtest_setup(item):
    """Set up async tests to run without pytest-asyncio."""
    if asyncio.iscoroutinefunction(item.obj):
        # This makes the test show as skipped but doesn't attempt to run it
        # We'll handle it in pytest_runtest_call instead
        pass

@pytest.hookimpl(trylast=True)
def pytest_runtest_call(item):
    """Run async test functions without pytest-asyncio."""
    if asyncio.iscoroutinefunction(item.obj):
        # Get the function arguments
        funcargs = {arg: item.funcargs[arg] for arg in item.funcargs}
        
        # Create and set up a new event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # Run the coroutine function
            coro = item.obj(**funcargs)
            loop.run_until_complete(coro)
            # Indicate successful completion, preventing the test from being marked as skipped
            return True
        finally:
            # Clean up the loop
            loop.close()
            asyncio.set_event_loop(None)


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        yield temp_dir


@pytest.fixture
def test_file(temp_dir):
    """Create a test file in the temporary directory."""
    test_file_path = Path(temp_dir) / "test_file.txt"
    test_content = "This is a test file content.\nWith multiple lines.\n"

    with open(test_file_path, "w") as f:
        f.write(test_content)

    return str(test_file_path)


@pytest.fixture
def test_project_dir(temp_dir):
    """Create a simple test project structure."""
    project_dir = Path(temp_dir) / "test_project"
    project_dir.mkdir()

    # Create Python files
    py_dir = project_dir / "src" / "module"
    py_dir.mkdir(parents=True)

    with open(py_dir / "__init__.py", "w") as f:
        f.write("# Module init\n")

    with open(py_dir / "main.py", "w") as f:
        f.write("import os\n\ndef main():\n    print('Hello, world!')\n")

    # Create requirements.txt
    with open(project_dir / "requirements.txt", "w") as f:
        f.write("pytest==7.3.1\nmcp>=1.3.0\nhttpx>=0.27\n")

    # Create README
    with open(project_dir / "README.md", "w") as f:
        f.write("# Test Project\n\nThis is a test project for testing.\n")

    return str(project_dir)


@pytest.fixture
def permission_manager():
    """Create a permission manager with a test path allowed."""
    manager = PermissionManager()
    return manager


@pytest.fixture
def document_context():
    """Create a document context for testing."""
    return DocumentContext()


@pytest.fixture
def mcp_context():
    """Mock MCP context for testing."""
    mock_context = MagicMock()
    mock_context.info = AsyncMock()
    mock_context.error = AsyncMock()
    mock_context.warning = AsyncMock()
    mock_context.debug = AsyncMock()
    mock_context.report_progress = AsyncMock()
    mock_context.read_resource = AsyncMock()
    mock_context.request_id = "test-request-id"
    mock_context.client_id = "test-client-id"
    return mock_context


@pytest.fixture
def tool_context(mcp_context):
    """Create a tool context for testing."""
    return ToolContext(mcp_context)


@pytest.fixture
def command_executor(permission_manager):
    """Create a command executor for testing."""
    return CommandExecutor(permission_manager)


@pytest.fixture
def project_analyzer(command_executor):
    """Create a project analyzer for testing."""
    return ProjectAnalyzer(command_executor)


@pytest.fixture
def project_manager(document_context, permission_manager, project_analyzer):
    """Create a project manager for testing."""
    from hanzo_mcp.tools.project.analysis import ProjectManager

    return ProjectManager(document_context, permission_manager, project_analyzer)
