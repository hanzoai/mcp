"""Pytest configuration file for MCP tests.

This module contains shared fixtures and configurations for testing the MCP framework.
"""

import os
import json
import tempfile
import shutil
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch, AsyncMock

from hanzo_mcp.external.mcp_manager import ExternalMCPServer, ExternalMCPServerManager
from hanzo_mcp.tools.mcp_manager import MCPServer, MCPServerManager
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.common.context import DocumentContext, ToolContext
from hanzo_mcp.tools.project.analysis import ProjectAnalyzer, ProjectManager, ProjectAnalysis

# Register asyncio mark for pytest
def pytest_configure(config):
    config.addinivalue_line(
        "markers", "asyncio: mark test to run using asyncio"
    )

# Configure anyio to use only asyncio backend
pytest.mark.asyncio = pytest.mark.anyio(backends="asyncio")

# Skip tests with trio backend
def pytest_generate_tests(metafunc):
    if "anyio_backend" in metafunc.fixturenames:
        try:
            if hasattr(metafunc.config.option, "anyio_backends") and not metafunc.config.option.anyio_backends:
                # Only run with asyncio
                metafunc.parametrize("anyio_backend", ["asyncio"], scope="function")
        except AttributeError:
            # If option doesn't exist, just run with asyncio
            metafunc.parametrize("anyio_backend", ["asyncio"], scope="function")

# Skip any already collected tests that use trio backend
def pytest_collection_modifyitems(config, items):
    selected_items = []
    deselected_items = []
    
    for item in items:
        # Skip tests with trio in the name
        if 'trio' in item.name and 'asyncio' not in item.name:
            deselected_items.append(item)
        else:
            selected_items.append(item)
    
    config.hook.pytest_deselected(items=deselected_items)
    items[:] = selected_items


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    # Clean up
    shutil.rmtree(temp_dir)


@pytest.fixture
def temp_file():
    """Create a temporary file for testing."""
    with tempfile.NamedTemporaryFile(mode="w+", delete=False) as temp_file:
        file_path = temp_file.name
        yield file_path
        # Clean up
        if os.path.exists(file_path):
            os.unlink(file_path)


@pytest.fixture
def test_file(temp_dir):
    """Create a test file for document tests."""
    file_path = os.path.join(temp_dir, "test.txt")
    with open(file_path, "w") as f:
        f.write("This is a test file content.")
    return file_path


@pytest.fixture
def setup_allowed_path(temp_dir, permission_manager):
    """Set up an allowed path for file operations testing."""
    permission_manager.add_allowed_path(temp_dir)
    
    # Create a test file
    test_file_path = os.path.join(temp_dir, "test.txt")
    with open(test_file_path, "w") as f:
        f.write("This is a test file content.")
    
    return temp_dir


@pytest.fixture
def test_project_dir(temp_dir):
    """Create a test project directory with sample files."""
    # Create project structure
    os.makedirs(os.path.join(temp_dir, "src"), exist_ok=True)
    os.makedirs(os.path.join(temp_dir, "tests"), exist_ok=True)
    os.makedirs(os.path.join(temp_dir, "docs"), exist_ok=True)
    
    # Create some Python files
    with open(os.path.join(temp_dir, "src", "main.py"), "w") as f:
        f.write("def main():\n    print('Hello, world!')\n\nif __name__ == '__main__':\n    main()")
    
    with open(os.path.join(temp_dir, "tests", "test_main.py"), "w") as f:
        f.write("import unittest\n\nclass TestMain(unittest.TestCase):\n    def test_main(self):\n        pass")
    
    # Create a requirements.txt file
    with open(os.path.join(temp_dir, "requirements.txt"), "w") as f:
        f.write("pytest==7.3.1\nmcp>=1.3.0")
    
    # Create a README.md file
    with open(os.path.join(temp_dir, "README.md"), "w") as f:
        f.write("# Test Project\n\nThis is a test project.")
    
    return temp_dir


@pytest.fixture
def temp_config_file():
    """Create a temporary config file for testing."""
    with tempfile.NamedTemporaryFile(mode="w+", delete=False) as temp_file:
        file_path = temp_file.name
        yield file_path
        # Clean up
        if os.path.exists(file_path):
            os.unlink(file_path)


@pytest.fixture
def mock_external_mcp_server():
    """Create a mock ExternalMCPServer for testing."""
    # Create a mock server
    server = MagicMock(spec=ExternalMCPServer)
    server.name = "test_server"
    server.command = "test_command"
    server.args = ["arg1", "arg2"]
    server.enabled = True
    server.description = "Test server"
    server._process = None
    
    # Set up mock methods
    server.start.return_value = True
    server.stop.return_value = True
    server.is_running.return_value = True
    server.send_request.return_value = '{"result": "success"}'
    
    return server


