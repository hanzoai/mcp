"""Infinity vector database integration for Hanzo MCP."""

import json
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass

try:
    import infinity_embedded
    INFINITY_AVAILABLE = True
except ImportError:
    INFINITY_AVAILABLE = False


@dataclass
class Document:
    """Document representation for vector storage."""
    id: str
    content: str
    metadata: Dict[str, Any]
    file_path: Optional[str] = None
    chunk_index: Optional[int] = None


@dataclass
class SearchResult:
    """Search result from vector database."""
    document: Document
    score: float
    distance: float


class InfinityVectorStore:
    """Local vector database using Infinity."""
    
    def __init__(
        self,
        data_path: Optional[str] = None,
        embedding_model: str = "text-embedding-3-small",
        dimension: int = 1536,  # Default for OpenAI text-embedding-3-small
    ):
        """Initialize the Infinity vector store.
        
        Args:
            data_path: Path to store vector database (default: ~/.config/hanzo/vector-store)
            embedding_model: Embedding model to use
            dimension: Vector dimension (must match embedding model)
        """
        if not INFINITY_AVAILABLE:
            raise ImportError("infinity_embedded is required for vector store functionality")
        
        # Set up data path
        if data_path:
            self.data_path = Path(data_path)
        else:
            from hanzo_mcp.config.settings import get_config_dir
            self.data_path = get_config_dir() / "vector-store"
        
        self.data_path.mkdir(parents=True, exist_ok=True)
        
        self.embedding_model = embedding_model
        self.dimension = dimension
        
        # Connect to Infinity
        self.infinity = infinity_embedded.connect(str(self.data_path))
        self.db = self.infinity.get_database("hanzo_mcp")
        
        # Initialize tables
        self._initialize_tables()
    
    def _initialize_tables(self):
        """Initialize database tables if they don't exist."""
        # Documents table
        try:
            self.documents_table = self.db.get_table("documents")
        except:
            self.documents_table = self.db.create_table(
                "documents",
                {
                    "id": {"type": "varchar"},
                    "content": {"type": "varchar"},
                    "file_path": {"type": "varchar"},
                    "chunk_index": {"type": "integer"},
                    "metadata": {"type": "varchar"},  # JSON string
                    "embedding": {"type": f"vector,{self.dimension},float"},
                }
            )
    
    def _generate_doc_id(self, content: str, file_path: str = "", chunk_index: int = 0) -> str:
        """Generate a unique document ID."""
        content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
        path_hash = hashlib.sha256(file_path.encode()).hexdigest()[:8]
        return f"doc_{path_hash}_{chunk_index}_{content_hash}"
    
    def add_document(
        self,
        content: str,
        metadata: Dict[str, Any] = None,
        file_path: Optional[str] = None,
        chunk_index: int = 0,
        embedding: Optional[List[float]] = None,
    ) -> str:
        """Add a document to the vector store.
        
        Args:
            content: Document content
            metadata: Additional metadata
            file_path: Source file path
            chunk_index: Chunk index if document is part of larger file
            embedding: Pre-computed embedding (if None, will compute)
            
        Returns:
            Document ID
        """
        doc_id = self._generate_doc_id(content, file_path or "", chunk_index)
        
        # Generate embedding if not provided
        if embedding is None:
            embedding = self._generate_embedding(content)
        
        # Prepare metadata
        metadata = metadata or {}
        metadata_json = json.dumps(metadata)
        
        # Insert document
        self.documents_table.insert([{
            "id": doc_id,
            "content": content,
            "file_path": file_path or "",
            "chunk_index": chunk_index,
            "metadata": metadata_json,
            "embedding": embedding,
        }])
        
        return doc_id
    
    def add_file(
        self,
        file_path: str,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        metadata: Dict[str, Any] = None,
    ) -> List[str]:
        """Add a file to the vector store by chunking it.
        
        Args:
            file_path: Path to the file to add
            chunk_size: Maximum characters per chunk
            chunk_overlap: Characters to overlap between chunks
            metadata: Additional metadata for all chunks
            
        Returns:
            List of document IDs for all chunks
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        
        # Read file content
        try:
            content = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            # Try with different encoding
            content = path.read_text(encoding='latin-1')
        
        # Chunk the content
        chunks = self._chunk_text(content, chunk_size, chunk_overlap)
        
        # Add metadata
        file_metadata = metadata or {}
        file_metadata.update({
            "file_name": path.name,
            "file_extension": path.suffix,
            "file_size": path.stat().st_size,
        })
        
        # Add each chunk
        doc_ids = []
        for i, chunk in enumerate(chunks):
            chunk_metadata = file_metadata.copy()
            chunk_metadata["chunk_number"] = i
            chunk_metadata["total_chunks"] = len(chunks)
            
            doc_id = self.add_document(
                content=chunk,
                metadata=chunk_metadata,
                file_path=str(path),
                chunk_index=i,
            )
            doc_ids.append(doc_id)
        
        return doc_ids
    
    def search(
        self,
        query: str,
        limit: int = 10,
        score_threshold: float = 0.0,
        filters: Dict[str, Any] = None,
    ) -> List[SearchResult]:
        """Search for similar documents.
        
        Args:
            query: Search query
            limit: Maximum number of results
            score_threshold: Minimum similarity score
            filters: Metadata filters (not yet implemented)
            
        Returns:
            List of search results
        """
        # Generate query embedding
        query_embedding = self._generate_embedding(query)
        
        # Perform vector search
        search_results = self.documents_table.output(["*"]).match_dense(
            "embedding", 
            query_embedding, 
            "float", 
            "ip",  # Inner product (cosine similarity)
            limit
        ).to_pl()
        
        # Convert to SearchResult objects
        results = []
        for row in search_results.iter_rows(named=True):
            # Parse metadata
            try:
                metadata = json.loads(row["metadata"])
            except:
                metadata = {}
            
            # Create document
            document = Document(
                id=row["id"],
                content=row["content"],
                metadata=metadata,
                file_path=row["file_path"] if row["file_path"] else None,
                chunk_index=row["chunk_index"],
            )
            
            # Score is the similarity (higher is better)
            score = row.get("score", 0.0)
            distance = 1.0 - score  # Convert similarity to distance
            
            if score >= score_threshold:
                results.append(SearchResult(
                    document=document,
                    score=score,
                    distance=distance,
                ))
        
        return results
    
    def delete_document(self, doc_id: str) -> bool:
        """Delete a document by ID.
        
        Args:
            doc_id: Document ID to delete
            
        Returns:
            True if document was deleted
        """
        try:
            self.documents_table.delete(f"id = '{doc_id}'")
            return True
        except:
            return False
    
    def delete_file(self, file_path: str) -> int:
        """Delete all documents from a specific file.
        
        Args:
            file_path: File path to delete documents for
            
        Returns:
            Number of documents deleted
        """
        try:
            # Get count first
            results = self.documents_table.output(["id"]).filter(f"file_path = '{file_path}'").to_pl()
            count = len(results)
            
            # Delete all documents for this file
            self.documents_table.delete(f"file_path = '{file_path}'")
            return count
        except:
            return 0
    
    def list_files(self) -> List[Dict[str, Any]]:
        """List all indexed files.
        
        Returns:
            List of file information
        """
        try:
            results = self.documents_table.output(["file_path", "metadata"]).to_pl()
            
            files = {}
            for row in results.iter_rows(named=True):
                file_path = row["file_path"]
                if file_path and file_path not in files:
                    try:
                        metadata = json.loads(row["metadata"])
                        files[file_path] = {
                            "file_path": file_path,
                            "file_name": metadata.get("file_name", Path(file_path).name),
                            "file_size": metadata.get("file_size", 0),
                            "total_chunks": metadata.get("total_chunks", 1),
                        }
                    except:
                        files[file_path] = {
                            "file_path": file_path,
                            "file_name": Path(file_path).name,
                        }
            
            return list(files.values())
        except:
            return []
    
    def _chunk_text(self, text: str, chunk_size: int, overlap: int) -> List[str]:
        """Split text into overlapping chunks."""
        if len(text) <= chunk_size:
            return [text]
        
        chunks = []
        start = 0
        
        while start < len(text):
            end = start + chunk_size
            
            # Try to break at word boundary
            if end < len(text):
                # Look back for a good break point
                break_point = end
                for i in range(end - 100, start + 100, -1):
                    if i > 0 and text[i] in '\n\r.!?':
                        break_point = i + 1
                        break
                end = break_point
            
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            
            start = max(start + chunk_size - overlap, end)
        
        return chunks
    
    def _generate_embedding(self, text: str) -> List[float]:
        """Generate embedding for text.
        
        For now, this returns a dummy embedding. In a real implementation,
        you would call an embedding API (OpenAI, Cohere, etc.) or use a local model.
        """
        # This is a placeholder - you would implement actual embedding generation here
        # For now, return a random embedding of the correct dimension
        import random
        return [random.random() for _ in range(self.dimension)]
    
    def close(self):
        """Close the database connection."""
        if hasattr(self, 'infinity'):
            self.infinity.disconnect()