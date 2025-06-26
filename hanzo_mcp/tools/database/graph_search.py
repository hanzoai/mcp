"""Graph search tool for searching nodes and edges in the graph database."""

import json
import sqlite3
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


Pattern = Annotated[
    str,
    Field(
        description="Search pattern (SQL LIKE syntax, % for wildcard)",
        min_length=1,
    ),
]

SearchType = Annotated[
    str,
    Field(
        description="What to search: nodes, edges, properties, all",
        default="all",
    ),
]

NodeType = Annotated[
    Optional[str],
    Field(
        description="Filter by node type",
        default=None,
    ),
]

Relationship = Annotated[
    Optional[str],
    Field(
        description="Filter by relationship type",
        default=None,
    ),
]

ProjectPath = Annotated[
    Optional[str],
    Field(
        description="Project path (defaults to current directory)",
        default=None,
    ),
]

MaxResults = Annotated[
    int,
    Field(
        description="Maximum number of results",
        default=50,
    ),
]


class GraphSearchParams(TypedDict, total=False):
    """Parameters for graph search tool."""

    pattern: str
    search_type: str
    node_type: Optional[str]
    relationship: Optional[str]
    project_path: Optional[str]
    max_results: int


@final
class GraphSearchTool(BaseTool):
    """Tool for searching nodes and edges in graph database."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the graph search tool.

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
        return "graph_search"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Search for nodes and edges in the project's graph database.

Search types:
- nodes: Search in node IDs
- edges: Search in edge relationships
- properties: Search in node/edge properties
- all: Search everywhere (default)

Supports SQL LIKE pattern matching:
- % matches any sequence of characters
- _ matches any single character

Examples:
- graph_search --pattern "%test%"                    # Find anything with 'test'
- graph_search --pattern "%.py" --search-type nodes  # Find Python files
- graph_search --pattern "%import%" --search-type edges
- graph_search --pattern "%TODO%" --search-type properties
- graph_search --pattern "MyClass%" --node-type "class"
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GraphSearchParams],
    ) -> str:
        """Execute graph search.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Search results
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern is required"

        search_type = params.get("search_type", "all")
        node_type = params.get("node_type")
        relationship = params.get("relationship")
        project_path = params.get("project_path")
        max_results = params.get("max_results", 50)

        # Validate search type
        valid_types = ["nodes", "edges", "properties", "all"]
        if search_type not in valid_types:
            return f"Error: Invalid search_type '{search_type}'. Must be one of: {', '.join(valid_types)}"

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

        await tool_ctx.info(f"Searching graph for pattern: {pattern}")

        # Get graph connection
        graph_conn = project_db.get_graph_connection()
        results = []

        try:
            cursor = graph_conn.cursor()
            
            # Search nodes
            if search_type in ["nodes", "all"]:
                query = "SELECT id, type, properties FROM nodes WHERE id LIKE ?"
                params_list = [pattern]
                
                if node_type:
                    query += " AND type = ?"
                    params_list.append(node_type)
                
                if search_type == "nodes":
                    query += f" LIMIT {max_results}"
                    
                cursor.execute(query, params_list)
                
                for row in cursor.fetchall():
                    results.append({
                        "type": "node",
                        "id": row[0],
                        "node_type": row[1],
                        "properties": json.loads(row[2]) if row[2] else {},
                        "match_field": "id"
                    })
            
            # Search edges
            if search_type in ["edges", "all"]:
                query = """SELECT source, target, relationship, weight, properties 
                          FROM edges WHERE relationship LIKE ?"""
                params_list = [pattern]
                
                if relationship:
                    query += " AND relationship = ?"
                    params_list.append(relationship)
                
                if search_type == "edges":
                    query += f" LIMIT {max_results}"
                    
                cursor.execute(query, params_list)
                
                for row in cursor.fetchall():
                    results.append({
                        "type": "edge",
                        "source": row[0],
                        "target": row[1],
                        "relationship": row[2],
                        "weight": row[3],
                        "properties": json.loads(row[4]) if row[4] else {},
                        "match_field": "relationship"
                    })
            
            # Search in properties
            if search_type in ["properties", "all"]:
                # Search node properties
                query = """SELECT id, type, properties FROM nodes 
                          WHERE properties IS NOT NULL AND properties LIKE ?"""
                params_list = [f"%{pattern}%"]
                
                if node_type:
                    query += " AND type = ?"
                    params_list.append(node_type)
                    
                cursor.execute(query, params_list)
                
                for row in cursor.fetchall():
                    props = json.loads(row[2]) if row[2] else {}
                    # Check which property matches
                    matching_props = {}
                    for key, value in props.items():
                        if pattern.replace('%', '').lower() in str(value).lower():
                            matching_props[key] = value
                    
                    if matching_props:
                        results.append({
                            "type": "node",
                            "id": row[0],
                            "node_type": row[1],
                            "properties": props,
                            "match_field": "properties",
                            "matching_properties": matching_props
                        })
                
                # Search edge properties
                query = """SELECT source, target, relationship, weight, properties 
                          FROM edges WHERE properties IS NOT NULL AND properties LIKE ?"""
                params_list = [f"%{pattern}%"]
                
                if relationship:
                    query += " AND relationship = ?"
                    params_list.append(relationship)
                    
                cursor.execute(query, params_list)
                
                for row in cursor.fetchall():
                    props = json.loads(row[4]) if row[4] else {}
                    # Check which property matches
                    matching_props = {}
                    for key, value in props.items():
                        if pattern.replace('%', '').lower() in str(value).lower():
                            matching_props[key] = value
                    
                    if matching_props:
                        results.append({
                            "type": "edge",
                            "source": row[0],
                            "target": row[1],
                            "relationship": row[2],
                            "weight": row[3],
                            "properties": props,
                            "match_field": "properties",
                            "matching_properties": matching_props
                        })
            
            # Limit total results if searching all
            if search_type == "all" and len(results) > max_results:
                results = results[:max_results]
            
            if not results:
                return f"No results found for pattern '{pattern}'"
            
            # Format results
            output = [f"Found {len(results)} result(s) for pattern '{pattern}':\n"]
            
            # Group by type
            nodes = [r for r in results if r["type"] == "node"]
            edges = [r for r in results if r["type"] == "edge"]
            
            if nodes:
                output.append(f"Nodes ({len(nodes)}):")
                for node in nodes[:20]:  # Show first 20
                    output.append(f"  {node['id']} ({node['node_type']})")
                    if node["match_field"] == "properties" and "matching_properties" in node:
                        output.append(f"    Matched in: {list(node['matching_properties'].keys())}")
                    if node["properties"] and node["match_field"] != "properties":
                        props_str = json.dumps(node["properties"], indent=6)[:100]
                        if len(props_str) == 100:
                            props_str += "..."
                        output.append(f"    Properties: {props_str}")
                
                if len(nodes) > 20:
                    output.append(f"  ... and {len(nodes) - 20} more nodes")
                output.append("")
            
            if edges:
                output.append(f"Edges ({len(edges)}):")
                for edge in edges[:20]:  # Show first 20
                    output.append(f"  {edge['source']} --[{edge['relationship']}]--> {edge['target']}")
                    if edge["match_field"] == "properties" and "matching_properties" in edge:
                        output.append(f"    Matched in: {list(edge['matching_properties'].keys())}")
                    if edge["weight"] != 1.0:
                        output.append(f"    Weight: {edge['weight']}")
                    if edge["properties"]:
                        props_str = json.dumps(edge["properties"], indent=6)[:100]
                        if len(props_str) == 100:
                            props_str += "..."
                        output.append(f"    Properties: {props_str}")
                
                if len(edges) > 20:
                    output.append(f"  ... and {len(edges) - 20} more edges")
            
            return "\n".join(output)

        except sqlite3.Error as e:
            await tool_ctx.error(f"SQL error: {str(e)}")
            return f"SQL error: {str(e)}"
        except Exception as e:
            await tool_ctx.error(f"Unexpected error: {str(e)}")
            return f"Error executing search: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
