"""Graph query tool for querying the graph database."""

import json
import sqlite3
from typing import Annotated, Optional, TypedDict, Unpack, final, override, List, Dict, Any
from collections import deque

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


Query = Annotated[
    str,
    Field(
        description="Query type: neighbors, path, subgraph, connected, ancestors, descendants",
        min_length=1,
    ),
]

NodeId = Annotated[
    Optional[str],
    Field(
        description="Starting node ID",
        default=None,
    ),
]

TargetId = Annotated[
    Optional[str],
    Field(
        description="Target node ID (for path queries)",
        default=None,
    ),
]

Depth = Annotated[
    int,
    Field(
        description="Maximum depth for traversal",
        default=2,
    ),
]

Relationship = Annotated[
    Optional[str],
    Field(
        description="Filter by relationship type",
        default=None,
    ),
]

NodeType = Annotated[
    Optional[str],
    Field(
        description="Filter by node type",
        default=None,
    ),
]

Direction = Annotated[
    str,
    Field(
        description="Direction: both, incoming, outgoing",
        default="both",
    ),
]

ProjectPath = Annotated[
    Optional[str],
    Field(
        description="Project path (defaults to current directory)",
        default=None,
    ),
]


class GraphQueryParams(TypedDict, total=False):
    """Parameters for graph query tool."""

    query: str
    node_id: Optional[str]
    target_id: Optional[str]
    depth: int
    relationship: Optional[str]
    node_type: Optional[str]
    direction: str
    project_path: Optional[str]


