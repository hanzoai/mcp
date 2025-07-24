"""Tests for new tools added to Hanzo AI."""

import pytest
import tempfile
import os
import json
import sqlite3
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager
from hanzo_mcp.tools.database.graph_add import GraphAddTool
from hanzo_mcp.tools.database.graph_remove import GraphRemoveTool
from hanzo_mcp.tools.database.graph_query import GraphQueryTool
from hanzo_mcp.tools.database.graph_search import GraphSearchTool
from hanzo_mcp.tools.database.graph_stats import GraphStatsTool
from hanzo_mcp.tools.filesystem.find_files import FindFilesTool
from hanzo_mcp.tools.shell.uvx import UvxTool
from hanzo_mcp.tools.shell.npx import NpxTool
from hanzo_mcp.tools.shell.uvx_background import UvxBackgroundTool
from hanzo_mcp.tools.shell.npx_background import NpxBackgroundTool
from hanzo_mcp.tools.mcp.mcp_add import McpAddTool
from hanzo_mcp.tools.mcp.mcp_remove import McpRemoveTool
from hanzo_mcp.tools.mcp.mcp_stats import McpStatsTool
from hanzo_mcp.tools.common.stats import StatsTool
from hanzo_mcp.tools.common.tool_enable import ToolEnableTool
from hanzo_mcp.tools.common.tool_disable import ToolDisableTool


@pytest.fixture
def mock_ctx():
    """Create a mock MCP context."""
    ctx = Mock()
    ctx.client = Mock()
    ctx.client.notify_progress = Mock()
    return ctx


@pytest.fixture
def permission_manager():
    """Create a permission manager."""
    pm = PermissionManager()
    pm.add_allowed_path(os.getcwd())
    return pm


@pytest.fixture
def db_manager(permission_manager):
    """Create a database manager."""
    return DatabaseManager(permission_manager)


class TestGraphTools:
    """Test graph database tools."""
    
    @pytest.mark.asyncio
    async def test_graph_add_node(self, mock_ctx, permission_manager, db_manager):
        """Test adding a node to the graph."""
        tool = GraphAddTool(permission_manager, db_manager)
        
        result = await tool.call(
            mock_ctx,
            node_id="test_node",
            node_type="file",
            properties={"size": 1024}
        )
        
        assert "Successfully added node 'test_node'" in result
    
    @pytest.mark.asyncio
    async def test_graph_add_edge(self, mock_ctx, permission_manager, db_manager):
        """Test adding an edge to the graph."""
        tool = GraphAddTool(permission_manager, db_manager)
        
        # Add nodes first
        await tool.call(mock_ctx, node_id="node1", node_type="file")
        await tool.call(mock_ctx, node_id="node2", node_type="file")
        
        # Add edge
        result = await tool.call(
            mock_ctx,
            source="node1",
            target="node2",
            relationship="imports"
        )
        
        assert "Successfully added edge" in result
    
    @pytest.mark.asyncio
    async def test_graph_remove_node(self, mock_ctx, permission_manager, db_manager):
        """Test removing a node from the graph."""
        add_tool = GraphAddTool(permission_manager, db_manager)
        remove_tool = GraphRemoveTool(permission_manager, db_manager)
        
        # Add a node
        await add_tool.call(mock_ctx, node_id="test_node", node_type="file")
        
        # Remove it
        result = await remove_tool.call(mock_ctx, node_id="test_node")
        
        assert "Successfully removed node 'test_node'" in result
    
    @pytest.mark.asyncio
    async def test_graph_query_neighbors(self, mock_ctx, permission_manager, db_manager):
        """Test querying neighbors in the graph."""
        add_tool = GraphAddTool(permission_manager, db_manager)
        query_tool = GraphQueryTool(permission_manager, db_manager)
        
        # Create a simple graph
        await add_tool.call(mock_ctx, node_id="A", node_type="file")
        await add_tool.call(mock_ctx, node_id="B", node_type="file")
        await add_tool.call(mock_ctx, node_id="C", node_type="file")
        await add_tool.call(mock_ctx, source="A", target="B", relationship="imports")
        await add_tool.call(mock_ctx, source="A", target="C", relationship="imports")
        
        # Query neighbors
        result = await query_tool.call(
            mock_ctx,
            query="neighbors",
            node_id="A"
        )
        
        assert "Neighbors of 'A'" in result
        assert "B" in result
        assert "C" in result
    
    @pytest.mark.asyncio
    async def test_graph_search(self, mock_ctx, permission_manager, db_manager):
        """Test searching in the graph."""
        add_tool = GraphAddTool(permission_manager, db_manager)
        search_tool = GraphSearchTool(permission_manager, db_manager)
        
        # Add nodes with properties
        await add_tool.call(
            mock_ctx,
            node_id="main.py",
            node_type="file",
            properties={"description": "Main entry point"}
        )
        
        # Search
        result = await search_tool.call(
            mock_ctx,
            pattern="main%"
        )
        
        assert "Found" in result
        assert "main.py" in result
    
    @pytest.mark.asyncio
    async def test_graph_stats(self, mock_ctx, permission_manager, db_manager):
        """Test graph statistics."""
        add_tool = GraphAddTool(permission_manager, db_manager)
        stats_tool = GraphStatsTool(permission_manager, db_manager)
        
        # Add some data
        await add_tool.call(mock_ctx, node_id="A", node_type="file")
        await add_tool.call(mock_ctx, node_id="B", node_type="class")
        await add_tool.call(mock_ctx, source="A", target="B", relationship="contains")
        
        # Get stats
        result = await stats_tool.call(mock_ctx)
        
        assert "Total Nodes: 2" in result
        assert "Total Edges: 1" in result


class TestFindFilesTool:
    """Test find files tool."""
    
    @pytest.mark.asyncio
    async def test_find_files_basic(self, mock_ctx, permission_manager):
        """Test basic file finding."""
        tool = FindFilesTool(permission_manager)
        
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create test files
            Path(tmpdir, "test1.py").touch()
            Path(tmpdir, "test2.py").touch()
            Path(tmpdir, "data.txt").touch()
            
            # Allow access
            permission_manager.add_allowed_path(tmpdir)
            
            # Find Python files
            result = await tool.call(
                mock_ctx,
                pattern="*.py",
                path=tmpdir
            )
            
            assert "Found 2 file(s)" in result
            assert "test1.py" in result
            assert "test2.py" in result
            assert "data.txt" not in result
    
    @pytest.mark.asyncio
    async def test_find_files_recursive(self, mock_ctx, permission_manager):
        """Test recursive file finding."""
        tool = FindFilesTool(permission_manager)
        
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create nested structure
            subdir = Path(tmpdir, "subdir")
            subdir.mkdir()
            Path(tmpdir, "top.txt").touch()
            Path(subdir, "nested.txt").touch()
            
            permission_manager.add_allowed_path(tmpdir)
            
            # Find all txt files
            result = await tool.call(
                mock_ctx,
                pattern="*.txt",
                path=tmpdir,
                recursive=True
            )
            
            assert "Found 2 file(s)" in result
            assert "top.txt" in result
            assert "subdir/nested.txt" in result


class TestPackageRunnerTools:
    """Test uvx and npx tools."""
    
    @pytest.mark.asyncio
    async def test_uvx_basic(self, mock_ctx, permission_manager):
        """Test basic uvx execution."""
        tool = UvxTool(permission_manager)
        
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(
                stdout="Package output",
                stderr="",
                returncode=0
            )
            
            with patch('shutil.which', return_value='/usr/bin/uvx'):
                result = await tool.call(
                    mock_ctx,
                    package="ruff",
                    args="check ."
                )
                
                assert "Package output" in result
                mock_run.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_npx_basic(self, mock_ctx, permission_manager):
        """Test basic npx execution."""
        tool = NpxTool(permission_manager)
        
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(
                stdout="Package output",
                stderr="",
                returncode=0
            )
            
            with patch('shutil.which', return_value='/usr/bin/npx'):
                result = await tool.call(
                    mock_ctx,
                    package="eslint",
                    args="--version"
                )
                
                assert "Package output" in result
                mock_run.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_uvx_background(self, mock_ctx, permission_manager):
        """Test uvx background execution."""
        tool = UvxBackgroundTool(permission_manager)
        
        with patch('subprocess.Popen') as mock_popen:
            mock_process = MagicMock()
            mock_process.pid = 12345
            mock_popen.return_value = mock_process
            
            with patch('shutil.which', return_value='/usr/bin/uvx'):
                result = await tool.call(
                    mock_ctx,
                    package="streamlit",
                    args="run app.py",
                    name="test-app"
                )
                
                assert "Started uvx background process" in result
                assert "PID: 12345" in result
                mock_popen.assert_called_once()


