"""Unified graph database tool."""

from typing import Annotated, TypedDict, Unpack, final, override, Optional, List, Dict, Any
import json
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action: query (default), add, remove, search, stats",
        default="query",
    ),
]

NodeId = Annotated[
    Optional[str],
    Field(
        description="Node ID",
        default=None,
    ),
]

NodeType = Annotated[
    Optional[str],
    Field(
        description="Node type/label",
        default=None,
    ),
]

EdgeType = Annotated[
    Optional[str],
    Field(
        description="Edge type/relationship",
        default=None,
    ),
]

FromNode = Annotated[
    Optional[str],
    Field(
        description="Source node ID for edges",
        default=None,
    ),
]

ToNode = Annotated[
    Optional[str],
    Field(
        description="Target node ID for edges",
        default=None,
    ),
]

Properties = Annotated[
    Optional[Dict[str, Any]],
    Field(
        description="Node/edge properties as JSON",
        default=None,
    ),
]

Pattern = Annotated[
    Optional[str],
    Field(
        description="Search pattern for properties",
        default=None,
    ),
]

Depth = Annotated[
    int,
    Field(
        description="Max traversal depth for queries",
        default=2,
    ),
]

Limit = Annotated[
    int,
    Field(
        description="Maximum results to return",
        default=50,
    ),
]


class GraphParams(TypedDict, total=False):
    """Parameters for graph tool."""
    action: str
    node_id: Optional[str]
    node_type: Optional[str]
    edge_type: Optional[str]
    from_node: Optional[str]
    to_node: Optional[str]
    properties: Optional[Dict[str, Any]]
    pattern: Optional[str]
    depth: int
    limit: int


