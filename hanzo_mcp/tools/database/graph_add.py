"""Graph add tool for adding nodes and edges to the graph database."""

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
        description="Node ID to add (required for nodes)",
        default=None,
    ),
]

NodeType = Annotated[
    Optional[str],
    Field(
        description="Node type (e.g., 'file', 'function', 'class')",
        default=None,
    ),
]

Properties = Annotated[
    Optional[dict],
    Field(
        description="Properties as JSON object",
        default=None,
    ),
]

Source = Annotated[
    Optional[str],
    Field(
        description="Source node ID (required for edges)",
        default=None,
    ),
]

Target = Annotated[
    Optional[str],
    Field(
        description="Target node ID (required for edges)",
        default=None,
    ),
]

Relationship = Annotated[
    Optional[str],
    Field(
        description="Edge relationship type (e.g., 'imports', 'calls', 'inherits')",
        default=None,
    ),
]

Weight = Annotated[
    float,
    Field(
        description="Edge weight (default 1.0)",
        default=1.0,
    ),
]

ProjectPath = Annotated[
    Optional[str],
    Field(
        description="Project path (defaults to current directory)",
        default=None,
    ),
]


class GraphAddParams(TypedDict, total=False):
    """Parameters for graph add tool."""

    node_id: Optional[str]
    node_type: Optional[str]
    properties: Optional[dict]
    source: Optional[str]
    target: Optional[str]
    relationship: Optional[str]
    weight: float
    project_path: Optional[str]


@final
class GraphAddTool(BaseTool):
    """Tool for adding nodes and edges to graph database."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the graph add tool.

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
        return "graph_add"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Add nodes and edges to the project's graph database.

To add a node:
- Provide node_id and node_type
- Optionally add properties as JSON

To add an edge:
- Provide source, target, and relationship
- Optionally add weight and properties

Common node types:
- file, function, class, module, variable

Common relationships:
- imports, calls, inherits, contains, references, depends_on

Examples:
- graph_add --node-id "main.py" --node-type "file" --properties '{"size": 1024}'
- graph_add --node-id "MyClass" --node-type "class" --properties '{"file": "main.py"}'
- graph_add --source "main.py" --target "utils.py" --relationship "imports"
- graph_add --source "func1" --target "func2" --relationship "calls" --weight 5.0
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GraphAddParams],
    ) -> str:
        """Add nodes or edges to graph.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of add operation
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        node_id = params.get("node_id")
        node_type = params.get("node_type")
        properties = params.get("properties", {})
        source = params.get("source")
        target = params.get("target")
        relationship = params.get("relationship")
        weight = params.get("weight", 1.0)
        project_path = params.get("project_path")

        # Determine if adding node or edge
        is_node = node_id is not None
        is_edge = source is not None and target is not None

        if not is_node and not is_edge:
            return "Error: Must provide either (node_id and node_type) for a node, or (source, target, relationship) for an edge"

        if is_node and is_edge:
            return "Error: Cannot add both node and edge in one operation"

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
                # Add node
                if not node_type:
                    return "Error: node_type is required when adding a node"

                await tool_ctx.info(f"Adding node: {node_id} (type: {node_type})")

                # Serialize properties
                properties_json = json.dumps(properties) if properties else None

                # Insert or update node
                graph_conn.execute("""
                    INSERT OR REPLACE INTO nodes (id, type, properties)
                    VALUES (?, ?, ?)
                """, (node_id, node_type, properties_json))
                
                graph_conn.commit()
                
                return f"Successfully added node '{node_id}' of type '{node_type}'"

            else:
                # Add edge
                if not relationship:
                    return "Error: relationship is required when adding an edge"

                await tool_ctx.info(f"Adding edge: {source} --[{relationship}]--> {target}")

                # Check if nodes exist
                cursor = graph_conn.cursor()
                cursor.execute("SELECT id FROM nodes WHERE id IN (?, ?)", (source, target))
                existing = [row[0] for row in cursor.fetchall()]
                
                if source not in existing:
                    return f"Error: Source node '{source}' does not exist"
                if target not in existing:
                    return f"Error: Target node '{target}' does not exist"

                # Serialize properties
                properties_json = json.dumps(properties) if properties else None

                # Insert or update edge
                graph_conn.execute("""
                    INSERT OR REPLACE INTO edges (source, target, relationship, weight, properties)
                    VALUES (?, ?, ?, ?, ?)
                """, (source, target, relationship, weight, properties_json))
                
                graph_conn.commit()
                
                # Save to disk
                project_db._save_graph_to_disk()
                
                return f"Successfully added edge: {source} --[{relationship}]--> {target} (weight: {weight})"

        except Exception as e:
            await tool_ctx.error(f"Failed to add to graph: {str(e)}")
            return f"Error adding to graph: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass