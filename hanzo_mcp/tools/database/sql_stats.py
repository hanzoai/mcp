"""SQL statistics tool for database insights."""

import sqlite3
from typing import Annotated, Optional, TypedDict, Unpack, final, override

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


class SqlStatsParams(TypedDict, total=False):
    """Parameters for SQL stats tool."""

    project_path: Optional[str]
    detailed: bool


@final
class SqlStatsTool(BaseTool):
    """Tool for getting SQLite database statistics."""

    def __init__(self, permission_manager: PermissionManager, db_manager: DatabaseManager):
        """Initialize the SQL stats tool.

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
        return "sql_stats"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Get statistics about the project's SQLite database.

Shows:
- Database size and location
- Table information (row counts, sizes)
- Index information
- Column statistics
- Most common values (with --detailed)

Examples:
- sql_stats                    # Basic stats for current project
- sql_stats --detailed         # Detailed statistics
- sql_stats --project-path /path/to/project
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[SqlStatsParams],
    ) -> str:
        """Get database statistics.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Database statistics
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        project_path = params.get("project_path")
        detailed = params.get("detailed", False)

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

        await tool_ctx.info(f"Getting statistics for project: {project_db.project_path}")

        # Collect statistics
        conn = None
        try:
            conn = project_db.get_sqlite_connection()
            cursor = conn.cursor()
            
            output = []
            output.append(f"=== SQLite Database Statistics ===")
            output.append(f"Project: {project_db.project_path}")
            output.append(f"Database: {project_db.sqlite_path}")
            
            # Get database size
            db_size = project_db.sqlite_path.stat().st_size
            output.append(f"Database Size: {self._format_size(db_size)}")
            output.append("")
            
            # Get table statistics
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            tables = cursor.fetchall()
            
            output.append("=== Tables ===")
            total_rows = 0
            
            for (table_name,) in tables:
                if table_name.startswith('sqlite_'):
                    continue
                    
                # Get row count
                cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
                row_count = cursor.fetchone()[0]
                total_rows += row_count
                
                # Get table info
                cursor.execute(f"PRAGMA table_info({table_name})")
                columns = cursor.fetchall()
                col_count = len(columns)
                
                output.append(f"\n{table_name}:")
                output.append(f"  Rows: {row_count:,}")
                output.append(f"  Columns: {col_count}")
                
                if detailed and row_count > 0:
                    # Show column details
                    output.append("  Columns:")
                    for col in columns:
                        col_name = col[1]
                        col_type = col[2]
                        is_pk = col[5]
                        not_null = col[3]
                        
                        flags = []
                        if is_pk:
                            flags.append("PRIMARY KEY")
                        if not_null:
                            flags.append("NOT NULL")
                        
                        flag_str = f" ({', '.join(flags)})" if flags else ""
                        output.append(f"    - {col_name}: {col_type}{flag_str}")
                    
                    # Show sample data for specific tables
                    if table_name == "files" and row_count > 0:
                        cursor.execute(f"SELECT COUNT(DISTINCT SUBSTR(path, -3)) as ext_count FROM {table_name}")
                        ext_count = cursor.fetchone()[0]
                        output.append(f"  File types: ~{ext_count}")
                        
                    elif table_name == "symbols" and row_count > 0:
                        cursor.execute(f"SELECT type, COUNT(*) as count FROM {table_name} GROUP BY type ORDER BY count DESC LIMIT 5")
                        symbol_types = cursor.fetchall()
                        output.append("  Symbol types:")
                        for sym_type, count in symbol_types:
                            output.append(f"    - {sym_type}: {count}")
                
                # Get indexes
                cursor.execute(f"PRAGMA index_list({table_name})")
                indexes = cursor.fetchall()
                if indexes:
                    output.append(f"  Indexes: {len(indexes)}")
            
            output.append(f"\nTotal Rows: {total_rows:,}")
            
            # Get index statistics
            cursor.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
            indexes = cursor.fetchall()
            if indexes:
                output.append(f"\n=== Indexes ===")
                output.append(f"Total Indexes: {len(indexes)}")
                
                if detailed:
                    for (idx_name,) in indexes:
                        cursor.execute(f"PRAGMA index_info({idx_name})")
                        idx_info = cursor.fetchall()
                        if idx_info:
                            cols = [info[2] for info in idx_info]
                            output.append(f"  {idx_name}: ({', '.join(cols)})")
            
            # Database properties
            if detailed:
                output.append("\n=== Database Properties ===")
                
                # Page size
                cursor.execute("PRAGMA page_size")
                page_size = cursor.fetchone()[0]
                output.append(f"Page Size: {page_size:,} bytes")
                
                # Page count
                cursor.execute("PRAGMA page_count")
                page_count = cursor.fetchone()[0]
                output.append(f"Page Count: {page_count:,}")
                
                # Cache size
                cursor.execute("PRAGMA cache_size")
                cache_size = cursor.fetchone()[0]
                output.append(f"Cache Size: {abs(cache_size):,} pages")
            
            return "\n".join(output)

        except sqlite3.Error as e:
            await tool_ctx.error(f"SQL error: {str(e)}")
            return f"SQL error: {str(e)}"
        except Exception as e:
            await tool_ctx.error(f"Unexpected error: {str(e)}")
            return f"Error getting statistics: {str(e)}"
        finally:
            if conn:
                conn.close()

    def _format_size(self, size: int) -> str:
        """Format file size in human-readable format."""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024.0:
                return f"{size:.1f} {unit}"
            size /= 1024.0
        return f"{size:.1f} TB"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass