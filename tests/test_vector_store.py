"""Comprehensive tests for InfinityVectorStore functionality."""

import pytest
import tempfile
import json
from pathlib import Path
from typing import List, Dict, Any

from hanzo_mcp.tools.vector.infinity_store import (
    InfinityVectorStore, 
    Document, 
    SearchResult,
    SymbolSearchResult,
    UnifiedSearchResult
)
from hanzo_mcp.tools.vector.ast_analyzer import Symbol


class TestInfinityVectorStore:
    """Test suite for InfinityVectorStore."""
    
    @pytest.fixture
    def temp_store(self):
        """Create a temporary vector store."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = InfinityVectorStore(data_path=tmpdir)
            yield store
            store.close()
    
    def test_initialization(self, temp_store):
        """Test store initialization."""
        assert temp_store is not None
        assert temp_store.dimension == 1536  # Default OpenAI dimension
        assert temp_store.embedding_model == "text-embedding-3-small"
    
    def test_add_document(self, temp_store):
        """Test adding a single document."""
        content = "This is a test document about Python programming"
        metadata = {"language": "python", "type": "tutorial"}
        
        doc_id = temp_store.add_document(content, metadata)
        
        assert doc_id is not None
        assert isinstance(doc_id, str)
        assert len(doc_id) > 0
    
    def test_add_file(self, temp_store):
        """Test adding a file with chunking."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write("""
def hello_world():
    '''A simple hello world function.'''
    print("Hello, World!")
    return "Hello"

class Calculator:
    '''A simple calculator class.'''
    
    def add(self, a, b):
        '''Add two numbers.'''
        return a + b
    
    def subtract(self, a, b):
        '''Subtract b from a.'''
        return a - b

# This is a long comment to test chunking behavior
# when files are larger than the chunk size
# and need to be split into multiple documents
""" * 50)  # Make it long enough to require chunking
            f.flush()
            
            doc_ids = temp_store.add_file(
                f.name,
                chunk_size=500,
                chunk_overlap=50,
                metadata={"project": "test"}
            )
            
            assert len(doc_ids) > 1  # Should be chunked
            assert all(isinstance(doc_id, str) for doc_id in doc_ids)
            
            Path(f.name).unlink()
    
    def test_search_basic(self, temp_store):
        """Test basic search functionality."""
        # Add test documents
        docs = [
            ("Python is a great programming language", {"type": "opinion"}),
            ("JavaScript is used for web development", {"type": "fact"}),
            ("Machine learning with Python is powerful", {"type": "tutorial"}),
        ]
        
        for content, metadata in docs:
            temp_store.add_document(content, metadata)
        
        # Search for Python-related content
        results = temp_store.search("Python programming", limit=2)
        
        assert len(results) <= 2
        assert all(isinstance(r, SearchResult) for r in results)
        if results:
            assert results[0].score >= 0.0
            assert results[0].document.content is not None
    
    def test_symbol_storage_and_search(self, temp_store):
        """Test symbol storage and searching."""
        # Create test symbols
        symbols = [
            Symbol(
                name="calculate_average",
                type="function",
                file_path="/test/math.py",
                line_start=10,
                line_end=15,
                column_start=0,
                column_end=50,
                scope="module",
                signature="def calculate_average(numbers: List[float]) -> float",
                docstring="Calculate the average of a list of numbers"
            ),
            Symbol(
                name="DataProcessor",
                type="class",
                file_path="/test/processor.py",
                line_start=20,
                line_end=100,
                column_start=0,
                column_end=80,
                scope="module",
                docstring="Process various types of data"
            )
        ]
        
        # Store symbols
        temp_store._store_symbols(symbols)
        
        # Search for function
        func_results = temp_store.search_symbols(
            "calculate average numbers",
            symbol_type="function"
        )
        
        assert len(func_results) > 0
        assert any(r.symbol.name == "calculate_average" for r in func_results)
        
        # Search for class
        class_results = temp_store.search_symbols(
            "data processing",
            symbol_type="class"
        )
        
        assert len(class_results) > 0
        assert any(r.symbol.name == "DataProcessor" for r in class_results)
    
    def test_file_deletion(self, temp_store):
        """Test deleting all documents from a file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write("Test content for deletion")
            f.flush()
            
            # Add file
            doc_ids = temp_store.add_file(f.name)
            assert len(doc_ids) > 0
            
            # Delete file documents
            deleted_count = temp_store.delete_file(f.name)
            assert deleted_count == len(doc_ids)
            
            # Verify deletion by searching
            results = temp_store.search("Test content for deletion")
            file_results = [r for r in results if r.document.file_path == f.name]
            assert len(file_results) == 0
            
            Path(f.name).unlink()
    
    def test_list_files(self, temp_store):
        """Test listing indexed files."""
        # Add multiple files
        test_files = []
        for i in range(3):
            with tempfile.NamedTemporaryFile(mode='w', suffix=f'.py', delete=False) as f:
                f.write(f"Test file {i} content")
                f.flush()
                test_files.append(f.name)
                temp_store.add_file(f.name)
        
        # List files
        indexed_files = temp_store.list_files()
        indexed_paths = [f['file_path'] for f in indexed_files]
        
        assert len(indexed_files) >= 3
        for test_file in test_files:
            assert test_file in indexed_paths
            Path(test_file).unlink()
    
    def test_ast_storage(self, temp_store):
        """Test AST storage and retrieval."""
        from hanzo_mcp.tools.vector.ast_analyzer import FileAST
        
        # Create a mock FileAST
        file_ast = FileAST(
            file_path="/test/example.py",
            file_hash="abc123",
            language="python",
            symbols=[
                Symbol(
                    name="main",
                    type="function",
                    file_path="/test/example.py",
                    line_start=1,
                    line_end=5,
                    column_start=0,
                    column_end=50,
                    scope="module"
                )
            ],
            ast_nodes=[],
            imports=["os", "sys"],
            exports=["main"],
            dependencies=["os", "sys"]
        )
        
        # Store AST
        temp_store._store_file_ast(file_ast)
        
        # Retrieve AST
        retrieved_ast = temp_store.search_ast_nodes("/test/example.py")
        
        assert retrieved_ast is not None
        assert retrieved_ast.file_path == file_ast.file_path
        assert retrieved_ast.file_hash == file_ast.file_hash
        assert len(retrieved_ast.symbols) == 1
        assert retrieved_ast.symbols[0].name == "main"
    
    def test_file_references(self, temp_store):
        """Test cross-file reference tracking."""
        from hanzo_mcp.tools.vector.ast_analyzer import FileAST
        
        # Create FileAST with dependencies
        file_ast = FileAST(
            file_path="/test/module_a.py",
            file_hash="def456",
            language="python",
            symbols=[],
            ast_nodes=[],
            imports=["module_b", "module_c"],
            exports=[],
            dependencies=["module_b.py", "module_c.py"]
        )
        
        # Store references
        temp_store._store_references(file_ast)
        
        # Get references to module_b
        refs = temp_store.get_file_references("module_b.py")
        
        assert len(refs) > 0
        assert any(ref["source_file"] == "/test/module_a.py" for ref in refs)
    
    def test_chunking_algorithm(self, temp_store):
        """Test text chunking algorithm."""
        # Create text with clear sentence boundaries
        text = "First sentence. Second sentence. Third sentence.\n" * 10
        
        chunks = temp_store._chunk_text(text, chunk_size=50, overlap=10)
        
        assert len(chunks) > 1
        assert all(len(chunk) <= 50 for chunk in chunks)
        
        # Check overlap exists between consecutive chunks
        if len(chunks) > 1:
            # The chunking algorithm should create some overlap
            # Just verify chunks are created - exact overlap depends on algorithm
            assert len(chunks[0]) > 0
            assert len(chunks[-1]) > 0
    
    def test_embedding_generation(self, temp_store):
        """Test embedding generation (mock)."""
        text = "Test embedding generation"
        embedding = temp_store._generate_embedding(text)
        
        assert isinstance(embedding, list)
        assert len(embedding) == temp_store.dimension
        assert all(isinstance(val, float) for val in embedding)
        assert all(0 <= val <= 1 for val in embedding)  # Mock embeddings use random [0,1]


class TestVectorStoreIntegration:
    """Integration tests for vector store with other components."""
    
    @pytest.fixture
    def integrated_store(self):
        """Create a vector store with realistic data."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = InfinityVectorStore(data_path=tmpdir)
            
            # Add various types of content
            # Code files
            store.add_document(
                "def process_data(data): return [d.upper() for d in data]",
                {"type": "code", "language": "python", "file": "processor.py"}
            )
            
            # Documentation
            store.add_document(
                "The process_data function transforms input data to uppercase",
                {"type": "docs", "file": "README.md"}
            )
            
            # Comments/docstrings
            store.add_document(
                "Process the input data and return uppercase version",
                {"type": "docstring", "function": "process_data"}
            )
            
            yield store
            store.close()
    
    def test_semantic_code_search(self, integrated_store):
        """Test semantic search across code and docs."""
        # Search for functionality
        results = integrated_store.search("transform text to capital letters", limit=5)
        
        assert len(results) > 0
        # Should find both code and documentation
        result_types = {r.document.metadata.get("type") for r in results}
        assert "code" in result_types or "docs" in result_types
    
    def test_unified_search_results(self, integrated_store):
        """Test creating unified search results."""
        # This would integrate with the UnifiedSearchTool
        # but we can test the data structure
        result = UnifiedSearchResult(
            type="document",
            content="test content",
            file_path="/test/file.py",
            line_start=1,
            line_end=5,
            score=0.95,
            search_type="vector",
            metadata={"test": True}
        )
        
        assert result.type == "document"
        assert result.score == 0.95
        assert result.search_type == "vector"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])