@pytest.fixture
def mock_external_mcp_manager(mock_external_mcp_server):
    """Create a mock ExternalMCPServerManager for testing."""
    with patch.object(ExternalMCPServerManager, "_load_servers"):
        manager = ExternalMCPServerManager()
        manager.servers = {"test_server": mock_external_mcp_server}
        return manager


@pytest.fixture
def mock_mcp_server():
    """Create a mock MCPServer for testing."""
    # Create a mock server
    server = MagicMock(spec=MCPServer)
    server.name = "test_server"
    server.command = "test_command"
    server.args = ["arg1", "arg2"]
    server.env = {"ENV_VAR": "value"}
    server.description = "Test server"
    server.process = None
    server.running = False
    server.tools = {}
    server.socket_path = None
    server.pid = None
    server.start_time = None
    server.last_error = None
    
    # Set up mock methods
    server.get_full_command.return_value = ["test_command", "arg1", "arg2"]
    server.get_env.return_value = {"ENV_VAR": "value"}
    server.to_dict.return_value = {
        "name": "test_server",
        "description": "Test server",
        "command": "test_command",
        "args": ["arg1", "arg2"],
        "running": False,
        "pid": None,
        "start_time": None,
        "tool_count": 0,
        "tools": []
    }
    
    return server


@pytest.fixture
def mock_mcp_manager(mock_mcp_server):
    """Create a mock MCPServerManager for testing."""
    with patch.object(MCPServerManager, "_load_config"):
        manager = MCPServerManager(auto_load=False)
        manager.servers = {"test_server": mock_mcp_server}
        return manager


@pytest.fixture
def external_servers_config():
    """Sample external servers configuration for testing."""
    return {
        "servers": [
            {
                "name": "test1",
                "command": "echo",
                "args": ["hello"],
                "enabled": True,
                "description": "Test server 1",
            },
            {
                "name": "test2",
                "command": "python",
                "args": ["-m", "json_server"],
                "enabled": True,
                "description": "Test server 2",
            },
            {
                "name": "test3",
                "command": "nonexistent_command",
                "args": [],
                "enabled": True,
                "description": "Server with nonexistent command",
            },
        ]
    }


@pytest.fixture
def mcp_servers_config():
    """Sample MCP servers configuration for testing."""
    return {
        "browser-use": {
            "enabled": "true",
            "command": "uvx",
            "args": ["mcp-server-browser-use"],
            "description": "Automates browser interactions",
            "env": {
                "BROWSER_HEADLESS": "true",
                "CHROME_PATH": "/path/to/chrome"
            }
        },
        "computer-use": {
            "enabled": "false",
            "command": "uvx",
            "args": ["mcp-server-computer-use"],
            "description": "Provides full computer access",
            "env": {}
        },
        "slack": {
            "enabled": "auto",
            "command": "uvx",
            "args": ["mcp-server-slack"],
            "description": "Integrates with Slack",
            "env": {
                "SLACK_API_TOKEN": ""
            },
            "auto_enable_env": "SLACK_API_TOKEN"
        }
    }


@pytest.fixture
def permission_manager(temp_dir):
    """Create a PermissionManager with test permissions."""
    manager = PermissionManager()
    
    # Add temporary directory to allowed paths
    manager.add_allowed_path(temp_dir)
    
    # Create a test excluded directory within the temp directory
    excluded_dir = os.path.join(temp_dir, "excluded")
    os.makedirs(excluded_dir, exist_ok=True)
    manager.exclude_path(excluded_dir)
    
    return manager


@pytest.fixture
def mcp_context():
    """Create a mock MCP Context for testing."""
    context = MagicMock()
    context.request_id = "test-request-id"
    context.client_id = "test-client-id"
    context.info = AsyncMock()
    context.debug = AsyncMock()
    context.warning = AsyncMock()
    context.error = AsyncMock()
    context.report_progress = AsyncMock()
    context.read_resource = AsyncMock()
    return context


@pytest.fixture
def document_context(temp_dir):
    """Create a DocumentContext for testing."""
    context = DocumentContext()
    
    # Add temporary directory to allowed paths
    context.add_allowed_path(temp_dir)
    
    return context


@pytest.fixture
def command_executor(permission_manager):
    """Create a CommandExecutor for testing."""
    from hanzo_mcp.tools.shell.command_executor import CommandExecutor
    return CommandExecutor(permission_manager)


@pytest.fixture
def project_analyzer(command_executor):
    """Create a ProjectAnalyzer for testing."""
    return ProjectAnalyzer(command_executor)


@pytest.fixture
def project_manager(document_context, permission_manager, project_analyzer):
    """Create a ProjectManager for testing."""
    return ProjectManager(document_context, permission_manager, project_analyzer)


@pytest.fixture
def project_analysis(project_manager, project_analyzer, permission_manager):
    """Create a ProjectAnalysis for testing."""
    return ProjectAnalysis(project_manager, project_analyzer, permission_manager)
