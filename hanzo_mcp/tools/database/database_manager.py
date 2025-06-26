"""Database manager for project-specific SQLite and graph databases."""

import sqlite3
import os
import json
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, List
from datetime import datetime

from hanzo_mcp.tools.common.permissions import PermissionManager


class ProjectDatabase:
    """Manages SQLite and graph databases for a project."""
    
    def __init__(self, project_path: str):
        self.project_path = Path(project_path)
        self.db_dir = self.project_path / ".hanzo" / "db"
        self.db_dir.mkdir(parents=True, exist_ok=True)
        
        # SQLite database path
        self.sqlite_path = self.db_dir / "project.db"
        self.graph_path = self.db_dir / "graph.db"
        
        # Initialize databases
        self._init_sqlite()
        self._init_graph()
        
        # Keep graph in memory for performance
        self.graph_conn = sqlite3.connect(":memory:")
        self._init_graph_schema(self.graph_conn)
        self._load_graph_from_disk()
    
    def _init_sqlite(self):
        """Initialize SQLite database with common tables."""
        conn = sqlite3.connect(self.sqlite_path)
        try:
            # Create metadata table
            conn.execute('''
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            # Create files table
            conn.execute('''
                CREATE TABLE IF NOT EXISTS files (
                    path TEXT PRIMARY KEY,
                    content TEXT,
                    size INTEGER,
                    modified_at TIMESTAMP,
                    hash TEXT,
                    metadata TEXT
                )
            ''')
            
            # Create symbols table
            conn.execute('''
                CREATE TABLE IF NOT EXISTS symbols (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT,
                    name TEXT,
                    type TEXT,
                    line_start INTEGER,
                    line_end INTEGER,
                    scope TEXT,
                    signature TEXT,
                    FOREIGN KEY (file_path) REFERENCES files(path)
                )
            ''')
            
            # Create index for fast searches
            conn.execute('CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type)')
            
            conn.commit()
        finally:
            conn.close()
    
    def _init_graph(self):
        """Initialize graph database on disk."""
        conn = sqlite3.connect(self.graph_path)
        try:
            self._init_graph_schema(conn)
            conn.commit()
        finally:
            conn.close()
    
    def _init_graph_schema(self, conn: sqlite3.Connection):
        """Initialize graph database schema."""
        # Nodes table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                properties TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Edges table
        conn.execute('''
            CREATE TABLE IF NOT EXISTS edges (
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                relationship TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                properties TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (source, target, relationship),
                FOREIGN KEY (source) REFERENCES nodes(id),
                FOREIGN KEY (target) REFERENCES nodes(id)
            )
        ''')
        
        # Indexes for graph traversal
        conn.execute('CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_edges_relationship ON edges(relationship)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)')
    
    def _load_graph_from_disk(self):
        """Load graph from disk into memory."""
        disk_conn = sqlite3.connect(self.graph_path)
        try:
            # Copy nodes
            nodes = disk_conn.execute('SELECT * FROM nodes').fetchall()
            self.graph_conn.executemany(
                'INSERT OR REPLACE INTO nodes VALUES (?, ?, ?, ?)', 
                nodes
            )
            
            # Copy edges
            edges = disk_conn.execute('SELECT * FROM edges').fetchall()
            self.graph_conn.executemany(
                'INSERT OR REPLACE INTO edges VALUES (?, ?, ?, ?, ?, ?)', 
                edges
            )
            
            self.graph_conn.commit()
        finally:
            disk_conn.close()
    
    def _save_graph_to_disk(self):
        """Save in-memory graph to disk."""
        disk_conn = sqlite3.connect(self.graph_path)
        try:
            # Clear existing data
            disk_conn.execute('DELETE FROM edges')
            disk_conn.execute('DELETE FROM nodes')
            
            # Copy nodes
            nodes = self.graph_conn.execute('SELECT * FROM nodes').fetchall()
            disk_conn.executemany(
                'INSERT INTO nodes VALUES (?, ?, ?, ?)', 
                nodes
            )
            
            # Copy edges
            edges = self.graph_conn.execute('SELECT * FROM edges').fetchall()
            disk_conn.executemany(
                'INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)', 
                edges
            )
            
            disk_conn.commit()
        finally:
            disk_conn.close()
    
    def get_sqlite_connection(self) -> sqlite3.Connection:
        """Get SQLite connection."""
        conn = sqlite3.connect(self.sqlite_path)
        conn.row_factory = sqlite3.Row
        return conn
    
    def get_graph_connection(self) -> sqlite3.Connection:
        """Get in-memory graph connection."""
        return self.graph_conn
    
    def close(self):
        """Close connections and save graph to disk."""
        self._save_graph_to_disk()
        self.graph_conn.close()


class DatabaseManager:
    """Manages databases for multiple projects."""
    
    def __init__(self, permission_manager: PermissionManager):
        self.permission_manager = permission_manager
        self.projects: Dict[str, ProjectDatabase] = {}
        self.search_paths: List[str] = []
    
    def add_search_path(self, path: str):
        """Add a path to search for projects."""
        if path not in self.search_paths:
            self.search_paths.append(path)
    
    def get_project_db(self, project_path: str) -> ProjectDatabase:
        """Get or create database for a project."""
        project_path = os.path.abspath(project_path)
        
        # Check permissions
        if not self.permission_manager.has_permission(project_path):
            raise PermissionError(f"No permission to access: {project_path}")
        
        # Create database if not exists
        if project_path not in self.projects:
            self.projects[project_path] = ProjectDatabase(project_path)
        
        return self.projects[project_path]
    
    def get_project_for_path(self, file_path: str) -> Optional[ProjectDatabase]:
        """Find the project database for a given file path."""
        file_path = os.path.abspath(file_path)
        
        # Check if file is in a known project
        for project_path in self.projects:
            if file_path.startswith(project_path):
                return self.projects[project_path]
        
        # Search up the directory tree for a project
        current = Path(file_path)
        if current.is_file():
            current = current.parent
            
        while current != current.parent:
            # Check for project markers
            if (current / ".git").exists() or (current / "LLM.md").exists():
                return self.get_project_db(str(current))
            current = current.parent
        
        # No project found, use the directory of the file
        if Path(file_path).is_file():
            return self.get_project_db(str(Path(file_path).parent))
        else:
            return self.get_project_db(file_path)
    
    def close_all(self):
        """Close all project databases."""
        for db in self.projects.values():
            db.close()
        self.projects.clear()