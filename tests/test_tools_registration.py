"""Tests for the tools registration process."""

from unittest.mock import MagicMock, patch

import pytest

from hanzo_mcp.tools import register_all_tools
from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem import (
    ReadFilesTool, 
    WriteFileTool, 
    EditFileTool,
    DirectoryTreeTool,
    GetFileInfoTool,
    SearchContentTool,
    ContentReplaceTool
)
from hanzo_mcp.tools.jupyter import (
    ReadNotebookTool,
    EditNotebookTool
)


class TestToolsRegistration:
    """Test the tools registration process."""

    @pytest.fixture
    def mcp_server(self):
        """Create a mock MCP server."""
        server = MagicMock()
        return server

    @pytest.fixture
    def document_context(self):
        """Create a document context."""
        return DocumentContext()

    @pytest.fixture
    def permission_manager(self):
        """Create a permission manager."""
        return PermissionManager()

    def test_register_all_tools_default(
        self, mcp_server, document_context, permission_manager
    ):
        """Test registering all tools with default settings."""
        # Mock the tool registry to capture registered tools
        registered_tools = []
        
        with patch("hanzo_mcp.tools.ToolRegistry.register_tools") as mock_register:
            mock_register.side_effect = lambda _, tools: registered_tools.extend(tools)
            
            # Register all tools with default settings
            register_all_tools(
                mcp_server=mcp_server,
                document_context=document_context,
                permission_manager=permission_manager
            )
            
            # Check that all filesystem tools are registered
            fs_tool_types = [type(tool) for tool in registered_tools 
                            if isinstance(tool, (ReadFilesTool, WriteFileTool, EditFileTool, 
                                               DirectoryTreeTool, GetFileInfoTool, 
                                               SearchContentTool, ContentReplaceTool))]
            
            assert ReadFilesTool in fs_tool_types
            assert WriteFileTool in fs_tool_types
            assert EditFileTool in fs_tool_types
            
            # Check that all Jupyter tools are registered
            jupyter_tool_types = [type(tool) for tool in registered_tools 
                                if isinstance(tool, (ReadNotebookTool, EditNotebookTool))]
            
            assert ReadNotebookTool in jupyter_tool_types
            assert EditNotebookTool in jupyter_tool_types

    def test_register_all_tools_disable_write_tools(
        self, mcp_server, document_context, permission_manager
    ):
        """Test registering all tools with disable_write_tools=True."""
        # Mock the tool registry to capture registered tools
        registered_tools = []
        
        with patch("hanzo_mcp.tools.ToolRegistry.register_tools") as mock_register:
            mock_register.side_effect = lambda _, tools: registered_tools.extend(tools)
            
            # Register all tools with disable_write_tools=True
            register_all_tools(
                mcp_server=mcp_server,
                document_context=document_context,
                permission_manager=permission_manager,
                disable_write_tools=True
            )
            
            # Check that only read-only filesystem tools are registered
            fs_tool_types = [type(tool) for tool in registered_tools]
            
            # Read-only tools should be present
            assert ReadFilesTool in fs_tool_types
            assert DirectoryTreeTool in fs_tool_types
            assert GetFileInfoTool in fs_tool_types
            assert SearchContentTool in fs_tool_types
            
            # Write tools should not be present
            assert WriteFileTool not in fs_tool_types
            assert EditFileTool not in fs_tool_types
            assert ContentReplaceTool not in fs_tool_types
            
            # Check that only read-only Jupyter tools are registered
            jupyter_tool_types = [type(tool) for tool in registered_tools]
            
            # Read-only tools should be present
            assert ReadNotebookTool in jupyter_tool_types
            
            # Write tools should not be present
            assert EditNotebookTool not in jupyter_tool_types
            
    def test_register_filesystem_tools_with_disabled_write(
        self, mcp_server, document_context, permission_manager
    ):
        """Test registering filesystem tools with disable_write_tools=True."""
        from hanzo_mcp.tools.filesystem import register_filesystem_tools
        
        # Mock the tool registry to capture registered tools
        registered_tools = []
        
        with patch("hanzo_mcp.tools.filesystem.ToolRegistry.register_tools") as mock_register:
            mock_register.side_effect = lambda _, tools: registered_tools.extend(tools)
            
            # Register filesystem tools with disable_write_tools=True
            register_filesystem_tools(
                mcp_server=mcp_server,
                document_context=document_context,
                permission_manager=permission_manager,
                disable_write_tools=True
            )
            
            # Check that only read-only tools are registered
            tool_types = [type(tool) for tool in registered_tools]
            
            # Read-only tools should be present
            assert ReadFilesTool in tool_types
            assert DirectoryTreeTool in tool_types
            assert GetFileInfoTool in tool_types
            assert SearchContentTool in tool_types
            
            # Write tools should not be present
            assert WriteFileTool not in tool_types
            assert EditFileTool not in tool_types
            assert ContentReplaceTool not in tool_types
            
    def test_register_jupyter_tools_with_disabled_write(
        self, mcp_server, document_context, permission_manager
    ):
        """Test registering Jupyter tools with disable_write_tools=True."""
        from hanzo_mcp.tools.jupyter import register_jupyter_tools
        
        # Mock the tool registry to capture registered tools
        registered_tools = []
        
        with patch("hanzo_mcp.tools.jupyter.ToolRegistry.register_tools") as mock_register:
            mock_register.side_effect = lambda _, tools: registered_tools.extend(tools)
            
            # Register Jupyter tools with disable_write_tools=True
            register_jupyter_tools(
                mcp_server=mcp_server,
                document_context=document_context,
                permission_manager=permission_manager,
                disable_write_tools=True
            )
            
            # Check that only read-only tools are registered
            tool_types = [type(tool) for tool in registered_tools]
            
            # Read-only tools should be present
            assert ReadNotebookTool in tool_types
            
            # Write tools should not be present
            assert EditNotebookTool not in tool_types