@final
class GraphQueryTool(BaseTool):
    """Tool for querying the graph database."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the graph query tool.

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
        return "graph_query"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Query the project's graph database for relationships and patterns.

Query types:
- neighbors: Find direct neighbors of a node
- path: Find shortest path between two nodes
- subgraph: Get subgraph around a node up to depth
- connected: Find all nodes connected to a node
- ancestors: Find nodes that point TO this node
- descendants: Find nodes that this node points TO

Options:
- --depth: Max traversal depth (default 2)
- --relationship: Filter by edge type
- --node-type: Filter by node type
- --direction: both, incoming, outgoing

Examples:
- graph_query --query neighbors --node-id "main.py"
- graph_query --query path --node-id "main.py" --target-id "utils.py"
- graph_query --query subgraph --node-id "MyClass" --depth 3
- graph_query --query ancestors --node-id "error_handler" --relationship "calls"
- graph_query --query descendants --node-id "BaseClass" --relationship "inherits"
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GraphQueryParams],
    ) -> str:
        """Execute graph query.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Query results
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        query = params.get("query")
        if not query:
            return "Error: query is required"

        node_id = params.get("node_id")
        target_id = params.get("target_id")
        depth = params.get("depth", 2)
        relationship = params.get("relationship")
        node_type = params.get("node_type")
        direction = params.get("direction", "both")
        project_path = params.get("project_path")

        # Validate query type
        valid_queries = ["neighbors", "path", "subgraph", "connected", "ancestors", "descendants"]
        if query not in valid_queries:
            return f"Error: Invalid query '{query}'. Must be one of: {', '.join(valid_queries)}"

        # Validate required parameters
        if query in ["neighbors", "subgraph", "connected", "ancestors", "descendants"] and not node_id:
            return f"Error: node_id is required for '{query}' query"

        if query == "path" and (not node_id or not target_id):
            return "Error: Both node_id and target_id are required for 'path' query"

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

        await tool_ctx.info(f"Executing {query} query")

        try:
            if query == "neighbors":
                return self._query_neighbors(graph_conn, node_id, relationship, node_type, direction)
            elif query == "path":
                return self._query_path(graph_conn, node_id, target_id, relationship)
            elif query == "subgraph":
                return self._query_subgraph(graph_conn, node_id, depth, relationship, node_type, direction)
            elif query == "connected":
                return self._query_connected(graph_conn, node_id, relationship, node_type, direction)
            elif query == "ancestors":
                return self._query_ancestors(graph_conn, node_id, depth, relationship, node_type)
            elif query == "descendants":
                return self._query_descendants(graph_conn, node_id, depth, relationship, node_type)

        except Exception as e:
            await tool_ctx.error(f"Failed to execute query: {str(e)}")
            return f"Error executing query: {str(e)}"

    def _query_neighbors(self, conn: sqlite3.Connection, node_id: str, 
                        relationship: Optional[str], node_type: Optional[str], 
                        direction: str) -> str:
        """Get direct neighbors of a node."""
        cursor = conn.cursor()
        
        # Check if node exists
        cursor.execute("SELECT type, properties FROM nodes WHERE id = ?", (node_id,))
        node_info = cursor.fetchone()
        if not node_info:
            return f"Error: Node '{node_id}' not found"

        neighbors = []
        
        # Get outgoing edges
        if direction in ["both", "outgoing"]:
            query = """SELECT e.target, e.relationship, e.weight, n.type, n.properties
                      FROM edges e JOIN nodes n ON e.target = n.id
                      WHERE e.source = ?"""
            params = [node_id]
            
            if relationship:
                query += " AND e.relationship = ?"
                params.append(relationship)
            if node_type:
                query += " AND n.type = ?"
                params.append(node_type)
                
            cursor.execute(query, params)
            for row in cursor.fetchall():
                neighbors.append({
                    "direction": "outgoing",
                    "node_id": row[0],
                    "relationship": row[1],
                    "weight": row[2],
                    "node_type": row[3],
                    "properties": json.loads(row[4]) if row[4] else {}
                })
        
        # Get incoming edges
        if direction in ["both", "incoming"]:
            query = """SELECT e.source, e.relationship, e.weight, n.type, n.properties
                      FROM edges e JOIN nodes n ON e.source = n.id
                      WHERE e.target = ?"""
            params = [node_id]
            
            if relationship:
                query += " AND e.relationship = ?"
                params.append(relationship)
            if node_type:
                query += " AND n.type = ?"
                params.append(node_type)
                
            cursor.execute(query, params)
            for row in cursor.fetchall():
                neighbors.append({
                    "direction": "incoming",
                    "node_id": row[0],
                    "relationship": row[1],
                    "weight": row[2],
                    "node_type": row[3],
                    "properties": json.loads(row[4]) if row[4] else {}
                })
        
        if not neighbors:
            return f"No neighbors found for node '{node_id}'"
        
        # Format output
        output = [f"Neighbors of '{node_id}' ({node_info[0]}):\n"]
        for n in neighbors:
            arrow = "<--" if n["direction"] == "incoming" else "-->"
            output.append(f"  {node_id} {arrow}[{n['relationship']}]--> {n['node_id']} ({n['node_type']})")
            if n["properties"]:
                output.append(f"    Properties: {json.dumps(n['properties'], indent=6)[:100]}")
        
        output.append(f"\nTotal neighbors: {len(neighbors)}")
        return "\n".join(output)

    def _query_path(self, conn: sqlite3.Connection, start: str, end: str, 
                   relationship: Optional[str]) -> str:
        """Find shortest path between two nodes using BFS."""
        cursor = conn.cursor()
        
        # Check if nodes exist
        cursor.execute("SELECT id FROM nodes WHERE id IN (?, ?)", (start, end))
        existing = [row[0] for row in cursor.fetchall()]
        if start not in existing:
            return f"Error: Start node '{start}' not found"
        if end not in existing:
            return f"Error: End node '{end}' not found"
        
        # BFS to find shortest path
        queue = deque([(start, [start])])
        visited = {start}
        
        while queue:
            current, path = queue.popleft()
            
            if current == end:
                # Found path, get edge details
                output = [f"Shortest path from '{start}' to '{end}':\n"]
                
                for i in range(len(path) - 1):
                    src, tgt = path[i], path[i + 1]
                    
                    # Get edge details
                    query = "SELECT relationship, weight FROM edges WHERE source = ? AND target = ?"
                    cursor.execute(query, (src, tgt))
                    edge = cursor.fetchone()
                    
                    if edge:
                        output.append(f"  {src} --[{edge[0]}]--> {tgt}")
                    else:
                        output.append(f"  {src} --> {tgt}")
                
                output.append(f"\nPath length: {len(path) - 1} edge(s)")
                return "\n".join(output)
            
            # Get neighbors
            query = "SELECT target FROM edges WHERE source = ?"
            params = [current]
            if relationship:
                query += " AND relationship = ?"
                params.append(relationship)
                
            cursor.execute(query, params)
            
            for (neighbor,) in cursor.fetchall():
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, path + [neighbor]))
        
        return f"No path found from '{start}' to '{end}'" + (f" with relationship '{relationship}'" if relationship else "")

    def _query_subgraph(self, conn: sqlite3.Connection, node_id: str, depth: int,
                       relationship: Optional[str], node_type: Optional[str], 
                       direction: str) -> str:
        """Get subgraph around a node up to specified depth."""
        cursor = conn.cursor()
        
        # Check if node exists
        cursor.execute("SELECT type FROM nodes WHERE id = ?", (node_id,))
        if not cursor.fetchone():
            return f"Error: Node '{node_id}' not found"
        
        # BFS to collect nodes and edges
        nodes = {node_id: 0}  # node_id -> depth
        edges = set()  # (source, target, relationship)
        queue = deque([(node_id, 0)])
        
        while queue:
            current, current_depth = queue.popleft()
            
            if current_depth >= depth:
                continue
            
            # Get edges based on direction
            if direction in ["both", "outgoing"]:
                query = """SELECT e.target, e.relationship, n.type 
                          FROM edges e JOIN nodes n ON e.target = n.id
                          WHERE e.source = ?"""
                params = [current]
                
                if relationship:
                    query += " AND e.relationship = ?"
                    params.append(relationship)
                if node_type:
                    query += " AND n.type = ?"
                    params.append(node_type)
                    
                cursor.execute(query, params)
                
                for target, rel, _ in cursor.fetchall():
                    edges.add((current, target, rel))
                    if target not in nodes or nodes[target] > current_depth + 1:
                        nodes[target] = current_depth + 1
                        queue.append((target, current_depth + 1))
            
            if direction in ["both", "incoming"]:
                query = """SELECT e.source, e.relationship, n.type 
                          FROM edges e JOIN nodes n ON e.source = n.id
                          WHERE e.target = ?"""
                params = [current]
                
                if relationship:
                    query += " AND e.relationship = ?"
                    params.append(relationship)
                if node_type:
                    query += " AND n.type = ?"
                    params.append(node_type)
                    
                cursor.execute(query, params)
                
                for source, rel, _ in cursor.fetchall():
                    edges.add((source, current, rel))
                    if source not in nodes or nodes[source] > current_depth + 1:
                        nodes[source] = current_depth + 1
                        queue.append((source, current_depth + 1))
        
        # Format output
        output = [f"Subgraph around '{node_id}' (depth={depth}):\n"]
        output.append(f"Nodes ({len(nodes)}):")
        
        # Get node details
        for node, d in sorted(nodes.items(), key=lambda x: (x[1], x[0])):
            cursor.execute("SELECT type FROM nodes WHERE id = ?", (node,))
            node_type = cursor.fetchone()[0]
            output.append(f"  [{d}] {node} ({node_type})")
        
        output.append(f"\nEdges ({len(edges)}):")
        for src, tgt, rel in sorted(edges):
            output.append(f"  {src} --[{rel}]--> {tgt}")
        
        return "\n".join(output)

    def _query_connected(self, conn: sqlite3.Connection, node_id: str,
                        relationship: Optional[str], node_type: Optional[str], 
                        direction: str) -> str:
        """Find all nodes connected to a node (transitive closure)."""
        cursor = conn.cursor()
        
        # Check if node exists
        cursor.execute("SELECT type FROM nodes WHERE id = ?", (node_id,))
        if not cursor.fetchone():
            return f"Error: Node '{node_id}' not found"
        
        # BFS to find all connected nodes
        visited = {node_id}
        queue = deque([node_id])
        connections = []  # (node_id, node_type, distance)
        distance = {node_id: 0}
        
        while queue:
            current = queue.popleft()
            current_dist = distance[current]
            
            # Get edges based on direction
            neighbors = []
            
            if direction in ["both", "outgoing"]:
                query = """SELECT e.target, n.type FROM edges e 
                          JOIN nodes n ON e.target = n.id
                          WHERE e.source = ?"""
                params = [current]
                
                if relationship:
                    query += " AND e.relationship = ?"
                    params.append(relationship)
                if node_type:
                    query += " AND n.type = ?"
                    params.append(node_type)
                    
                cursor.execute(query, params)
                neighbors.extend(cursor.fetchall())
            
            if direction in ["both", "incoming"]:
                query = """SELECT e.source, n.type FROM edges e 
                          JOIN nodes n ON e.source = n.id
                          WHERE e.target = ?"""
                params = [current]
                
                if relationship:
                    query += " AND e.relationship = ?"
                    params.append(relationship)
                if node_type:
                    query += " AND n.type = ?"
                    params.append(node_type)
                    
                cursor.execute(query, params)
                neighbors.extend(cursor.fetchall())
            
            for neighbor, n_type in neighbors:
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)
                    distance[neighbor] = current_dist + 1
                    connections.append((neighbor, n_type, current_dist + 1))
        
        if not connections:
            return f"No connected nodes found for '{node_id}'"
        
        # Format output
        output = [f"Nodes connected to '{node_id}' ({direction}):"]
        output.append(f"\nTotal connected: {len(connections)}\n")
        
        # Group by distance
        by_distance = {}
        for node, n_type, dist in connections:
            if dist not in by_distance:
                by_distance[dist] = []
            by_distance[dist].append((node, n_type))
        
        for dist in sorted(by_distance.keys()):
            output.append(f"Distance {dist}:")
            for node, n_type in sorted(by_distance[dist]):
                output.append(f"  {node} ({n_type})")
        
        return "\n".join(output)

    def _query_ancestors(self, conn: sqlite3.Connection, node_id: str, depth: int,
                        relationship: Optional[str], node_type: Optional[str]) -> str:
        """Find nodes that point TO this node (incoming edges only)."""
        return self._query_subgraph(conn, node_id, depth, relationship, node_type, "incoming")

    def _query_descendants(self, conn: sqlite3.Connection, node_id: str, depth: int,
                          relationship: Optional[str], node_type: Optional[str]) -> str:
        """Find nodes that this node points TO (outgoing edges only)."""
        return self._query_subgraph(conn, node_id, depth, relationship, node_type, "outgoing")

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
