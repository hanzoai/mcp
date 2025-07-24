"""Pytest configuration for the Hanzo AI project."""

import os
import tempfile
import pytest
from unittest.mock import MagicMock, AsyncMock
from pathlib import Path

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


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        yield tmp_dir


@pytest.fixture
def test_file(temp_dir):
    """Create a test file in the temporary directory."""
    file_path = os.path.join(temp_dir, "test.txt")
    with open(file_path, "w") as f:
        f.write("This is a test file content.")
    return file_path


@pytest.fixture
def test_notebook(temp_dir):
    """Create a test notebook in the temporary directory."""
    notebook_path = os.path.join(temp_dir, "test.ipynb")
    notebook_content = {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": ["# Test cell 1\n", "print('Hello, world!')"]
            },
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": ["## Markdown cell\n", "This is a test."]
            }
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3"
            }
        },
        "nbformat": 4,
        "nbformat_minor": 4
    }
    
    import json
    with open(notebook_path, "w") as f:
        json.dump(notebook_content, f)
    
    return notebook_path


@pytest.fixture
def permission_manager():
    """Create a permission manager for testing."""
    from hanzo_mcp.tools.common.permissions import PermissionManager
    manager = PermissionManager()
    manager.add_allowed_path("/")  # Allow all paths for testing
    return manager


@pytest.fixture
def tool_context(mcp_context):
    """Create a tool context for testing."""
    from hanzo_mcp.tools.common.context import ToolContext
    return ToolContext(mcp_context)


@pytest.fixture
def mcp_context():
    """Create a mock MCP context for testing."""
    context = MagicMock()
    context.request_id = "test-request-id"
    context.client_id = "test-client-id"
    context.info = AsyncMock()
    context.debug = AsyncMock()
    context.warning = AsyncMock()
    context.error = AsyncMock()
    context.report_progress = AsyncMock()
    context.read_resource = AsyncMock()
    context.get_tools = AsyncMock(return_value=[])
    return context


@pytest.fixture
def command_executor(permission_manager):  
    """Create a command executor for testing."""
    from hanzo_mcp.tools.shell.bash_session_executor import BashSessionExecutor
    return BashSessionExecutor(permission_manager=permission_manager)


@pytest.fixture
def mock_server():
    """Create a mock server for testing."""
    server = MagicMock()
    server.tool = lambda: lambda f: f
    return server


@pytest.fixture
def project_dir(temp_dir):
    """Create a simple Python project structure for testing."""
    # Create a main Python file
    main_py = os.path.join(temp_dir, "main.py")
    with open(main_py, "w") as f:
        f.write("def main():\n    print('Hello, world!')\n\nif __name__ == '__main__':\n    main()")
    
    # Create a requirements.txt file
    requirements_txt = os.path.join(temp_dir, "requirements.txt")
    with open(requirements_txt, "w") as f:
        f.write("requests==2.31.0\npytest==7.3.1\n")
    
    # Create a setup.py file
    setup_py = os.path.join(temp_dir, "setup.py")
    with open(setup_py, "w") as f:
        f.write("from setuptools import setup\n\nsetup(\n    name='test-project',\n    version='0.1.0',\n    packages=['test_project'],\n)")
    
    # Create a test_project directory
    test_project_dir = os.path.join(temp_dir, "test_project")
    os.makedirs(test_project_dir, exist_ok=True)
    
    # Create an __init__.py file
    init_py = os.path.join(test_project_dir, "__init__.py")
    with open(init_py, "w") as f:
        f.write("# Test project package\n")
    
    return temp_dir

@pytest.fixture
def test_project_dir(project_dir):
    """Alias for project_dir fixture."""
    return project_dir


# Project analysis tools have been removed based on git status
# @pytest.fixture
# def project_analyzer(command_executor):
#     """Create a project analyzer for testing."""
#     from hanzo_mcp.tools.project.analysis import ProjectAnalyzer
#     return ProjectAnalyzer(command_executor)
#     
# @pytest.fixture  
# def project_manager(document_context, permission_manager, project_analyzer):
#     """Create a project manager for testing."""
#     from hanzo_mcp.tools.project.analysis import ProjectManager
#     return ProjectManager(document_context, permission_manager, project_analyzer)



@pytest.fixture
def js_project_dir(temp_dir):
    """Create a simple JavaScript project structure for testing."""
    # Create a main JavaScript file
    main_js = os.path.join(temp_dir, "main.js")
    with open(main_js, "w") as f:
        f.write("function main() {\n  console.log('Hello, world!');\n}\n\nmain();")
    
    # Create a package.json file
    package_json = os.path.join(temp_dir, "package.json")
    with open(package_json, "w") as f:
        f.write('{\n  "name": "test-project",\n  "version": "1.0.0",\n  "dependencies": {\n    "express": "^4.17.1"\n  }\n}')
    
    # Create an index.html file
    index_html = os.path.join(temp_dir, "index.html")
    with open(index_html, "w") as f:
        f.write('<!DOCTYPE html>\n<html>\n<head>\n  <title>Test Project</title>\n</head>\n<body>\n  <h1>Test Project</h1>\n  <script src="main.js"></script>\n</body>\n</html>')
    
    return temp_dir