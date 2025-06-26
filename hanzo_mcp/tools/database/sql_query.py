"""SQL query tool for direct database queries."""

import sqlite3
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


Query = Annotated[
    str,
    Field(
        description="SQL query to execute",
        min_length=1,
    ),
]

ProjectPath = Annotated[
    Optional[str],
    Field(
        description="Project path (defaults to current directory)",
        default=None,
    ),
]

ReadOnly = Annotated[
    bool,
    Field(
        description="Execute in read-only mode (no INSERT/UPDATE/DELETE)",
        default=True,
    ),
]


class SqlQueryParams(TypedDict, total=False):
    """Parameters for SQL query tool."""

    query: str
    project_path: Optional[str]
    read_only: bool


@final
class SqlQueryTool(BaseTool):
    """Tool for executing SQL queries on project databases."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the SQL query tool.

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
        return "sql_query"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Execute SQL queries on the project's embedded SQLite database.

Each project has its own SQLite database with tables:
- metadata: Key-value store for project metadata
- files: File information and content
- symbols: Code symbols (functions, classes, etc.)

Features:
- Direct SQL query execution
- Read-only mode by default (safety)
- Returns results in tabular format
- Automatic project detection

Examples:
- sql_query --query "SELECT * FROM files LIMIT 10"
- sql_query --query "SELECT name, type FROM symbols WHERE type='function'"
- sql_query --query "INSERT INTO metadata (key, value) VALUES ('version', '1.0')" --read-only false

Note: Use sql_search for text search operations."""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[SqlQueryParams],
    ) -> str:
        """Execute SQL query.

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

        project_path = params.get("project_path")
        read_only = params.get("read_only", True)

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

        # Check if query is read-only
        if read_only:
            # Simple check for write operations
            write_keywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER']
            query_upper = query.upper()
            for keyword in write_keywords:
                if keyword in query_upper:
                    return f"Error: Query contains {keyword} operation. Set --read-only false to allow write operations."

        await tool_ctx.info(f"Executing SQL query on project: {project_db.project_path}")

        # Execute query
        conn = None
        try:
            conn = project_db.get_sqlite_connection()
            cursor = conn.cursor()
            
            # Execute the query
            cursor.execute(query)
            
            # Handle different query types
            if query.strip().upper().startswith('SELECT'):
                # Fetch results
                results = cursor.fetchall()
                
                if not results:
                    return "No results found."
                
                # Get column names
                columns = [desc[0] for desc in cursor.description]
                
                # Format as table
                output = self._format_results_table(columns, results)
                
                return f"Query executed successfully. Found {len(results)} row(s).\n\n{output}"
                
            else:
                # For non-SELECT queries, commit and return affected rows
                conn.commit()
                affected = cursor.rowcount
                return f"Query executed successfully. Affected {affected} row(s)."

        except sqlite3.Error as e:
            await tool_ctx.error(f"SQL error: {str(e)}")
            return f"SQL error: {str(e)}"
        except Exception as e:
            await tool_ctx.error(f"Unexpected error: {str(e)}")
            return f"Error executing query: {str(e)}"
        finally:
            if conn:
                conn.close()

    def _format_results_table(self, columns: list[str], rows: list[tuple]) -> str:
        """Format query results as a table."""
        if not rows:
            return "No results"
        
        # Calculate column widths
        col_widths = []
        for i, col in enumerate(columns):
            max_width = len(col)
            for row in rows[:100]:  # Check first 100 rows
                val_str = str(row[i]) if row[i] is not None else "NULL"
                max_width = max(max_width, len(val_str))
            col_widths.append(min(max_width, 50))  # Cap at 50 chars
        
        # Build header
        header = " | ".join(col.ljust(width) for col, width in zip(columns, col_widths))
        separator = "-+-".join("-" * width for width in col_widths)
        
        # Build rows
        output_rows = []
        for row in rows[:1000]:  # Limit to 1000 rows
            row_str = " | ".join(
                self._truncate(str(val) if val is not None else "NULL", width).ljust(width)
                for val, width in zip(row, col_widths)
            )
            output_rows.append(row_str)
        
        # Combine
        output = [header, separator] + output_rows
        
        if len(rows) > 1000:
            output.append(f"\n... and {len(rows) - 1000} more rows")
        
        return "\n".join(output)

    def _truncate(self, text: str, max_width: int) -> str:
        """Truncate text to max width."""
        if len(text) <= max_width:
            return text
        return text[:max_width-3] + "..."

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass