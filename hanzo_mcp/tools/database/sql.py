"""Unified SQL database tool."""

from typing import Annotated, TypedDict, Unpack, final, override, Optional, List, Dict, Any
import sqlite3
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


# Parameter types
Query = Annotated[
    Optional[str],
    Field(
        description="SQL query to execute",
        default=None,
    ),
]

Pattern = Annotated[
    Optional[str],
    Field(
        description="Search pattern for table/column names or data",
        default=None,
    ),
]

Table = Annotated[
    Optional[str],
    Field(
        description="Table name for operations",
        default=None,
    ),
]

Action = Annotated[
    str,
    Field(
        description="Action: query (default), search, schema, stats",
        default="query",
    ),
]

Limit = Annotated[
    int,
    Field(
        description="Maximum rows to return",
        default=100,
    ),
]


class SQLParams(TypedDict, total=False):
    """Parameters for SQL tool."""
    query: Optional[str]
    pattern: Optional[str]
    table: Optional[str]
    action: str
    limit: int


@final
class SQLTool(BaseTool):
    """Unified SQL database tool."""
    
    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the SQL tool."""
        super().__init__(permission_manager)
        self.db_manager = db_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "sql"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """SQLite database. Actions: query (default), search, schema, stats.

Usage:
sql "SELECT * FROM users WHERE active = 1"
sql --action schema
sql --action search --pattern "john"
sql --action stats --table users
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[SQLParams],
    ) -> str:
        """Execute SQL operation."""
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
        elif action == "search":
            return await self._handle_search(project_db, params, tool_ctx)
        elif action == "schema":
            return await self._handle_schema(project_db, params, tool_ctx)
        elif action == "stats":
            return await self._handle_stats(project_db, params, tool_ctx)
        else:
            return f"Error: Unknown action '{action}'. Valid actions: query, search, schema, stats"

    async def _handle_query(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Execute SQL query."""
        query = params.get("query")
        if not query:
            return "Error: query required for query action"
        
        limit = params.get("limit", 100)
        
        try:
            with project_db.get_sqlite_connection() as conn:
                # Enable row factory for dict-like access
                conn.row_factory = sqlite3.Row
                
                # Add LIMIT if not present in SELECT queries
                query_upper = query.upper().strip()
                if query_upper.startswith("SELECT") and "LIMIT" not in query_upper:
                    query = f"{query} LIMIT {limit}"
                
                cursor = conn.execute(query)
                
                # Handle different query types
                if query_upper.startswith("SELECT"):
                    rows = cursor.fetchall()
                    
                    if not rows:
                        return "No results found"
                    
                    # Get column names
                    columns = [description[0] for description in cursor.description]
                    
                    # Format as table
                    output = ["=== Query Results ==="]
                    output.append(f"Columns: {', '.join(columns)}")
                    output.append("-" * 60)
                    
                    for row in rows:
                        row_data = []
                        for col in columns:
                            value = row[col]
                            if value is None:
                                value = "NULL"
                            elif isinstance(value, str) and len(value) > 50:
                                value = value[:50] + "..."
                            row_data.append(str(value))
                        output.append(" | ".join(row_data))
                    
                    output.append(f"\nRows returned: {len(rows)}")
                    if len(rows) == limit:
                        output.append(f"(Limited to {limit} rows)")
                    
                    return "\n".join(output)
                
                else:
                    # For INSERT, UPDATE, DELETE
                    conn.commit()
                    rows_affected = cursor.rowcount
                    
                    if query_upper.startswith("INSERT"):
                        return f"Inserted {rows_affected} row(s)"
                    elif query_upper.startswith("UPDATE"):
                        return f"Updated {rows_affected} row(s)"
                    elif query_upper.startswith("DELETE"):
                        return f"Deleted {rows_affected} row(s)"
                    else:
                        return f"Query executed successfully. Rows affected: {rows_affected}"
                
        except Exception as e:
            await tool_ctx.error(f"Query failed: {str(e)}")
            return f"Error executing query: {str(e)}"

    async def _handle_search(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Search for data in tables."""
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern required for search action"
        
        table = params.get("table")
        limit = params.get("limit", 100)
        
        try:
            with project_db.get_sqlite_connection() as conn:
                conn.row_factory = sqlite3.Row
                
                # Get all tables if not specified
                if not table:
                    cursor = conn.execute("""
                        SELECT name FROM sqlite_master 
                        WHERE type='table' AND name NOT LIKE 'sqlite_%'
                    """)
                    tables = [row[0] for row in cursor.fetchall()]
                else:
                    tables = [table]
                
                all_results = []
                
                for tbl in tables:
                    # Get columns
                    cursor = conn.execute(f"PRAGMA table_info({tbl})")
                    columns = [row[1] for row in cursor.fetchall()]
                    
                    # Build search query
                    where_clauses = [f"{col} LIKE ?" for col in columns]
                    query = f"SELECT * FROM {tbl} WHERE {' OR '.join(where_clauses)} LIMIT {limit}"
                    
                    # Search
                    cursor = conn.execute(query, [f"%{pattern}%"] * len(columns))
                    rows = cursor.fetchall()
                    
                    if rows:
                        all_results.append((tbl, columns, rows))
                
                if not all_results:
                    return f"No results found for pattern '{pattern}'"
                
                # Format results
                output = [f"=== Search Results for '{pattern}' ==="]
                
                for tbl, columns, rows in all_results:
                    output.append(f"\nTable: {tbl}")
                    output.append(f"Columns: {', '.join(columns)}")
                    output.append("-" * 60)
                    
                    for row in rows:
                        row_data = []
                        for col in columns:
                            value = row[col]
                            if value is None:
                                value = "NULL"
                            elif isinstance(value, str):
                                # Highlight matches
                                if pattern.lower() in str(value).lower():
                                    value = f"**{value}**"
                                if len(value) > 50:
                                    value = value[:50] + "..."
                            row_data.append(str(value))
                        output.append(" | ".join(row_data))
                    
                    output.append(f"Found {len(rows)} row(s) in {tbl}")
                
                return "\n".join(output)
                
        except Exception as e:
            await tool_ctx.error(f"Search failed: {str(e)}")
            return f"Error during search: {str(e)}"

    async def _handle_schema(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Show database schema."""
        table = params.get("table")
        
        try:
            with project_db.get_sqlite_connection() as conn:
                if table:
                    # Show specific table schema
                    cursor = conn.execute(f"PRAGMA table_info({table})")
                    columns = cursor.fetchall()
                    
                    if not columns:
                        return f"Table '{table}' not found"
                    
                    output = [f"=== Schema for table '{table}' ==="]
                    output.append("Column | Type | Not Null | Default | Primary Key")
                    output.append("-" * 60)
                    
                    for col in columns:
                        output.append(f"{col[1]} | {col[2]} | {col[3]} | {col[4]} | {col[5]}")
                    
                    # Get indexes
                    cursor = conn.execute(f"PRAGMA index_list({table})")
                    indexes = cursor.fetchall()
                    
                    if indexes:
                        output.append("\nIndexes:")
                        for idx in indexes:
                            output.append(f"  {idx[1]} (unique: {idx[2]})")
                    
                else:
                    # Show all tables
                    cursor = conn.execute("""
                        SELECT name, sql FROM sqlite_master 
                        WHERE type='table' AND name NOT LIKE 'sqlite_%'
                        ORDER BY name
                    """)
                    tables = cursor.fetchall()
                    
                    if not tables:
                        return "No tables found in database"
                    
                    output = ["=== Database Schema ==="]
                    
                    for table_name, create_sql in tables:
                        output.append(f"\nTable: {table_name}")
                        
                        # Get row count
                        cursor = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
                        count = cursor.fetchone()[0]
                        output.append(f"Rows: {count}")
                        
                        # Get columns
                        cursor = conn.execute(f"PRAGMA table_info({table_name})")
                        columns = cursor.fetchall()
                        output.append(f"Columns: {', '.join([col[1] for col in columns])}")
                
                return "\n".join(output)
                
        except Exception as e:
            await tool_ctx.error(f"Failed to get schema: {str(e)}")
            return f"Error getting schema: {str(e)}"

    async def _handle_stats(self, project_db, params: Dict[str, Any], tool_ctx) -> str:
        """Get database statistics."""
        table = params.get("table")
        
        try:
            with project_db.get_sqlite_connection() as conn:
                output = ["=== Database Statistics ==="]
                output.append(f"Database: {project_db.sqlite_path}")
                
                # Get file size
                db_size = project_db.sqlite_path.stat().st_size
                output.append(f"Size: {db_size / 1024 / 1024:.2f} MB")
                
                if table:
                    # Stats for specific table
                    cursor = conn.execute(f"SELECT COUNT(*) FROM {table}")
                    count = cursor.fetchone()[0]
                    
                    output.append(f"\nTable: {table}")
                    output.append(f"Total rows: {count}")
                    
                    # Get column stats
                    cursor = conn.execute(f"PRAGMA table_info({table})")
                    columns = cursor.fetchall()
                    
                    output.append("\nColumn statistics:")
                    for col in columns:
                        col_name = col[1]
                        col_type = col[2]
                        
                        # Get basic stats based on type
                        if "INT" in col_type.upper() or "REAL" in col_type.upper():
                            cursor = conn.execute(f"""
                                SELECT 
                                    MIN({col_name}) as min_val,
                                    MAX({col_name}) as max_val,
                                    AVG({col_name}) as avg_val,
                                    COUNT(DISTINCT {col_name}) as distinct_count
                                FROM {table}
                            """)
                            stats = cursor.fetchone()
                            output.append(f"  {col_name}: min={stats[0]}, max={stats[1]}, avg={stats[2]:.2f}, distinct={stats[3]}")
                        else:
                            cursor = conn.execute(f"""
                                SELECT 
                                    COUNT(DISTINCT {col_name}) as distinct_count,
                                    COUNT(*) - COUNT({col_name}) as null_count
                                FROM {table}
                            """)
                            stats = cursor.fetchone()
                            output.append(f"  {col_name}: distinct={stats[0]}, nulls={stats[1]}")
                
                else:
                    # Overall database stats
                    cursor = conn.execute("""
                        SELECT name FROM sqlite_master 
                        WHERE type='table' AND name NOT LIKE 'sqlite_%'
                    """)
                    tables = cursor.fetchall()
                    
                    output.append(f"\nTotal tables: {len(tables)}")
                    output.append("\nTable row counts:")
                    
                    total_rows = 0
                    for (table_name,) in tables:
                        cursor = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
                        count = cursor.fetchone()[0]
                        total_rows += count
                        output.append(f"  {table_name}: {count} rows")
                    
                    output.append(f"\nTotal rows across all tables: {total_rows}")
                
                return "\n".join(output)
                
        except Exception as e:
            await tool_ctx.error(f"Failed to get stats: {str(e)}")
            return f"Error getting stats: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass