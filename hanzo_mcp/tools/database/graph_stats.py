"""Graph statistics tool for analyzing the graph database."""

import json
import sqlite3
from typing import Annotated, Optional, TypedDict, Unpack, final, override
from collections import Counter, defaultdict

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


ProjectPath = Annotated[
    Optional[str],
    Field(
        description="Project path (defaults to current directory)",
        default=None,
    ),
]

Detailed = Annotated[
    bool,
    Field(
        description="Show detailed statistics",
        default=False,
    ),
]

NodeType = Annotated[
    Optional[str],
    Field(
        description="Filter stats by node type",
        default=None,
    ),
]

Relationship = Annotated[
    Optional[str],
    Field(
        description="Filter stats by relationship type",
        default=None,
    ),
]


class GraphStatsParams(TypedDict, total=False):
    """Parameters for graph stats tool."""

    project_path: Optional[str]
    detailed: bool
    node_type: Optional[str]
    relationship: Optional[str]


@final
class GraphStatsTool(BaseTool):
    """Tool for getting graph database statistics."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the graph stats tool.

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
        return "graph_stats"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Get statistics about the project's graph database.

Shows:
- Node and edge counts
- Node type distribution
- Relationship type distribution
- Degree statistics (connections per node)
- Connected components
- Most connected nodes (hubs)
- Orphaned nodes

Examples:
- graph_stats                      # Basic stats
- graph_stats --detailed           # Detailed analysis
- graph_stats --node-type "class"  # Stats for specific node type
- graph_stats --relationship "calls"  # Stats for specific relationship
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GraphStatsParams],
    ) -> str:
        """Get graph statistics.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Graph statistics
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        project_path = params.get("project_path")
        detailed = params.get("detailed", False)
        node_type_filter = params.get("node_type")
        relationship_filter = params.get("relationship")

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

        await tool_ctx.info(f"Getting graph statistics for project: {project_db.project_path}")

        # Get graph connection
        graph_conn = project_db.get_graph_connection()

        try:
            cursor = graph_conn.cursor()
            output = []
            output.append(f"=== Graph Database Statistics ===")
            output.append(f"Project: {project_db.project_path}")
            output.append(f"Database: {project_db.graph_path}")
            output.append("")
            
            # Basic counts
            if node_type_filter:
                cursor.execute("SELECT COUNT(*) FROM nodes WHERE type = ?", (node_type_filter,))
                node_count = cursor.fetchone()[0]
                output.append(f"Nodes (type='{node_type_filter}'): {node_count:,}")
            else:
                cursor.execute("SELECT COUNT(*) FROM nodes")
                node_count = cursor.fetchone()[0]
                output.append(f"Total Nodes: {node_count:,}")
            
            if relationship_filter:
                cursor.execute("SELECT COUNT(*) FROM edges WHERE relationship = ?", (relationship_filter,))
                edge_count = cursor.fetchone()[0]
                output.append(f"Edges (relationship='{relationship_filter}'): {edge_count:,}")
            else:
                cursor.execute("SELECT COUNT(*) FROM edges")
                edge_count = cursor.fetchone()[0]
                output.append(f"Total Edges: {edge_count:,}")
            
            if node_count == 0:
                output.append("\nGraph is empty.")
                return "\n".join(output)
            
            output.append("")
            
            # Node type distribution
            output.append("=== Node Types ===")
            cursor.execute("SELECT type, COUNT(*) as count FROM nodes GROUP BY type ORDER BY count DESC")
            node_types = cursor.fetchall()
            
            for n_type, count in node_types[:10]:
                pct = (count / node_count) * 100
                output.append(f"{n_type}: {count:,} ({pct:.1f}%)")
            
            if len(node_types) > 10:
                output.append(f"... and {len(node_types) - 10} more types")
            
            output.append("")
            
            # Relationship distribution
            output.append("=== Relationship Types ===")
            cursor.execute("SELECT relationship, COUNT(*) as count FROM edges GROUP BY relationship ORDER BY count DESC")
            rel_types = cursor.fetchall()
            
            if rel_types:
                for rel, count in rel_types[:10]:
                    pct = (count / edge_count) * 100 if edge_count > 0 else 0
                    output.append(f"{rel}: {count:,} ({pct:.1f}%)")
                
                if len(rel_types) > 10:
                    output.append(f"... and {len(rel_types) - 10} more types")
            else:
                output.append("No edges in graph")
            
            output.append("")
            
            # Degree statistics
            output.append("=== Connectivity ===")
            
            # Calculate degrees
            degrees = defaultdict(int)
            
            # Out-degree
            query = "SELECT source, COUNT(*) FROM edges"
            if relationship_filter:
                query += " WHERE relationship = ?"
                cursor.execute(query + " GROUP BY source", (relationship_filter,))
            else:
                cursor.execute(query + " GROUP BY source")
            
            for node, out_degree in cursor.fetchall():
                degrees[node] += out_degree
            
            # In-degree
            query = "SELECT target, COUNT(*) FROM edges"
            if relationship_filter:
                query += " WHERE relationship = ?"
                cursor.execute(query + " GROUP BY target", (relationship_filter,))
            else:
                cursor.execute(query + " GROUP BY target")
            
            for node, in_degree in cursor.fetchall():
                degrees[node] += in_degree
            
            if degrees:
                degree_values = list(degrees.values())
                avg_degree = sum(degree_values) / len(degree_values)
                max_degree = max(degree_values)
                min_degree = min(degree_values)
                
                output.append(f"Average degree: {avg_degree:.2f}")
                output.append(f"Max degree: {max_degree}")
                output.append(f"Min degree: {min_degree}")
                
                # Most connected nodes
                output.append("\nMost connected nodes:")
                sorted_nodes = sorted(degrees.items(), key=lambda x: x[1], reverse=True)
                
                for node, degree in sorted_nodes[:5]:
                    cursor.execute("SELECT type FROM nodes WHERE id = ?", (node,))
                    node_type = cursor.fetchone()
                    type_str = f" ({node_type[0]})" if node_type else ""
                    output.append(f"  {node}{type_str}: {degree} connections")
            
            # Orphaned nodes
            cursor.execute("""
                SELECT COUNT(*) FROM nodes n
                WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source = n.id OR target = n.id)
            """)
            orphan_count = cursor.fetchone()[0]
            if orphan_count > 0:
                orphan_pct = (orphan_count / node_count) * 100
                output.append(f"\nOrphaned nodes: {orphan_count} ({orphan_pct:.1f}%)")
            
            if detailed:
                output.append("\n=== Detailed Analysis ===")
                
                # Node properties usage
                cursor.execute("SELECT COUNT(*) FROM nodes WHERE properties IS NOT NULL")
                nodes_with_props = cursor.fetchone()[0]
                if nodes_with_props > 0:
                    props_pct = (nodes_with_props / node_count) * 100
                    output.append(f"Nodes with properties: {nodes_with_props} ({props_pct:.1f}%)")
                
                # Edge properties usage
                cursor.execute("SELECT COUNT(*) FROM edges WHERE properties IS NOT NULL")
                edges_with_props = cursor.fetchone()[0]
                if edges_with_props > 0 and edge_count > 0:
                    props_pct = (edges_with_props / edge_count) * 100
                    output.append(f"Edges with properties: {edges_with_props} ({props_pct:.1f}%)")
                
                # Weight distribution
                cursor.execute("SELECT MIN(weight), MAX(weight), AVG(weight) FROM edges")
                weight_stats = cursor.fetchone()
                if weight_stats[0] is not None:
                    output.append(f"\nEdge weights:")
                    output.append(f"  Min: {weight_stats[0]}")
                    output.append(f"  Max: {weight_stats[1]}")
                    output.append(f"  Avg: {weight_stats[2]:.2f}")
                
                # Most common patterns
                if not relationship_filter:
                    output.append("\n=== Common Patterns ===")
                    
                    # Most common node type connections
                    cursor.execute("""
                        SELECT n1.type, e.relationship, n2.type, COUNT(*) as count
                        FROM edges e
                        JOIN nodes n1 ON e.source = n1.id
                        JOIN nodes n2 ON e.target = n2.id
                        GROUP BY n1.type, e.relationship, n2.type
                        ORDER BY count DESC
                        LIMIT 10
                    """)
                    
                    patterns = cursor.fetchall()
                    if patterns:
                        output.append("Most common connections:")
                        for src_type, rel, tgt_type, count in patterns:
                            output.append(f"  {src_type} --[{rel}]--> {tgt_type}: {count} times")
                
                # Component analysis (simplified)
                output.append("\n=== Graph Structure ===")
                
                # Check if graph is fully connected (simplified)
                cursor.execute("""
                    SELECT COUNT(DISTINCT node_id) FROM (
                        SELECT source as node_id FROM edges
                        UNION
                        SELECT target as node_id FROM edges
                    )
                """)
                connected_nodes = cursor.fetchone()[0]
                
                if connected_nodes < node_count:
                    output.append(f"Connected nodes: {connected_nodes} / {node_count}")
                    output.append("Graph has disconnected components")
                else:
                    output.append("All nodes are connected")
            
            return "\n".join(output)

        except sqlite3.Error as e:
            await tool_ctx.error(f"SQL error: {str(e)}")
            return f"SQL error: {str(e)}"
        except Exception as e:
            await tool_ctx.error(f"Unexpected error: {str(e)}")
            return f"Error getting statistics: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
