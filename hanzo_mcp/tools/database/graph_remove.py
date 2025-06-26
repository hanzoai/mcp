"""Graph remove tool for removing nodes and edges from the graph database."""

import json
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


NodeId = Annotated[
    Optional[str],
    Field(
        description="Node ID to remove",
        default=None,
    ),
]

Source = Annotated[
    Optional[str],
    Field(
        description="Source node ID (for edge removal)",
        default=None,
    ),
]

Target = Annotated[
    Optional[str],
    Field(
        description="Target node ID (for edge removal)",
        default=None,
    ),
]

Relationship = Annotated[
    Optional[str],
    Field(
        description="Edge relationship type (for edge removal)",
        default=None,
    ),
]

Cascade = Annotated[
    bool,
    Field(
        description="Cascade delete - remove all connected edges when removing a node",
        default=True,
    ),
]

ProjectPath = Annotated[
    Optional[str],
    Field(
        description="Project path (defaults to current directory)",
        default=None,
    ),
]


class GraphRemoveParams(TypedDict, total=False):
    """Parameters for graph remove tool."""

    node_id: Optional[str]
    source: Optional[str]
    target: Optional[str]
    relationship: Optional[str]
    cascade: bool
    project_path: Optional[str]


@final
class GraphRemoveTool(BaseTool):
    """Tool for removing nodes and edges from graph database."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the graph remove tool.

        Args:
            permission_manager: Permission manager for access control
            db_manager: Database manager instance
        """
        self.permission_manager = permission_manager
        self.db_manager = db_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "graph_remove"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Remove nodes and edges from the project's graph database.

To remove a node:
- Provide node_id
- Use --cascade (default true) to remove connected edges
- Use --no-cascade to keep edges (may leave orphaned edges)

To remove an edge:
- Provide source, target, and relationship
- Removes only the specific edge

To remove all edges between two nodes:
- Provide source and target (no relationship)

Examples:
- graph_remove --node-id "main.py"                           # Remove node and its edges
- graph_remove --node-id "MyClass" --no-cascade              # Remove node only
- graph_remove --source "main.py" --target "utils.py" --relationship "imports"
- graph_remove --source "func1" --target "func2"             # Remove all edges
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GraphRemoveParams],
    ) -> str:
        """Remove nodes or edges from graph.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of remove operation
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        node_id = params.get("node_id")
        source = params.get("source")
        target = params.get("target")
        relationship = params.get("relationship")
        cascade = params.get("cascade", True)
        project_path = params.get("project_path")

        # Determine if removing node or edge
        is_node = node_id is not None
        is_edge = source is not None and target is not None

        if not is_node and not is_edge:
            return "Error: Must provide either node_id for a node, or (source, target) for edges"

        if is_node and is_edge:
            return "Error: Cannot remove both node and edge in one operation"

        # Get project database
        try:
            if project_path:
                project_db = self.db_manager.get_project_db(project_path)
            else:
                import os
                project_db = self.db_manager.get_project_for_path(os.getcwd())
                
            if not project_db:
                return "Error: Could not find project database"

        except PermissionError as e:
            return str(e)
        except Exception as e:
            return f"Error accessing project database: {str(e)}"

        # Get graph connection
        graph_conn = project_db.get_graph_connection()

        try:
            if is_node:
                # Remove node
                await tool_ctx.info(f"Removing node: {node_id}")

                # Check if node exists
                cursor = graph_conn.cursor()
                cursor.execute("SELECT id FROM nodes WHERE id = ?", (node_id,))
                if not cursor.fetchone():
                    return f"Error: Node '{node_id}' does not exist"

                if cascade:
                    # Count edges that will be removed
                    cursor.execute(
                        "SELECT COUNT(*) FROM edges WHERE source = ? OR target = ?",
                        (node_id, node_id)
                    )
                    edge_count = cursor.fetchone()[0]
                    
                    # Remove connected edges
                    graph_conn.execute(
                        "DELETE FROM edges WHERE source = ? OR target = ?",
                        (node_id, node_id)
                    )
                    
                    # Remove node
                    graph_conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
                    graph_conn.commit()
                    
                    # Save to disk
                    project_db._save_graph_to_disk()
                    
                    return f"Successfully removed node '{node_id}' and {edge_count} connected edge(s)"
                else:
                    # Remove node only
                    graph_conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
                    graph_conn.commit()
                    
                    # Save to disk
                    project_db._save_graph_to_disk()
                    
                    return f"Successfully removed node '{node_id}' (edges preserved)"

            else:
                # Remove edge(s)
                if relationship:
                    # Remove specific edge
                    await tool_ctx.info(f"Removing edge: {source} --[{relationship}]--> {target}")
                    
                    cursor = graph_conn.cursor()
                    cursor.execute(
                        "DELETE FROM edges WHERE source = ? AND target = ? AND relationship = ?",
                        (source, target, relationship)
                    )
                    
                    removed = cursor.rowcount
                    graph_conn.commit()
                    
                    if removed == 0:
                        return f"No edge found: {source} --[{relationship}]--> {target}"
                    
                    # Save to disk
                    project_db._save_graph_to_disk()
                    
                    return f"Successfully removed edge: {source} --[{relationship}]--> {target}"
                else:
                    # Remove all edges between nodes
                    await tool_ctx.info(f"Removing all edges between {source} and {target}")
                    
                    cursor = graph_conn.cursor()
                    cursor.execute(
                        "DELETE FROM edges WHERE source = ? AND target = ?",
                        (source, target)
                    )
                    
                    removed = cursor.rowcount
                    graph_conn.commit()
                    
                    if removed == 0:
                        return f"No edges found between '{source}' and '{target}'"
                    
                    # Save to disk
                    project_db._save_graph_to_disk()
                    
                    return f"Successfully removed {removed} edge(s) between '{source}' and '{target}'"

        except Exception as e:
            await tool_ctx.error(f"Failed to remove from graph: {str(e)}")
            return f"Error removing from graph: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
