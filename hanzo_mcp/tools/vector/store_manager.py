"""Vector store manager for Hanzo MCP.

This module provides a wrapper around ChromaDB for efficient vector storage and retrieval.
It supports persistent storage of embeddings, full-text search functionality, and
integration with the MCP permission system.
"""

import os
import shutil
import json
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union, cast
import uuid
import asyncio
import logging
from functools import lru_cache

# Optional imports for document processing
# These are imported lazily to avoid unnecessary dependencies
def _import_pdf_parser():
    try:
        import PyPDF2
        return PyPDF2
    except ImportError:
        return None

def _import_docx_parser():
    try:
        import docx
        return docx
    except ImportError:
        return None

def _import_image_processor():
    try:
        from PIL import Image
        return Image
    except ImportError:
        return None

import chromadb
from chromadb.config import Settings
from chromadb.utils import embedding_functions
from hanzo_mcp.tools.common.context import ToolContext, create_tool_context
from mcp.server.fastmcp import FastMCP
from mcp.types import Tool

from hanzo_mcp.tools.common.context import DocumentContext
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.common.validation import validate_parameters

logger = logging.getLogger(__name__)

# Define supported file types for indexing
SUPPORTED_TEXT_EXTENSIONS = {
    # Code files
    ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".scss", ".java", 
    ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", 
    ".swift", ".kt", ".scala", ".sh", ".bash", ".ps1", ".sql",
    # Data files
    ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".md", ".rst",
    # Text files
    ".txt", ".log", ".env", ".ini", ".conf", ".config",
    # Documentation
    ".md", ".rst", ".adoc", ".tex"
}

# Support for image files (requires additional dependencies)
SUPPORTED_IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"
}

# Support for document files
SUPPORTED_DOCUMENT_EXTENSIONS = {
    ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"
}

# Define batch sizes for processing
EMBEDDING_BATCH_SIZE = 32
MAX_CHUNK_SIZE = 512  # Maximum tokens per chunk
CHUNK_OVERLAP = 50    # Overlap between chunks


