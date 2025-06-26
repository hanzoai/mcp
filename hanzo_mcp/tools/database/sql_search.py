"""SQL search tool for text search in database."""

import sqlite3
from typing import Annotated, Optional, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.database.database_manager import DatabaseManager


SearchPattern = Annotated[
    str,
    Field(
        description="Search pattern (SQL LIKE syntax, % for wildcard)",
        min_length=1,
    ),
]

Table = Annotated[
    str,
    Field(
        description="Table to search in (files, symbols, metadata)",
        default="files",
    ),
]

Column = Annotated[
    Optional[str],
    Field(
        description="Specific column to search (searches all text columns if not specified)",
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


class SqlSearchParams(TypedDict, total=False):
    """Parameters for SQL search tool."""

    pattern: str
    table: str
    column: Optional[str]
    project_path: Optional[str]
    max_results: int


@final
class SqlSearchTool(BaseTool):
    """Tool for searching text in SQLite database."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the SQL search tool.

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
        return "sql_search"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Search for text patterns in the project's SQLite database.

Supports SQL LIKE pattern matching:
- % matches any sequence of characters
- _ matches any single character
- Use %pattern% to search for pattern anywhere

Tables available:
- files: Search in file paths and content
- symbols: Search in symbol names, types, and signatures
- metadata: Search in key-value metadata

Examples:
- sql_search --pattern "%TODO%" --table files
- sql_search --pattern "test_%" --table symbols --column name
- sql_search --pattern "%config%" --table metadata
- sql_search --pattern "%.py" --table files --column path

Use sql_query for complex queries with joins, conditions, etc."""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[SqlSearchParams],
    ) -> str:
        """Execute SQL search.

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

        table = params.get("table", "files")
        column = params.get("column")
        project_path = params.get("project_path")
        max_results = params.get("max_results", 50)

        # Validate table
        valid_tables = ["files", "symbols", "metadata"]
        if table not in valid_tables:
            return f"Error: Invalid table '{table}'. Must be one of: {', '.join(valid_tables)}"

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

        await tool_ctx.info(f"Searching in {table} table for pattern: {pattern}")

        # Build search query
        conn = None
        try:
            conn = project_db.get_sqlite_connection()
            cursor = conn.cursor()
            
            # Get searchable columns for the table
            if column:
                # Validate column exists
                cursor.execute(f"PRAGMA table_info({table})")
                columns_info = cursor.fetchall()
                column_names = [col[1] for col in columns_info]
                
                if column not in column_names:
                    return f"Error: Column '{column}' not found in table '{table}'. Available columns: {', '.join(column_names)}"
                
                search_columns = [column]
            else:
                # Get all text columns
                search_columns = self._get_text_columns(cursor, table)
                if not search_columns:
                    return f"Error: No searchable text columns in table '{table}'"

            # Build WHERE clause
            where_conditions = [f"{col} LIKE ?" for col in search_columns]
            where_clause = " OR ".join(where_conditions)
            
            # Build query
            if table == "files":
                query = f"""
                    SELECT path, SUBSTR(content, 1, 200) as snippet, size, modified_at
                    FROM {table}
                    WHERE {where_clause}
                    LIMIT ?
                """
                params_list = [pattern] * len(search_columns) + [max_results]
                
            elif table == "symbols":
                query = f"""
                    SELECT name, type, file_path, line_start, signature
                    FROM {table}
                    WHERE {where_clause}
                    ORDER BY type, name
                    LIMIT ?
                """
                params_list = [pattern] * len(search_columns) + [max_results]
                
            else:  # metadata
                query = f"""
                    SELECT key, value, updated_at
                    FROM {table}
                    WHERE {where_clause}
                    LIMIT ?
                """
                params_list = [pattern] * len(search_columns) + [max_results]
            
            # Execute search
            cursor.execute(query, params_list)
            results = cursor.fetchall()
            
            if not results:
                return f"No results found for pattern '{pattern}' in {table}"
            
            # Format results
            output = self._format_results(table, results, pattern, search_columns)
            
            return f"Found {len(results)} result(s) in {table}:\n\n{output}"

        except sqlite3.Error as e:
            await tool_ctx.error(f"SQL error: {str(e)}")
            return f"SQL error: {str(e)}"
        except Exception as e:
            await tool_ctx.error(f"Unexpected error: {str(e)}")
            return f"Error executing search: {str(e)}"
        finally:
            if conn:
                conn.close()

    def _get_text_columns(self, cursor: sqlite3.Cursor, table: str) -> list[str]:
        """Get text columns for a table."""
        cursor.execute(f"PRAGMA table_info({table})")
        columns_info = cursor.fetchall()
        
        # Get TEXT columns
        text_columns = []
        for col in columns_info:
            col_name = col[1]
            col_type = col[2].upper()
            if 'TEXT' in col_type or 'CHAR' in col_type or col_type == '':
                text_columns.append(col_name)
        
        return text_columns

    def _format_results(self, table: str, results: list, pattern: str, search_columns: list[str]) -> str:
        """Format search results based on table type."""
        output = []
        
        if table == "files":
            output.append(f"Searched columns: {', '.join(search_columns)}\n")
            for row in results:
                path, snippet, size, modified = row
                output.append(f"File: {path}")
                output.append(f"Size: {size} bytes")
                output.append(f"Modified: {modified}")
                if snippet:
                    # Highlight pattern in snippet
                    snippet = snippet.replace('\n', ' ')
                    if len(snippet) > 150:
                        snippet = snippet[:150] + "..."
                    output.append(f"Content: {snippet}")
                output.append("-" * 60)
                
        elif table == "symbols":
            output.append(f"Searched columns: {', '.join(search_columns)}\n")
            for row in results:
                name, type_, file_path, line_start, signature = row
                output.append(f"{type_}: {name}")
                output.append(f"File: {file_path}:{line_start}")
                if signature:
                    output.append(f"Signature: {signature}")
                output.append("-" * 60)
                
        else:  # metadata
            output.append(f"Searched columns: {', '.join(search_columns)}\n")
            for row in results:
                key, value, updated = row
                output.append(f"Key: {key}")
                output.append(f"Value: {value}")
                output.append(f"Updated: {updated}")
                output.append("-" * 60)
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass