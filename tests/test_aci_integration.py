"""Tests for hanzo_aci integration in ComputerUseInterface."""

import json
from unittest.mock import patch, MagicMock, AsyncMock

import pytest

from hanzo_mcp.tools.computer_use import (
    ComputerUseInterface,
    get_computer_capabilities,
    open_application,
    take_screenshot,
    file_explorer,
    clipboard_get,
    clipboard_set,
    vector_search_query,
    find_symbols
)


@pytest.fixture
def mock_aci_computer():
    """Create a mock for the hanzo_aci computer interface."""
    mock_computer = AsyncMock()
    
    # Configure basic methods
    mock_computer.is_available.return_value = True
    mock_computer.ensure_running.return_value = {"success": True, "message": "ACI ready"}
    mock_computer.get_capabilities.return_value = {
        "available": True,
        "operations": ["open_application", "take_screenshot", "file_explorer", 
                      "clipboard_get", "clipboard_set", "run_command"],
        "backend": "native"
    }
    
    # Configure operation methods
    mock_computer.execute_operation.return_value = {"success": True, "result": "operation executed"}
    mock_computer.open_application.return_value = {"success": True, "result": "application opened"}
    mock_computer.take_screenshot.return_value = {"success": True, "path": "/path/to/screenshot.png"}
    mock_computer.file_explorer.return_value = {"success": True, "result": "file explorer opened"}
    mock_computer.clipboard_get.return_value = {"success": True, "text": "clipboard content"}
    mock_computer.clipboard_set.return_value = {"success": True, "result": "clipboard set"}
    
    return mock_computer


@pytest.fixture
def mock_vector_search():
    """Create a mock for the hanzo_aci vector_search interface."""
    mock_vector = AsyncMock()
    
    # Configure basic methods
    mock_vector.is_available.return_value = True
    mock_vector.get_capabilities.return_value = {
        "available": True,
        "operations": ["vector_search", "semantic_search", "vector_index", "hybrid_search"]
    }
    mock_vector.execute_operation.return_value = {
        "success": True,
        "results": [
            {"document": "Sample document content", "metadata": {"source": "file1.py"}, "distance": 0.25}
        ],
        "query": "sample query"
    }
    
    return mock_vector


@pytest.fixture
def mock_symbolic_reasoning():
    """Create a mock for the hanzo_aci symbolic_reasoning interface."""
    mock_symbolic = AsyncMock()
    
    # Configure basic methods
    mock_symbolic.is_available.return_value = True
    mock_symbolic.get_capabilities.return_value = {
        "available": True,
        "operations": ["parse_file", "find_symbols", "find_references", "analyze_dependencies"],
        "languages": ["python", "javascript"]
    }
    mock_symbolic.execute_operation.return_value = {
        "success": True,
        "file_path": "/path/to/file.py",
        "symbols": [
            {"name": "function1", "type": "function", "line": 10, "column": 1},
            {"name": "Class1", "type": "class", "line": 20, "column": 1}
        ]
    }
    
    return mock_symbolic


@pytest.fixture
def computer_use_with_mocks(mock_aci_computer, mock_vector_search, mock_symbolic_reasoning):
    """Set up the ComputerUseInterface with all required mocks."""
    with patch("hanzo_mcp.tools.computer_use.aci_computer", mock_aci_computer), \
         patch("hanzo_mcp.tools.computer_use.vector_search", mock_vector_search), \
         patch("hanzo_mcp.tools.computer_use.symbolic_reasoning", mock_symbolic_reasoning):
        yield ComputerUseInterface()


def test_computer_use_interface_init():
    """Test initialization of ComputerUseInterface with ACI."""
    with patch("hanzo_mcp.tools.computer_use.aci_computer") as mock_aci_computer:
        interface = ComputerUseInterface()
        assert interface._computer is mock_aci_computer
        assert interface._server_name == "computer-use"


@pytest.mark.asyncio
async def test_computer_use_interface_is_available(computer_use_with_mocks, mock_aci_computer):
    """Test checking if the ACI computer interface is available."""
    # Test when ACI is available
    mock_aci_computer.is_available.return_value = True
    result = await computer_use_with_mocks.is_available()
    assert result is True
    mock_aci_computer.is_available.assert_called_once()
    
    # Test when ACI is not available
    mock_aci_computer.is_available.reset_mock()
    mock_aci_computer.is_available.return_value = False
    result = await computer_use_with_mocks.is_available()
    assert result is False
    mock_aci_computer.is_available.assert_called_once()


def test_computer_use_interface_is_running(computer_use_with_mocks):
    """Test checking if the ACI computer interface is running."""
    # ACI doesn't have a direct running state, always returns True for compatibility
    result = computer_use_with_mocks.is_running()
    assert result is True


@pytest.mark.asyncio
async def test_computer_use_interface_ensure_running(computer_use_with_mocks, mock_aci_computer):
    """Test ensuring that the ACI computer interface is running."""
    result = await computer_use_with_mocks.ensure_running()
    assert result["success"] is True
    mock_aci_computer.ensure_running.assert_called_once()


@pytest.mark.asyncio
async def test_computer_use_interface_stop(computer_use_with_mocks):
    """Test stopping the ACI computer interface."""
    # ACI doesn't have a direct stop method, returns success response for compatibility
    result = await computer_use_with_mocks.stop()
    assert result["success"] is True
    assert "doesn't require explicit stop" in result["message"]


@pytest.mark.asyncio
async def test_computer_use_interface_restart(computer_use_with_mocks, mock_aci_computer):
    """Test restarting the ACI computer interface."""
    # ACI doesn't have a direct restart method, uses ensure_running for compatibility
    result = await computer_use_with_mocks.restart()
    assert result["success"] is True
    mock_aci_computer.ensure_running.assert_called_once()


@pytest.mark.asyncio
async def test_computer_use_interface_get_available_tools(computer_use_with_mocks, mock_aci_computer):
    """Test getting available tools from the ACI computer interface."""
    # Test successful retrieval of tools
    tools = await computer_use_with_mocks.get_available_tools()
    assert len(tools) == 6  # Based on mock_aci_computer.get_capabilities
    assert tools[0]["name"] == "open_application"
    assert "definition" in tools[0]
    mock_aci_computer.get_capabilities.assert_called_once()


@pytest.mark.asyncio
async def test_computer_use_interface_execute_tool(computer_use_with_mocks, mock_aci_computer):
    """Test executing a tool using the ACI computer interface."""
    # Test successful tool execution
    result = await computer_use_with_mocks.execute_tool("open_application", {"name": "firefox"})
    assert result["success"] is True
    mock_aci_computer.execute_operation.assert_called_once_with("open_application", {"name": "firefox"})
    
    # Test handling of exception during execution
    mock_aci_computer.execute_operation.reset_mock()
    mock_aci_computer.execute_operation.side_effect = Exception("Test exception")
    result = await computer_use_with_mocks.execute_tool("problematic_tool", {})
    assert result["success"] is False
    assert "Error executing tool" in result["error"]


@pytest.mark.asyncio
async def test_get_computer_capabilities(mock_aci_computer, mock_vector_search, mock_symbolic_reasoning):
    """Test the get_computer_capabilities function with ACI."""
    with patch("hanzo_mcp.tools.computer_use.aci_computer", mock_aci_computer), \
         patch("hanzo_mcp.tools.computer_use.vector_search", mock_vector_search), \
         patch("hanzo_mcp.tools.computer_use.symbolic_reasoning", mock_symbolic_reasoning), \
         patch("hanzo_mcp.tools.computer_use.computer_use") as mock_computer_use:
        
        # Configure the computer_use mock
        mock_computer_use.is_available = AsyncMock(return_value=True)
        mock_computer_use.ensure_running = AsyncMock()
        
        # Test successful capabilities retrieval
        result = await get_computer_capabilities()
        assert result["available"] is True
        assert "specialized_modules" in result
        assert "vector_search" in result["specialized_modules"]
        assert "symbolic_reasoning" in result["specialized_modules"]
        assert result["running"] is True
        
        # Test when computer use is not available
        mock_computer_use.is_available.return_value = False
        result = await get_computer_capabilities()
        assert result["available"] is False


@pytest.mark.asyncio
async def test_convenience_functions(mock_aci_computer):
    """Test the convenience functions that use the ACI computer interface."""
    with patch("hanzo_mcp.tools.computer_use.aci_computer", mock_aci_computer):
        # Test open_application
        result = await open_application("firefox")
        assert result["success"] is True
        mock_aci_computer.open_application.assert_called_once_with("firefox")
        
        # Test take_screenshot
        mock_aci_computer.reset_mock()
        result = await take_screenshot()
        assert result["success"] is True
        mock_aci_computer.take_screenshot.assert_called_once()
        
        # Test file_explorer
        mock_aci_computer.reset_mock()
        result = await file_explorer("/path/to/explore")
        assert result["success"] is True
        mock_aci_computer.file_explorer.assert_called_once_with("/path/to/explore")
        
        # Test clipboard_get
        mock_aci_computer.reset_mock()
        result = await clipboard_get()
        assert result["success"] is True
        mock_aci_computer.clipboard_get.assert_called_once()
        
        # Test clipboard_set
        mock_aci_computer.reset_mock()
        result = await clipboard_set("new content")
        assert result["success"] is True
        mock_aci_computer.clipboard_set.assert_called_once_with("new content")


@pytest.mark.asyncio
async def test_specialized_functions(mock_vector_search, mock_symbolic_reasoning):
    """Test the specialized functions that use ACI components."""
    with patch("hanzo_mcp.tools.computer_use.vector_search", mock_vector_search), \
         patch("hanzo_mcp.tools.computer_use.symbolic_reasoning", mock_symbolic_reasoning):
        
        # Test vector_search_query
        result = await vector_search_query("search query", "/project/dir", 5)
        assert result["success"] is True
        mock_vector_search.execute_operation.assert_called_once_with(
            operation="vector_search",
            params={
                "query": "search query",
                "project_dir": "/project/dir",
                "n_results": 5
            }
        )
        
        # Test find_symbols
        mock_symbolic_reasoning.reset_mock()
        result = await find_symbols("/path/to/file.py", "function")
        assert result["success"] is True
        mock_symbolic_reasoning.execute_operation.assert_called_once_with(
            operation="find_symbols",
            params={
                "file_path": "/path/to/file.py",
                "symbol_type": "function"
            }
        )