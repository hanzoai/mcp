"""Project-aware vector database management for Hanzo MCP."""

import os
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Any
from dataclasses import dataclass
import asyncio
from concurrent.futures import ThreadPoolExecutor

from .infinity_store import InfinityVectorStore, SearchResult


@dataclass
class ProjectInfo:
    """Information about a detected project."""
    root_path: Path
    llm_md_path: Path
    db_path: Path
    name: str


class ProjectVectorManager:
    """Manages project-aware vector databases."""
    
    def __init__(
        self,
        global_db_path: Optional[str] = None,
        embedding_model: str = "text-embedding-3-small",
        dimension: int = 1536,
    ):
        """Initialize the project vector manager.
        
        Args:
            global_db_path: Path for global vector store (default: ~/.config/hanzo/db)
            embedding_model: Embedding model to use
            dimension: Vector dimension
        """
        self.embedding_model = embedding_model
        self.dimension = dimension
        
        # Set up global database path
        if global_db_path:
            self.global_db_path = Path(global_db_path)
        else:
            from hanzo_mcp.config.settings import get_config_dir
            self.global_db_path = get_config_dir() / "db"
        
        self.global_db_path.mkdir(parents=True, exist_ok=True)
        
        # Cache for project info and vector stores
        self.projects: Dict[str, ProjectInfo] = {}
        self.vector_stores: Dict[str, InfinityVectorStore] = {}
        self._global_store: Optional[InfinityVectorStore] = None
        
        # Thread pool for parallel operations
        self.executor = ThreadPoolExecutor(max_workers=4)
    
    def _get_global_store(self) -> InfinityVectorStore:
        """Get or create the global vector store."""
        if self._global_store is None:
            self._global_store = InfinityVectorStore(
                data_path=str(self.global_db_path),
                embedding_model=self.embedding_model,
                dimension=self.dimension,
            )
        return self._global_store
    
    def detect_projects(self, search_paths: List[str]) -> List[ProjectInfo]:
        """Detect projects by finding LLM.md files.
        
        Args:
            search_paths: List of paths to search for projects
            
        Returns:
            List of detected project information
        """
        projects = []
        
        for search_path in search_paths:
            path = Path(search_path).resolve()
            
            # Search for LLM.md files
            for llm_md_path in path.rglob("LLM.md"):
                project_root = llm_md_path.parent
                project_name = project_root.name
                
                # Create .hanzo/db directory in project
                db_path = project_root / ".hanzo" / "db"
                db_path.mkdir(parents=True, exist_ok=True)
                
                project_info = ProjectInfo(
                    root_path=project_root,
                    llm_md_path=llm_md_path,
                    db_path=db_path,
                    name=project_name,
                )
                
                projects.append(project_info)
                
                # Cache project info
                project_key = str(project_root)
                self.projects[project_key] = project_info
        
        return projects
    
    def get_project_for_path(self, file_path: str) -> Optional[ProjectInfo]:
        """Find the project that contains a given file path.
        
        Args:
            file_path: File path to check
            
        Returns:
            Project info if found, None otherwise
        """
        path = Path(file_path).resolve()
        
        # Check each known project
        for project_key, project_info in self.projects.items():
            try:
                # Check if path is within project root
                path.relative_to(project_info.root_path)
                return project_info
            except ValueError:
                # Path is not within this project
                continue
        
        # Try to find project by walking up the directory tree
        current_path = path.parent if path.is_file() else path
        
        while current_path != current_path.parent:  # Stop at filesystem root
            llm_md_path = current_path / "LLM.md"
            if llm_md_path.exists():
                # Found a project, create and cache it
                db_path = current_path / ".hanzo" / "db"
                db_path.mkdir(parents=True, exist_ok=True)
                
                project_info = ProjectInfo(
                    root_path=current_path,
                    llm_md_path=llm_md_path,
                    db_path=db_path,
                    name=current_path.name,
                )
                
                project_key = str(current_path)
                self.projects[project_key] = project_info
                return project_info
            
            current_path = current_path.parent
        
        return None
    
    def get_vector_store(self, project_info: Optional[ProjectInfo] = None) -> InfinityVectorStore:
        """Get vector store for a project or global store.
        
        Args:
            project_info: Project to get store for, None for global store
            
        Returns:
            Vector store instance
        """
        if project_info is None:
            return self._get_global_store()
        
        project_key = str(project_info.root_path)
        
        if project_key not in self.vector_stores:
            self.vector_stores[project_key] = InfinityVectorStore(
                data_path=str(project_info.db_path),
                embedding_model=self.embedding_model,
                dimension=self.dimension,
            )
        
        return self.vector_stores[project_key]
    
    def add_file_to_appropriate_store(
        self,
        file_path: str,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        metadata: Dict[str, Any] = None,
    ) -> Tuple[List[str], Optional[ProjectInfo]]:
        """Add a file to the appropriate vector store (project or global).
        
        Args:
            file_path: Path to file to add
            chunk_size: Chunk size for text splitting
            chunk_overlap: Overlap between chunks
            metadata: Additional metadata
            
        Returns:
            Tuple of (document IDs, project info or None for global)
        """
        # Find project for this file
        project_info = self.get_project_for_path(file_path)
        
        # Get appropriate vector store
        vector_store = self.get_vector_store(project_info)
        
        # Add file metadata
        file_metadata = metadata or {}
        if project_info:
            file_metadata["project_name"] = project_info.name
            file_metadata["project_root"] = str(project_info.root_path)
        else:
            file_metadata["project_name"] = "global"
        
        # Add file to store
        doc_ids = vector_store.add_file(
            file_path=file_path,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            metadata=file_metadata,
        )
        
        return doc_ids, project_info
    
    async def search_all_projects(
        self,
        query: str,
        limit_per_project: int = 5,
        score_threshold: float = 0.0,
        include_global: bool = True,
        project_filter: Optional[List[str]] = None,
    ) -> Dict[str, List[SearchResult]]:
        """Search across all projects in parallel.
        
        Args:
            query: Search query
            limit_per_project: Maximum results per project
            score_threshold: Minimum similarity score
            include_global: Whether to include global store
            project_filter: List of project names to search (None for all)
            
        Returns:
            Dictionary mapping project names to search results
        """
        search_tasks = []
        project_names = []
        
        # Add global store if requested
        if include_global:
            global_store = self._get_global_store()
            search_tasks.append(
                asyncio.get_event_loop().run_in_executor(
                    self.executor,
                    lambda: global_store.search(query, limit_per_project, score_threshold)
                )
            )
            project_names.append("global")
        
        # Add project stores
        for project_key, project_info in self.projects.items():
            # Apply project filter
            if project_filter and project_info.name not in project_filter:
                continue
            
            vector_store = self.get_vector_store(project_info)
            search_tasks.append(
                asyncio.get_event_loop().run_in_executor(
                    self.executor,
                    lambda vs=vector_store: vs.search(query, limit_per_project, score_threshold)
                )
            )
            project_names.append(project_info.name)
        
        # Execute all searches in parallel
        results = await asyncio.gather(*search_tasks, return_exceptions=True)
        
        # Combine results
        combined_results = {}
        for i, result in enumerate(results):
            project_name = project_names[i]
            if isinstance(result, Exception):
                # Log error but continue
                print(f"Error searching project {project_name}: {result}")
                combined_results[project_name] = []
            else:
                combined_results[project_name] = result
        
        return combined_results
    
    def search_project_by_path(
        self,
        file_path: str,
        query: str,
        limit: int = 10,
        score_threshold: float = 0.0,
    ) -> List[SearchResult]:
        """Search the project containing a specific file path.
        
        Args:
            file_path: File path to determine project
            query: Search query
            limit: Maximum results
            score_threshold: Minimum similarity score
            
        Returns:
            Search results from the appropriate project store
        """
        project_info = self.get_project_for_path(file_path)
        vector_store = self.get_vector_store(project_info)
        
        return vector_store.search(
            query=query,
            limit=limit,
            score_threshold=score_threshold,
        )
    
    def get_project_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get statistics for all projects.
        
        Returns:
            Dictionary mapping project names to stats
        """
        stats = {}
        
        # Global store stats
        try:
            global_store = self._get_global_store()
            global_files = global_store.list_files()
            stats["global"] = {
                "file_count": len(global_files),
                "db_path": str(self.global_db_path),
            }
        except Exception as e:
            stats["global"] = {"error": str(e)}
        
        # Project store stats
        for project_key, project_info in self.projects.items():
            try:
                vector_store = self.get_vector_store(project_info)
                project_files = vector_store.list_files()
                stats[project_info.name] = {
                    "file_count": len(project_files),
                    "db_path": str(project_info.db_path),
                    "root_path": str(project_info.root_path),
                    "llm_md_exists": project_info.llm_md_path.exists(),
                }
            except Exception as e:
                stats[project_info.name] = {"error": str(e)}
        
        return stats
    
    def cleanup(self):
        """Close all vector stores and cleanup resources."""
        # Close all project stores
        for vector_store in self.vector_stores.values():
            try:
                vector_store.close()
            except:
                pass
        
        # Close global store
        if self._global_store:
            try:
                self._global_store.close()
            except:
                pass
        
        # Shutdown executor
        self.executor.shutdown(wait=False)