@final
class GraphTool(BaseTool):
    """Unified graph database tool."""
    
    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the graph tool."""
        super().__init__(permission_manager)
        self.db_manager = db_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "graph"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Graph database. Actions: query (default), add, remove, search, stats.

Usage:
graph --node-id user123
graph --action add --node-id user123 --node-type User --properties '{"name": "John"}'
graph --action add --from-node user123 --to-node post456 --edge-type CREATED
graph --action query --node-id user123 --depth 3
graph --action search --pattern "John" --node-type User
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GraphParams],
    ) -> str:
        """Execute graph operation."""
        tool_ctx = self.create_tool_context(ctx)

        # Get current project database
        project_db = self.db_manager.get_current_project_db()
        if not project_db:
            return "Error: No project database found. Are you in a project directory?"

        # Extract action
        action = params.get("action", "query")
        
        # Route to appropriate handler
        if action == "query":
            return await self._handle_query(project_db, params, tool_ctx)
        elif action == "add":
            return await self._handle_add(project_db, params, tool_ctx)
        elif action == "remove":
            return await self._handle_remove(project_db, params, tool_ctx)
        elif action == "search":
            return await self._handle_search(project_db, params, tool_ctx)
        elif action == "stats":
            return await self._handle_stats(project_db, tool_ctx)
        else:
            return f"Error: Unknown action '{action}'. Valid actions: query, add, remove, search, stats"

    async def _handle_query(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Query graph relationships."""
        node_id = params.get("node_id")
        node_type = params.get("node_type")
        depth = params.get("depth", 2)
        limit = params.get("limit", 50)
        
        if not node_id and not node_type:
            return "Error: node_id or node_type required for query"
        
        try:
            with project_db.get_graph_connection() as conn:
                results = []
                
                if node_id:
                    # Query specific node and its relationships
                    cursor = conn.execute("""
                        WITH RECURSIVE
                        node_tree(id, type, properties, depth, path) AS (
                            SELECT id, type, properties, 0, id
                            FROM nodes
                            WHERE id = ?
                            
                            UNION ALL
                            
                            SELECT n.id, n.type, n.properties, nt.depth + 1,
                                   nt.path || ' -> ' || n.id
                            FROM nodes n
                            JOIN edges e ON (e.to_node = n.id OR e.from_node = n.id)
                            JOIN node_tree nt ON (
                                (e.from_node = nt.id AND e.to_node = n.id) OR
                                (e.to_node = nt.id AND e.from_node = n.id)
                            )
                            WHERE nt.depth < ?
                        )
                        SELECT DISTINCT * FROM node_tree
                        ORDER BY depth, id
                        LIMIT ?
                    """, (node_id, depth, limit))
                    
                    nodes = cursor.fetchall()
                    
                    # Get edges
                    cursor = conn.execute("""
                        SELECT from_node, to_node, type, properties
                        FROM edges
                        WHERE from_node IN (SELECT id FROM node_tree)
                           OR to_node IN (SELECT id FROM node_tree)
                    """)
                    
                    edges = cursor.fetchall()
                    
                else:
                    # Query by type
                    cursor = conn.execute("""
                        SELECT id, type, properties
                        FROM nodes
                        WHERE type = ?
                        LIMIT ?
                    """, (node_type, limit))
                    
                    nodes = cursor.fetchall()
                    edges = []
                
                # Format results
                output = ["=== Graph Query Results ==="]
                
                if nodes:
                    output.append(f"\nNodes ({len(nodes)}):")
                    for node in nodes:
                        props = json.loads(node[2]) if node[2] else {}
                        output.append(f"  {node[0]} [{node[1]}] {props}")
                
                if edges:
                    output.append(f"\nEdges ({len(edges)}):")
                    for edge in edges:
                        props = json.loads(edge[3]) if edge[3] else {}
                        output.append(f"  {edge[0]} --[{edge[2]}]--> {edge[1]} {props}")
                
                if not nodes and not edges:
                    output.append("No results found")
                
                return "\n".join(output)
                
        except Exception as e:
            await tool_ctx.error(f"Query failed: {str(e)}")
            return f"Error during query: {str(e)}"

    async def _handle_add(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Add nodes or edges."""
        node_id = params.get("node_id")
        from_node = params.get("from_node")
        to_node = params.get("to_node")
        
        if node_id:
            # Add node
            node_type = params.get("node_type")
            if not node_type:
                return "Error: node_type required when adding node"
            
            properties = params.get("properties", {})
            
            try:
                with project_db.get_graph_connection() as conn:
                    conn.execute("""
                        INSERT OR REPLACE INTO nodes (id, type, properties)
                        VALUES (?, ?, ?)
                    """, (node_id, node_type, json.dumps(properties)))
                    conn.commit()
                
                await tool_ctx.info(f"Added node: {node_id}")
                return f"Added node {node_id} [{node_type}]"
                
            except Exception as e:
                await tool_ctx.error(f"Failed to add node: {str(e)}")
                return f"Error adding node: {str(e)}"
        
        elif from_node and to_node:
            # Add edge
            edge_type = params.get("edge_type", "RELATED")
            properties = params.get("properties", {})
            
            try:
                with project_db.get_graph_connection() as conn:
                    conn.execute("""
                        INSERT OR REPLACE INTO edges (from_node, to_node, type, properties)
                        VALUES (?, ?, ?, ?)
                    """, (from_node, to_node, edge_type, json.dumps(properties)))
                    conn.commit()
                
                await tool_ctx.info(f"Added edge: {from_node} -> {to_node}")
                return f"Added edge {from_node} --[{edge_type}]--> {to_node}"
                
            except Exception as e:
                await tool_ctx.error(f"Failed to add edge: {str(e)}")
                return f"Error adding edge: {str(e)}"
        
        else:
            return "Error: Either node_id (for node) or from_node + to_node (for edge) required"

    async def _handle_remove(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Remove nodes or edges."""
        node_id = params.get("node_id")
        from_node = params.get("from_node")
        to_node = params.get("to_node")
        
        if node_id:
            # Remove node and its edges
            try:
                with project_db.get_graph_connection() as conn:
                    # Delete edges first
                    cursor = conn.execute("""
                        DELETE FROM edges
                        WHERE from_node = ? OR to_node = ?
                    """, (node_id, node_id))
                    
                    edges_deleted = cursor.rowcount
                    
                    # Delete node
                    cursor = conn.execute("""
                        DELETE FROM nodes WHERE id = ?
                    """, (node_id,))
                    
                    if cursor.rowcount == 0:
                        return f"Node {node_id} not found"
                    
                    conn.commit()
                
                msg = f"Removed node {node_id}"
                if edges_deleted > 0:
                    msg += f" and {edges_deleted} connected edges"
                
                await tool_ctx.info(msg)
                return msg
                
            except Exception as e:
                await tool_ctx.error(f"Failed to remove node: {str(e)}")
                return f"Error removing node: {str(e)}"
        
        elif from_node and to_node:
            # Remove specific edge
            edge_type = params.get("edge_type")
            
            try:
                with project_db.get_graph_connection() as conn:
                    if edge_type:
                        cursor = conn.execute("""
                            DELETE FROM edges
                            WHERE from_node = ? AND to_node = ? AND type = ?
                        """, (from_node, to_node, edge_type))
                    else:
                        cursor = conn.execute("""
                            DELETE FROM edges
                            WHERE from_node = ? AND to_node = ?
                        """, (from_node, to_node))
                    
                    if cursor.rowcount == 0:
                        return f"Edge not found"
                    
                    conn.commit()
                
                return f"Removed edge {from_node} --> {to_node}"
                
            except Exception as e:
                await tool_ctx.error(f"Failed to remove edge: {str(e)}")
                return f"Error removing edge: {str(e)}"
        
        else:
            return "Error: Either node_id or from_node + to_node required for remove"

    async def _handle_search(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Search graph by pattern."""
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern required for search"
        
        node_type = params.get("node_type")
        limit = params.get("limit", 50)
        
        try:
            with project_db.get_graph_connection() as conn:
                # Search in properties
                if node_type:
                    cursor = conn.execute("""
                        SELECT id, type, properties
                        FROM nodes
                        WHERE type = ? AND properties LIKE ?
                        LIMIT ?
                    """, (node_type, f"%{pattern}%", limit))
                else:
                    cursor = conn.execute("""
                        SELECT id, type, properties
                        FROM nodes
                        WHERE properties LIKE ?
                        LIMIT ?
                    """, (f"%{pattern}%", limit))
                
                results = cursor.fetchall()
                
                if not results:
                    return f"No nodes found matching '{pattern}'"
                
                # Format results
                output = [f"=== Graph Search Results for '{pattern}' ==="]
                output.append(f"Found {len(results)} nodes\n")
                
                for node in results:
                    props = json.loads(node[2]) if node[2] else {}
                    output.append(f"{node[0]} [{node[1]}] {props}")
                
                return "\n".join(output)
                
        except Exception as e:
            await tool_ctx.error(f"Search failed: {str(e)}")
            return f"Error during search: {str(e)}"

    async def _handle_stats(self, project_db, tool_ctx) -> str:
        """Get graph statistics."""
        try:
            with project_db.get_graph_connection() as conn:
                # Node stats
                cursor = conn.execute("""
                    SELECT type, COUNT(*) as count
                    FROM nodes
                    GROUP BY type
                    ORDER BY count DESC
                """)
                
                node_stats = cursor.fetchall()
                
                # Edge stats
                cursor = conn.execute("""
                    SELECT type, COUNT(*) as count
                    FROM edges
                    GROUP BY type
                    ORDER BY count DESC
                """)
                
                edge_stats = cursor.fetchall()
                
                # Total counts
                cursor = conn.execute("SELECT COUNT(*) FROM nodes")
                total_nodes = cursor.fetchone()[0]
                
                cursor = conn.execute("SELECT COUNT(*) FROM edges")
                total_edges = cursor.fetchone()[0]
                
                # Format output
                output = [f"=== Graph Database Statistics ==="]
                output.append(f"Project: {project_db.project_path}")
                output.append(f"\nTotal nodes: {total_nodes}")
                output.append(f"Total edges: {total_edges}")
                
                if node_stats:
                    output.append("\nNodes by type:")
                    for node_type, count in node_stats:
                        output.append(f"  {node_type}: {count}")
                
                if edge_stats:
                    output.append("\nEdges by type:")
                    for edge_type, count in edge_stats:
                        output.append(f"  {edge_type}: {count}")
                
                return "\n".join(output)
                
        except Exception as e:
            await tool_ctx.error(f"Failed to get stats: {str(e)}")
            return f"Error getting stats: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass