"""Document context for the MCP Claude Code server."""

import json
import os
import time
from pathlib import Path
from typing import Any, final


@final
class DocumentContext:
    """Manages document context and codebase understanding."""
    
    def __init__(self) -> None:
        """Initialize the document context."""
        self.documents: dict[str, str] = {}
        self.document_metadata: dict[str, dict[str, Any]] = {}
        self.modified_times: dict[str, float] = {}
        self.allowed_paths: set[Path] = set()
        
    def add_allowed_path(self, path: str) -> None:
        """Add a path to the allowed paths.
        
        Args:
            path: The path to allow
        """
        resolved_path: Path = Path(path).resolve()
        self.allowed_paths.add(resolved_path)
    
    def is_path_allowed(self, path: str) -> bool:
        """Check if a path is allowed.
        
        Args:
            path: The path to check
            
        Returns:
            True if the path is allowed, False otherwise
        """
        resolved_path: Path = Path(path).resolve()
        
        # Check if the path is within any allowed path
        for allowed_path in self.allowed_paths:
            try:
                resolved_path.relative_to(allowed_path)
                return True
            except ValueError:
                continue
        
        return False
    
    def add_document(self, path: str, content: str, metadata: dict[str, Any] | None = None) -> None:
        """Add a document to the context.
        
        Args:
            path: The path of the document
            content: The content of the document
            metadata: Optional metadata about the document
        """
        self.documents[path] = content
        self.modified_times[path] = time.time()
        
        if metadata:
            self.document_metadata[path] = metadata
        else:
            # Try to infer metadata
            self.document_metadata[path] = self._infer_metadata(path, content)
    
    def get_document(self, path: str) -> str | None:
        """Get a document from the context.
        
        Args:
            path: The path of the document
            
        Returns:
            The document content, or None if not found
        """
        return self.documents.get(path)
    
    def get_document_metadata(self, path: str) -> dict[str, Any] | None:
        """Get document metadata.
        
        Args:
            path: The path of the document
            
        Returns:
            The document metadata, or None if not found
        """
        return self.document_metadata.get(path)
    
    def update_document(self, path: str, content: str) -> None:
        """Update a document in the context.
        
        Args:
            path: The path of the document
            content: The new content of the document
        """
        self.documents[path] = content
        self.modified_times[path] = time.time()
        
        # Update metadata
        self.document_metadata[path] = self._infer_metadata(path, content)
    
    def remove_document(self, path: str) -> None:
        """Remove a document from the context.
        
        Args:
            path: The path of the document
        """
        if path in self.documents:
            del self.documents[path]
        
        if path in self.document_metadata:
            del self.document_metadata[path]
        
        if path in self.modified_times:
            del self.modified_times[path]
    
    def _infer_metadata(self, path: str, content: str) -> dict[str, Any]:
        """Infer metadata about a document.
        
        Args:
            path: The path of the document
            content: The content of the document
            
        Returns:
            Inferred metadata
        """
        extension: str = Path(path).suffix.lower()
        
        metadata: dict[str, Any] = {
            "extension": extension,
            "size": len(content),
            "line_count": content.count("\n") + 1,
        }
        
        # Infer language based on extension
        language_map: dict[str, list[str]] = {
            "python": [".py"],
            "javascript": [".js", ".jsx"],
            "typescript": [".ts", ".tsx"],
            "java": [".java"],
            "c++": [".c", ".cpp", ".h", ".hpp"],
            "go": [".go"],
            "rust": [".rs"],
            "ruby": [".rb"],
            "php": [".php"],
            "html": [".html", ".htm"],
            "css": [".css"],
            "markdown": [".md"],
            "json": [".json"],
            "yaml": [".yaml", ".yml"],
            "xml": [".xml"],
            "sql": [".sql"],
            "shell": [".sh", ".bash"],
        }
        
        # Find matching language
        for language, extensions in language_map.items():
            if extension in extensions:
                metadata["language"] = language
                break
        else:
            metadata["language"] = "text"
        
        return metadata
    
    def load_directory(self, directory: str, recursive: bool = True, exclude_patterns: list[str] | None = None) -> None:
        """Load all files in a directory into the context.
        
        Args:
            directory: The directory to load
            recursive: Whether to load subdirectories
            exclude_patterns: Patterns to exclude
        """
        if not self.is_path_allowed(directory):
            raise ValueError(f"Directory not allowed: {directory}")
        
        dir_path: Path = Path(directory)
        
        if not dir_path.exists() or not dir_path.is_dir():
            raise ValueError(f"Not a valid directory: {directory}")
        
        if exclude_patterns is None:
            exclude_patterns = []
        
        # Common directories and files to exclude
        default_excludes: list[str] = [
            "__pycache__", 
            ".git", 
            "node_modules", 
            "venv", 
            ".venv",
            ".env",
            "*.pyc", 
            "*.pyo", 
            "*.pyd", 
            "*.so", 
            "*.dll", 
            "*.exe"
        ]
        
        exclude_patterns.extend(default_excludes)
        
        def should_exclude(path: Path) -> bool:
            """Check if a path should be excluded.
            
            Args:
                path: The path to check
                
            Returns:
                True if the path should be excluded, False otherwise
            """
            for pattern in exclude_patterns:
                if pattern.startswith("*"):
                    if path.name.endswith(pattern[1:]):
                        return True
                elif pattern in str(path):
                    return True
            return False
        
        # Walk the directory
        for root, dirs, files in os.walk(dir_path):
            # Skip excluded directories
            dirs[:] = [d for d in dirs if not should_exclude(Path(root) / d)]
            
            # Process files
            for file in files:
                file_path: Path = Path(root) / file
                
                if should_exclude(file_path):
                    continue
                
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content: str = f.read()
                    
                    # Add to context
                    self.add_document(str(file_path), content)
                except UnicodeDecodeError:
                    # Skip binary files
                    continue
            
            # Stop if not recursive
            if not recursive:
                break
    
    def to_json(self) -> str:
        """Convert the context to a JSON string.
        
        Returns:
            A JSON string representation of the context
        """
        data: dict[str, Any] = {
            "documents": self.documents,
            "metadata": self.document_metadata,
            "modified_times": self.modified_times,
            "allowed_paths": [str(p) for p in self.allowed_paths],
        }
        
        return json.dumps(data)
    
    @classmethod
    def from_json(cls, json_str: str) -> 'DocumentContext':
        """Create a context from a JSON string.
        
        Args:
            json_str: The JSON string
            
        Returns:
            A new DocumentContext instance
        """
        data: dict[str, Any] = json.loads(json_str)
        
        context = cls()
        context.documents = data.get("documents", {})
        context.document_metadata = data.get("metadata", {})
        context.modified_times = data.get("modified_times", {})
        context.allowed_paths = set(Path(p) for p in data.get("allowed_paths", []))
        
        return context