class VectorStoreManager:
    """Vector store manager for Hanzo MCP.
    
    This class manages the integration with ChromaDB for vector search capabilities,
    providing tools for indexing, searching, and managing document embeddings.
    """

    def __init__(
        self,
        document_context: DocumentContext,
        permission_manager: PermissionManager,
    ) -> None:
        """Initialize vector store manager.
        
        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context = document_context
        self.permission_manager = permission_manager
        self._clients: Dict[str, chromadb.Client] = {}
        self._embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name="all-MiniLM-L6-v2"
        )

    def _get_persistent_path(self, project_dir: str) -> str:
        """Get the persistent path for a project's vector db.
        
        Args:
            project_dir: The project directory
            
        Returns:
            Path to the persistent store
        """
        # Hash the project path to create a unique identifier
        dir_hash = hashlib.md5(project_dir.encode()).hexdigest()
        
        # Store in the ~/.hanzo/vector_db directory
        home_dir = os.path.expanduser("~")
        vector_db_path = os.path.join(home_dir, ".hanzo", "vector_db", dir_hash)
        
        # Create the directory if it doesn't exist
        os.makedirs(vector_db_path, exist_ok=True)
        
        return vector_db_path

    def _get_client(self, project_dir: str) -> chromadb.Client:
        """Get or create a persistent ChromaDB client for a project.
        
        Args:
            project_dir: The project directory
            
        Returns:
            ChromaDB client
        """
        if project_dir not in self._clients:
            persistent_path = self._get_persistent_path(project_dir)
            settings = Settings(
                persist_directory=persistent_path,
                anonymized_telemetry=False
            )
            self._clients[project_dir] = chromadb.PersistentClient(
                path=persistent_path,
                settings=settings
            )
        
        return self._clients[project_dir]

    def _get_collection(self, project_dir: str) -> chromadb.Collection:
        """Get or create a ChromaDB collection for a project.
        
        Args:
            project_dir: The project directory
            
        Returns:
            ChromaDB collection
        """
        client = self._get_client(project_dir)
        try:
            return client.get_collection(
                name="project_files",
                embedding_function=self._embedding_function
            )
        except ValueError:
            # Collection doesn't exist, create it
            return client.create_collection(
                name="project_files",
                embedding_function=self._embedding_function,
                metadata={"project_dir": project_dir}
            )

    def _chunk_text(self, text: str, filepath: str) -> List[Tuple[str, Dict[str, Any]]]:
        """Chunk text into smaller pieces for embedding.
        
        Args:
            text: The text to chunk
            filepath: The filepath for metadata
            
        Returns:
            List of (chunk_text, metadata) tuples
        """
        # Simple chunking by paragraphs first, then by size if needed
        paragraphs = text.split("\n\n")
        chunks = []
        
        current_chunk = ""
        for para in paragraphs:
            # If adding this paragraph would exceed the chunk size, add the current chunk
            if len(current_chunk) + len(para) > MAX_CHUNK_SIZE and current_chunk:
                chunks.append(current_chunk)
                # Start a new chunk with overlap
                words = current_chunk.split()
                if len(words) > CHUNK_OVERLAP:
                    current_chunk = " ".join(words[-CHUNK_OVERLAP:]) + "\n\n"
                else:
                    current_chunk = ""
            
            # Add the paragraph to the current chunk
            if current_chunk:
                current_chunk += "\n\n" + para
            else:
                current_chunk = para
        
        # Add the last chunk if it's not empty
        if current_chunk:
            chunks.append(current_chunk)
        
        # Create metadata for each chunk
        result = []
        for i, chunk in enumerate(chunks):
            chunk_id = f"{filepath}#{i}"
            metadata = {
                "filepath": filepath,
                "chunk_index": i,
                "total_chunks": len(chunks),
                "file_extension": os.path.splitext(filepath)[1].lower(),
            }
            result.append((chunk, metadata))
        
        return result
    
    def _extract_pdf_text(self, filepath: str) -> List[Tuple[str, Dict[str, Any]]]:
        """Extract text from a PDF file.
        
        Args:
            filepath: Path to the PDF file
            
        Returns:
            List of (text, metadata) tuples
        """
        PyPDF2 = _import_pdf_parser()
        if PyPDF2 is None:
            return [(
                f"PDF file: {os.path.basename(filepath)} (PDF parsing not available)", 
                {
                    "filepath": filepath,
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "file_extension": ".pdf",
                    "type": "document"
                }
            )]
        
        chunks = []
        try:
            with open(filepath, "rb") as f:
                reader = PyPDF2.PdfReader(f)
                total_pages = len(reader.pages)
                
                # Process each page
                for i, page in enumerate(reader.pages):
                    text = page.extract_text()
                    if text.strip():
                        chunks.append((
                            text,
                            {
                                "filepath": filepath,
                                "chunk_index": i,
                                "total_chunks": total_pages,
                                "file_extension": ".pdf",
                                "type": "document",
                                "page": i + 1,
                                "total_pages": total_pages
                            }
                        ))
            
            # If no text was extracted, add a placeholder
            if not chunks:
                chunks = [(
                    f"PDF file: {os.path.basename(filepath)} (No text content)", 
                    {
                        "filepath": filepath,
                        "chunk_index": 0,
                        "total_chunks": 1,
                        "file_extension": ".pdf",
                        "type": "document"
                    }
                )]
                
        except Exception as e:
            chunks = [(
                f"PDF file: {os.path.basename(filepath)} (Error: {str(e)})", 
                {
                    "filepath": filepath,
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "file_extension": ".pdf",
                    "type": "document",
                    "error": str(e)
                }
            )]
            
        return chunks
    
    def _extract_docx_text(self, filepath: str) -> List[Tuple[str, Dict[str, Any]]]:
        """Extract text from a DOCX file.
        
        Args:
            filepath: Path to the DOCX file
            
        Returns:
            List of (text, metadata) tuples
        """
        docx = _import_docx_parser()
        if docx is None:
            return [(
                f"Word document: {os.path.basename(filepath)} (DOCX parsing not available)", 
                {
                    "filepath": filepath,
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "file_extension": ".docx",
                    "type": "document"
                }
            )]
        
        chunks = []
        try:
            doc = docx.Document(filepath)
            
            # Extract text from paragraphs
            text = "\n\n".join([para.text for para in doc.paragraphs if para.text.strip()])
            
            # Chunk the text
            if text.strip():
                text_chunks = self._chunk_text(text, filepath)
                chunks.extend(text_chunks)
            
            # If no text was extracted, add a placeholder
            if not chunks:
                chunks = [(
                    f"Word document: {os.path.basename(filepath)} (No text content)", 
                    {
                        "filepath": filepath,
                        "chunk_index": 0,
                        "total_chunks": 1,
                        "file_extension": ".docx",
                        "type": "document"
                    }
                )]
                
        except Exception as e:
            chunks = [(
                f"Word document: {os.path.basename(filepath)} (Error: {str(e)})", 
                {
                    "filepath": filepath,
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "file_extension": ".docx",
                    "type": "document",
                    "error": str(e)
                }
            )]
            
        return chunks
    
    def _process_image_file(self, filepath: str) -> List[Tuple[str, Dict[str, Any]]]:
        """Process an image file.
        
        Args:
            filepath: Path to the image file
            
        Returns:
            List of (placeholder, metadata) tuples
        """
        Image = _import_image_processor()
        if Image is None:
            return [(
                f"Image file: {os.path.basename(filepath)}", 
                {
                    "filepath": filepath,
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "file_extension": os.path.splitext(filepath)[1].lower(),
                    "type": "image"
                }
            )]
        
        try:
            # Get basic image metadata
            img = Image.open(filepath)
            width, height = img.size
            format_name = img.format
            mode = img.mode
            
            return [(
                f"Image file: {os.path.basename(filepath)}", 
                {
                    "filepath": filepath,
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "file_extension": os.path.splitext(filepath)[1].lower(),
                    "type": "image",
                    "width": width,
                    "height": height,
                    "format": format_name,
                    "mode": mode
                }
            )]
            
        except Exception as e:
            return [(
                f"Image file: {os.path.basename(filepath)} (Error: {str(e)})", 
                {
                    "filepath": filepath,
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "file_extension": os.path.splitext(filepath)[1].lower(),
                    "type": "image",
                    "error": str(e)
                }
            )]

    def _is_supported_file(self, filepath: str) -> bool:
        """Check if a file is supported for indexing.
        
        Args:
            filepath: Path to the file
            
        Returns:
            True if the file is supported, False otherwise
        """
        ext = os.path.splitext(filepath)[1].lower()
        return (ext in SUPPORTED_TEXT_EXTENSIONS or 
                ext in SUPPORTED_IMAGE_EXTENSIONS or 
                ext in SUPPORTED_DOCUMENT_EXTENSIONS)

    async def _read_and_index_file(
        self, 
        collection: chromadb.Collection,
        filepath: str,
        tool_ctx: ToolContext
    ) -> int:
        """Read and index a file.
        
        Args:
            collection: ChromaDB collection
            filepath: Path to the file
            tool_ctx: Tool context for logging
            
        Returns:
            Number of chunks indexed
        """
        if not self._is_supported_file(filepath):
            await tool_ctx.info(f"Skipping unsupported file: {filepath}")
            return 0
        
        try:
            # Check if file is already in the collection
            results = collection.get(
                where={"filepath": filepath},
                include=["metadatas"]
            )
            
            if results and results["metadatas"]:
                # Delete existing entries for this file
                collection.delete(
                    where={"filepath": filepath}
                )
                await tool_ctx.info(f"Removed existing entries for {filepath}")
            
            # Get file extension
            ext = os.path.splitext(filepath)[1].lower()
            
            # Process based on file type
            if ext in SUPPORTED_TEXT_EXTENSIONS:
                # Text file processing
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                
                # Chunk the content
                chunks = self._chunk_text(content, filepath)
            
            elif ext in SUPPORTED_IMAGE_EXTENSIONS:
                # For now, we'll just store a placeholder for images
                # In a real implementation, would use a library like PIL and CLIP
                chunks = [(
                    f"Image file: {os.path.basename(filepath)}", 
                    {
                        "filepath": filepath,
                        "chunk_index": 0,
                        "total_chunks": 1,
                        "file_extension": ext,
                        "type": "image"
                    }
                )]
                await tool_ctx.info(f"Indexed image file: {filepath}")
            
            elif ext in SUPPORTED_DOCUMENT_EXTENSIONS:
                # For now, we'll just store a placeholder for documents
                # In a real implementation, would use appropriate document parsers
                chunks = [(
                    f"Document file: {os.path.basename(filepath)}", 
                    {
                        "filepath": filepath,
                        "chunk_index": 0,
                        "total_chunks": 1,
                        "file_extension": ext,
                        "type": "document"
                    }
                )]
                await tool_ctx.info(f"Indexed document file: {filepath}")
            
            else:
                # This shouldn't happen due to the _is_supported_file check
                await tool_ctx.info(f"Unsupported file type: {filepath}")
                return 0
            
            if not chunks:
                await tool_ctx.info(f"No content to index in {filepath}")
                return 0
            
            # Index the chunks
            ids = [f"{chunk[1]['filepath']}#{chunk[1]['chunk_index']}" for chunk in chunks]
            texts = [chunk[0] for chunk in chunks]
            metadatas = [chunk[1] for chunk in chunks]
            
            # Add to collection
            collection.add(
                ids=ids,
                documents=texts,
                metadatas=metadatas
            )
            
            await tool_ctx.info(f"Indexed {len(chunks)} chunks from {filepath}")
            return len(chunks)
        
        except Exception as e:
            await tool_ctx.error(f"Error indexing {filepath}: {str(e)}")
            return 0

    async def _index_directory(
        self,
        collection: chromadb.Collection,
        directory: str,
        tool_ctx: ToolContext,
        recursive: bool = True,
        file_pattern: Optional[str] = None
    ) -> int:
        """Index a directory.
        
        Args:
            collection: ChromaDB collection
            directory: Path to the directory
            tool_ctx: Tool context for logging
            recursive: Whether to index subdirectories
            file_pattern: Optional file pattern to match
            
        Returns:
            Number of files indexed
        """
        indexed_files = 0
        
        # Walk through directory
        for root, dirs, files in os.walk(directory):
            # Skip hidden directories
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            
            for file in files:
                # Skip hidden files
                if file.startswith("."):
                    continue
                
                filepath = os.path.join(root, file)
                
                # Check if we should process this file based on pattern
                if file_pattern and not self._match_pattern(file, file_pattern):
                    continue
                
                # Check permissions
                if not self.permission_manager.is_path_allowed(filepath):
                    await tool_ctx.info(f"Skipping {filepath} - not in allowed paths")
                    continue
                
                # Process the file
                chunks_indexed = await self._read_and_index_file(collection, filepath, tool_ctx)
                if chunks_indexed > 0:
                    indexed_files += 1
            
            # Stop if not recursive
            if not recursive:
                break
        
        return indexed_files

    def _match_pattern(self, filename: str, pattern: str) -> bool:
        """Match a filename against a pattern.
        
        Args:
            filename: The filename to match
            pattern: The pattern to match against
            
        Returns:
            True if the filename matches the pattern, False otherwise
        """
        import fnmatch
        return fnmatch.fnmatch(filename, pattern)

    async def register_tools(self, mcp_server: FastMCP) -> None:
        """Register vector store tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        # Import here to avoid circular imports
        from hanzo_mcp.tools.vector.git_ingestor import GitIngestor
        
        # Initialize and register git ingestor tools
        git_ingestor = GitIngestor(self.permission_manager, self)
        await git_ingestor.register_tools(mcp_server)
        
        @mcp_server.tool("vector_index")
        async def vector_index(ctx: Any, path: str, recursive: bool = True, file_pattern: Optional[str] = None) -> str:
            """Index files or directories in the vector store.
            
            Args:
                path: Path to the file or directory to index
                recursive: Whether to index subdirectories (default: True)
                file_pattern: Optional file pattern to match (e.g., "*.py" for Python files)
                
            Returns:
                Result of the indexing operation
            """
            tool_ctx = create_tool_context(ctx)
            
            # Validate parameters
            validate_parameters(tool_ctx, {"path": path})
            
            # Check if path exists and is allowed
            if not os.path.exists(path):
                return await tool_ctx.error(f"Path does not exist: {path}")
            
            if not self.permission_manager.is_path_allowed(path):
                return await tool_ctx.error(f"Path is not allowed: {path}")
            
            # Get the project directory (parent directory of the path)
            project_dir = os.path.abspath(path if os.path.isdir(path) else os.path.dirname(path))
            
            await tool_ctx.info(f"Indexing {path} (project: {project_dir})")
            
            # Get the collection for this project
            collection = self._get_collection(project_dir)
            
            # Index the path
            if os.path.isdir(path):
                indexed_files = await self._index_directory(
                    collection, 
                    path, 
                    tool_ctx, 
                    recursive, 
                    file_pattern
                )
                return await tool_ctx.success(
                    f"Indexed {indexed_files} files from directory: {path}"
                )
            else:
                indexed_chunks = await self._read_and_index_file(collection, path, tool_ctx)
                return await tool_ctx.success(
                    f"Indexed {indexed_chunks} chunks from file: {path}"
                )

        @mcp_server.tool("vector_search")
        async def vector_search(
            ctx: Any, 
            query_text: str, 
            project_dir: str,
            n_results: int = 10,
            where_metadata: Optional[Dict[str, Any]] = None,
            where_document: Optional[Dict[str, str]] = None
        ) -> str:
            """Search the vector store with semantic search and full-text filtering.
            
            Args:
                query_text: The query text for semantic search
                project_dir: The project directory
                n_results: Number of results to return (default: 10)
                where_metadata: Optional metadata filter (e.g., {"file_extension": ".py"})
                where_document: Optional document filter (e.g., {"$contains": "function"})
                
            Returns:
                Search results
            """
            tool_ctx = create_tool_context(ctx)
            
            # Validate parameters
            validate_parameters(tool_ctx, {
                "query_text": query_text,
                "project_dir": project_dir
            })
            
            # Check if project directory exists and is allowed
            if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
                return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
            
            if not self.permission_manager.is_path_allowed(project_dir):
                return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
            
            # Get the client and collection
            try:
                client = self._get_client(project_dir)
                collection = client.get_collection(
                    name="project_files",
                    embedding_function=self._embedding_function
                )
            except ValueError:
                return await tool_ctx.error(
                    f"No vector index found for project: {project_dir}. "
                    f"Please index the project first with the vector_index tool."
                )
            
            # Perform the search
            try:
                results = collection.query(
                    query_texts=[query_text],
                    n_results=n_results,
                    where=where_metadata,
                    where_document=where_document,
                    include=["documents", "metadatas", "distances"]
                )
                
                # Format the results
                formatted_results = []
                for i, (doc, metadata, distance) in enumerate(zip(
                    results["documents"][0],
                    results["metadatas"][0],
                    results["distances"][0]
                )):
                    filepath = metadata["filepath"]
                    chunk_index = metadata["chunk_index"]
                    similarity = 1.0 - min(distance / 2.0, 1.0)  # Convert distance to similarity
                    
                    formatted_results.append({
                        "rank": i + 1,
                        "filepath": filepath,
                        "chunk_index": chunk_index,
                        "similarity": f"{similarity:.2f}",
                        "metadata": metadata,
                        "snippet": doc[:200] + "..." if len(doc) > 200 else doc
                    })
                
                return await tool_ctx.success(
                    f"Found {len(formatted_results)} results for query: {query_text}",
                    {
                        "query": query_text,
                        "project_dir": project_dir,
                        "results": formatted_results
                    }
                )
            
            except Exception as e:
                return await tool_ctx.error(f"Error searching vector store: {str(e)}")

        @mcp_server.tool("vector_delete")
        async def vector_delete(ctx: Any, project_dir: str, filepath: Optional[str] = None) -> str:
            """Delete documents from the vector store.
            
            Args:
                project_dir: The project directory
                filepath: Optional specific file to delete (if None, deletes all)
                
            Returns:
                Result of the deletion operation
            """
            tool_ctx = create_tool_context(ctx)
            
            # Validate parameters
            validate_parameters(tool_ctx, {"project_dir": project_dir})
            
            # Check if project directory exists and is allowed
            if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
                return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
            
            if not self.permission_manager.is_path_allowed(project_dir):
                return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
            
            # Get the client and collection
            try:
                client = self._get_client(project_dir)
                collection = client.get_collection(
                    name="project_files",
                    embedding_function=self._embedding_function
                )
            except ValueError:
                return await tool_ctx.error(f"No vector index found for project: {project_dir}")
            
            # Delete documents
            try:
                if filepath:
                    # Check if filepath is allowed
                    if not self.permission_manager.is_path_allowed(filepath):
                        return await tool_ctx.error(f"File path is not allowed: {filepath}")
                    
                    # Delete specific file
                    collection.delete(where={"filepath": filepath})
                    return await tool_ctx.success(f"Deleted entries for file: {filepath}")
                else:
                    # Delete all documents in the collection
                    collection.delete()
                    return await tool_ctx.success(f"Deleted all entries for project: {project_dir}")
            
            except Exception as e:
                return await tool_ctx.error(f"Error deleting from vector store: {str(e)}")

        @mcp_server.tool("vector_list")
        async def vector_list(ctx: Any, project_dir: str) -> str:
            """List indexed documents in the vector store.
            
            Args:
                project_dir: The project directory
                
            Returns:
                List of indexed documents
            """
            tool_ctx = create_tool_context(ctx)
            
            # Validate parameters
            validate_parameters(tool_ctx, {"project_dir": project_dir})
            
            # Check if project directory exists and is allowed
            if not os.path.exists(project_dir) or not os.path.isdir(project_dir):
                return await tool_ctx.error(f"Project directory does not exist: {project_dir}")
            
            if not self.permission_manager.is_path_allowed(project_dir):
                return await tool_ctx.error(f"Project directory is not allowed: {project_dir}")
            
            # Get the client and collection
            try:
                client = self._get_client(project_dir)
                collection = client.get_collection(
                    name="project_files",
                    embedding_function=self._embedding_function
                )
            except ValueError:
                return await tool_ctx.error(
                    f"No vector index found for project: {project_dir}. "
                    f"Please index the project first with the vector_index tool."
                )
            
            # Get all documents
            try:
                results = collection.get(include=["metadatas"])
                
                # Summarize files by counting chunks
                file_summary = {}
                for metadata in results["metadatas"]:
                    filepath = metadata["filepath"]
                    if filepath not in file_summary:
                        file_summary[filepath] = {
                            "chunks": 0,
                            "extension": metadata["file_extension"]
                        }
                    file_summary[filepath]["chunks"] += 1
                
                # Format the results
                formatted_results = []
                for filepath, info in file_summary.items():
                    formatted_results.append({
                        "filepath": filepath,
                        "chunks": info["chunks"],
                        "extension": info["extension"]
                    })
                
                # Sort by filepath
                formatted_results.sort(key=lambda x: x["filepath"])
                
                return await tool_ctx.success(
                    f"Found {len(formatted_results)} indexed files in project: {project_dir}",
                    {
                        "project_dir": project_dir,
                        "indexed_files": formatted_results,
                        "total_chunks": len(results["metadatas"])
                    }
                )
            
            except Exception as e:
                return await tool_ctx.error(f"Error listing vector store content: {str(e)}")
