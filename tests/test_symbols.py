"""Tests for the symbols module."""

import os
import pytest
from pathlib import Path
import tempfile

# Skip tests if tree-sitter is not available
try:
    from hanzo_mcp.tools.symbols.tree_sitter_manager import TreeSitterManager
    from hanzo_mcp.tools.symbols.symbol_finder import SymbolFinder
    from hanzo_mcp.tools.symbols.ast_explorer import ASTExplorer
    from hanzo_mcp.tools.symbols.symbolic_search import SymbolicSearch
    has_tree_sitter = True
except ImportError:
    has_tree_sitter = False


@pytest.mark.skipif(not has_tree_sitter, reason="tree-sitter not available")
class TestSymbols:
    """Test the symbols module."""

    @classmethod
    def setup_class(cls):
        """Set up the test class."""
        cls.tree_sitter_manager = TreeSitterManager()
        cls.symbol_finder = SymbolFinder(cls.tree_sitter_manager)
        cls.ast_explorer = ASTExplorer(cls.tree_sitter_manager)
        cls.symbolic_search = SymbolicSearch(cls.tree_sitter_manager, cls.symbol_finder)
        
        # Create a temporary file for testing
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.test_file_path = os.path.join(cls.temp_dir.name, "test.py")
        
        # Write some Python code to the file
        with open(cls.test_file_path, "w") as f:
            f.write("""def hello_world(name):
    \"\"\"Say hello to the world.\"\"\"
    return f"Hello, {name}!"

class TestClass:
    def __init__(self, value):
        self.value = value
    
    def get_value(self):
        return self.value

if __name__ == "__main__":
    test = TestClass(42)
    print(hello_world("World"))
    print(test.get_value())
""")

    @classmethod
    def teardown_class(cls):
        """Clean up the test class."""
        cls.temp_dir.cleanup()

    def test_tree_sitter_manager_initialization(self):
        """Test initializing TreeSitterManager."""
        assert self.tree_sitter_manager is not None
        
    def test_language_detection(self):
        """Test detecting languages."""
        language = self.tree_sitter_manager.detect_language(self.test_file_path)
        assert language == "python"
        
    def test_parse_file(self):
        """Test parsing a file."""
        tree = self.tree_sitter_manager.parse_file(self.test_file_path)
        assert tree is not None
        assert tree.root_node.type == "module"
        
    def test_find_symbol_definitions(self):
        """Test finding symbol definitions."""
        symbols = self.symbol_finder.find_symbol_definitions(self.test_file_path)
        
        # Check that we found the expected symbols
        assert len(symbols) >= 2
        
        # Check for specific symbols
        symbol_names = [s["name"] for s in symbols]
        assert "hello_world" in symbol_names
        assert "TestClass" in symbol_names
        
    def test_find_symbol_references(self):
        """Test finding symbol references."""
        references = self.symbol_finder.find_symbol_references(self.test_file_path, "hello_world")
        
        # Check that we found the reference
        assert len(references) >= 1
        
    def test_ast_exploration(self):
        """Test AST exploration."""
        ast = self.ast_explorer.get_ast(self.test_file_path, simplified=True)
        
        # Check that we got an AST
        assert ast is not None
        assert ast["type"] == "module"
        
    def test_syntax_structure(self):
        """Test extracting syntax structure."""
        structure = self.ast_explorer.extract_syntax_structure(self.test_file_path)
        
        # Check that we got a structure
        assert structure is not None
        assert structure["language"] == "python"
        
        # Check for specific elements
        assert "functions" in structure
        assert "classes" in structure
        
        # Check for specific items
        function_names = [f["name"] for f in structure["functions"]]
        class_names = [c["name"] for c in structure["classes"]]
        
        assert "hello_world" in function_names
        assert "TestClass" in class_names