class TestMcpManagementTools:
    """Test MCP management tools."""
    
    @pytest.mark.asyncio
    async def test_mcp_add(self, mock_ctx):
        """Test adding an MCP server."""
        tool = McpAddTool()
        
        result = await tool.call(
            mock_ctx,
            command="uvx mcp-server-git",
            name="git-server"
        )
        
        assert "Successfully added MCP server 'git-server'" in result
        
        # Check it was saved
        servers = McpAddTool.get_servers()
        assert "git-server" in servers
    
    @pytest.mark.asyncio
    async def test_mcp_remove(self, mock_ctx):
        """Test removing an MCP server."""
        # First add a server
        add_tool = McpAddTool()
        await add_tool.call(
            mock_ctx,
            command="uvx test-server",
            name="test-server"
        )
        
        # Then remove it
        remove_tool = McpRemoveTool()
        result = await remove_tool.call(
            mock_ctx,
            name="test-server"
        )
        
        assert "Successfully removed MCP server 'test-server'" in result
        
        # Check it was removed
        servers = McpAddTool.get_servers()
        assert "test-server" not in servers
    
    @pytest.mark.asyncio
    async def test_mcp_stats(self, mock_ctx):
        """Test MCP stats."""
        tool = McpStatsTool()
        
        # Add some servers first
        McpAddTool._mcp_servers = {
            "server1": {
                "type": "python",
                "status": "running",
                "command": ["uvx", "server1"],
                "tools": ["tool1", "tool2"]
            },
            "server2": {
                "type": "node",
                "status": "stopped",
                "command": ["npx", "server2"],
                "tools": []
            }
        }
        
        result = await tool.call(mock_ctx)
        
        assert "Total Servers: 2" in result
        assert "server1" in result
        assert "server2" in result


class TestSystemTools:
    """Test system management tools."""
    
    @pytest.mark.asyncio
    async def test_stats_tool(self, mock_ctx, db_manager):
        """Test comprehensive stats tool."""
        tool = StatsTool(db_manager)
        
        with patch('psutil.cpu_percent', return_value=50.0):
            with patch('psutil.cpu_count', return_value=4):
                with patch('psutil.virtual_memory') as mock_mem:
                    mock_mem.return_value = MagicMock(
                        total=8 * 1024**3,
                        used=4 * 1024**3,
                        percent=50.0
                    )
                    
                    with patch('psutil.disk_usage') as mock_disk:
                        mock_disk.return_value = MagicMock(
                            total=100 * 1024**3,
                            used=50 * 1024**3,
                            free=50 * 1024**3,
                            percent=50.0
                        )
                        
                        result = await tool.call(mock_ctx)
                        
                        assert "CPU Usage: 50.0%" in result
                        assert "Memory: 4.0/8.0 GB" in result
                        assert "Disk: 50.0/100.0 GB" in result
                        assert "System resources are healthy" in result
    
    @pytest.mark.asyncio
    async def test_tool_enable_disable(self, mock_ctx):
        """Test tool enable/disable functionality."""
        enable_tool = ToolEnableTool()
        disable_tool = ToolDisableTool()
        
        # Disable a tool
        result = await disable_tool.call(
            mock_ctx,
            tool="vector_search"
        )
        assert "Successfully disabled tool 'vector_search'" in result
        
        # Check it's disabled
        assert not ToolEnableTool.is_tool_enabled("vector_search")
        
        # Re-enable it
        result = await enable_tool.call(
            mock_ctx,
            tool="vector_search"
        )
        assert "Successfully enabled tool 'vector_search'" in result
        
        # Check it's enabled
        assert ToolEnableTool.is_tool_enabled("vector_search")
    
    @pytest.mark.asyncio
    async def test_tool_disable_critical(self, mock_ctx):
        """Test that critical tools cannot be disabled."""
        tool = ToolDisableTool()
        
        result = await tool.call(
            mock_ctx,
            tool="tool_enable"
        )
        
        assert "Error: Cannot disable critical tool" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
