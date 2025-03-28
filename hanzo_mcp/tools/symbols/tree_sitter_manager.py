"""Tree-sitter manager for code parsing and analysis.

This module provides the core integration with tree-sitter for parsing
source code and managing syntax trees across different languages.
"""

import os
import logging
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Union, Any
import tempfile
import subprocess
import importlib.util

# Import tree-sitter conditionally
try:
    from tree_sitter import Language, Parser
    HAS_TREE_SITTER = True
except ImportError:
    HAS_TREE_SITTER = False
    Language = Any
    Parser = Any

logger = logging.getLogger(__name__)

# Map of file extensions to language names
LANGUAGE_EXTENSIONS = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".go": "go",
    ".rb": "ruby",
    ".rs": "rust",
    ".php": "php",
    ".cs": "c_sharp",
    ".swift": "swift",
    ".kt": "kotlin",
    ".sql": "sql",
    ".json": "json",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".xml": "xml",
    ".sh": "bash",
    ".bash": "bash",
}

# Map of language names to grammar repositories
LANGUAGE_REPOS = {
    "python": "https://github.com/tree-sitter/tree-sitter-python",
    "javascript": "https://github.com/tree-sitter/tree-sitter-javascript",
    "typescript": "https://github.com/tree-sitter/tree-sitter-typescript",
    "java": "https://github.com/tree-sitter/tree-sitter-java",
    "c": "https://github.com/tree-sitter/tree-sitter-c",
    "cpp": "https://github.com/tree-sitter/tree-sitter-cpp",
    "go": "https://github.com/tree-sitter/tree-sitter-go",
    "ruby": "https://github.com/tree-sitter/tree-sitter-ruby",
    "rust": "https://github.com/tree-sitter/tree-sitter-rust",
    "php": "https://github.com/tree-sitter/tree-sitter-php",
    "c_sharp": "https://github.com/tree-sitter/tree-sitter-c-sharp",
    "swift": "https://github.com/tree-sitter/tree-sitter-swift",
    "kotlin": "https://github.com/fwcd/tree-sitter-kotlin",
    "sql": "https://github.com/m-novikov/tree-sitter-sql",
    "json": "https://github.com/tree-sitter/tree-sitter-json",
    "html": "https://github.com/tree-sitter/tree-sitter-html",
    "css": "https://github.com/tree-sitter/tree-sitter-css",
    "scss": "https://github.com/serenadeai/tree-sitter-scss",
    "less": "https://github.com/serenadeai/tree-sitter-less",
    "yaml": "https://github.com/ikatyang/tree-sitter-yaml",
    "toml": "https://github.com/ikatyang/tree-sitter-toml",
    "xml": "https://github.com/tree-sitter-grammars/tree-sitter-xml",
    "bash": "https://github.com/tree-sitter/tree-sitter-bash",
}


class TreeSitterManager:
    """Manages tree-sitter parsers and provides utilities for working with syntax trees."""

    def __init__(self, languages: Optional[List[str]] = None):
        """Initialize the TreeSitterManager with specific languages.
        
        Args:
            languages: List of language names to initialize. If None, all supported languages
                       will be initialized on demand.
        """
        if not HAS_TREE_SITTER:
            raise ImportError(
                "tree-sitter is not installed. Please install it with: "
                "pip install tree-sitter"
            )
        
        self.parser = Parser()
        self.languages: Dict[str, Language] = {}
        self.languages_lib_path = self._get_languages_lib_path()
        
        # Initialize specified languages
        if languages:
            for language in languages:
                self.get_language(language)
        
        # Cache for parsed trees
        self.tree_cache: Dict[str, Tuple[float, Any]] = {}
        self.max_cache_size = 100
    
    def _get_languages_lib_path(self) -> Path:
        """Get or create the path for storing compiled tree-sitter language libraries.
        
        Returns:
            Path to the languages directory
        """
        home_dir = Path.home()
        ts_dir = home_dir / ".tree-sitter"
        languages_dir = ts_dir / "languages"
        
        # Create directories if they don't exist
        os.makedirs(languages_dir, exist_ok=True)
        
        # Create the languages.so file if it doesn't exist
        lib_path = ts_dir / "languages.so"
        
        return lib_path
    
    def get_language(self, language_name: str) -> Optional[Language]:
        """Get or build a tree-sitter language.
        
        Args:
            language_name: The name of the language to get
            
        Returns:
            The tree-sitter Language object or None if not available
        """
        # Return if already loaded
        if language_name in self.languages:
            return self.languages[language_name]
        
        # Try to load from existing library
        if self.languages_lib_path.exists():
            try:
                self.languages[language_name] = Language(
                    str(self.languages_lib_path), language_name
                )
                return self.languages[language_name]
            except Exception as e:
                logger.debug(f"Failed to load language {language_name}: {e}")
        
        # Try to build the language
        built = self._build_language(language_name)
        if built:
            try:
                self.languages[language_name] = Language(
                    str(self.languages_lib_path), language_name
                )
                return self.languages[language_name]
            except Exception as e:
                logger.error(f"Failed to load language {language_name} after building: {e}")
        
        return None
    
    def _build_language(self, language_name: str) -> bool:
        """Build a tree-sitter language from its repository.
        
        Args:
            language_name: The name of the language to build
            
        Returns:
            True if build successful, False otherwise
        """
        import json
        
        if language_name not in LANGUAGE_REPOS:
            logger.error(f"Unsupported language: {language_name}")
            return False
            
        repo_url = LANGUAGE_REPOS[language_name]
        
        with tempfile.TemporaryDirectory() as temp_dir:
            clone_dir = os.path.join(temp_dir, f"tree-sitter-{language_name}")
            
            # Clone the repository
            try:
                subprocess.run(
                    ["git", "clone", "--depth", "1", repo_url, clone_dir],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            except subprocess.CalledProcessError as e:
                logger.error(f"Failed to clone repository for {language_name}: {e}")
                return False
            
            # Build the language
            try:
                Language.build_library(
                    str(self.languages_lib_path),
                    [clone_dir]
                )
                return True
            except Exception as e:
                logger.error(f"Failed to build language {language_name}: {e}")
                return False
    
    def detect_language(self, file_path: str) -> Optional[str]:
        """Detect the language of a file based on its extension.
        
        Args:
            file_path: Path to the file
            
        Returns:
            The detected language name or None if unknown
        """
        ext = os.path.splitext(file_path)[1].lower()
        return LANGUAGE_EXTENSIONS.get(ext)
    
    def parse_file(self, file_path: str, force_reparse: bool = False) -> Optional[Any]:
        """Parse a source file and return its syntax tree.
        
        Args:
            file_path: Path to the file to parse
            force_reparse: Whether to force reparse even if cached
            
        Returns:
            The parsed tree or None if parsing failed
        """
        import os
        import time
        
        # Check file existence
        if not os.path.exists(file_path) or not os.path.isfile(file_path):
            logger.error(f"File does not exist: {file_path}")
            return None
        
        # Get file modification time
        mtime = os.path.getmtime(file_path)
        
        # Return cached tree if available and not force_reparse
        if not force_reparse and file_path in self.tree_cache:
            cached_mtime, tree = self.tree_cache[file_path]
            if cached_mtime >= mtime:
                return tree
        
        # Detect language
        language_name = self.detect_language(file_path)
        if not language_name:
            logger.warning(f"Unsupported file type: {file_path}")
            return None
        
        # Get language
        language = self.get_language(language_name)
        if not language:
            logger.error(f"Failed to load language for: {file_path}")
            return None
        
        # Set language
        self.parser.set_language(language)
        
        # Read file
        try:
            with open(file_path, "rb") as f:
                source_code = f.read()
        except Exception as e:
            logger.error(f"Error reading file {file_path}: {e}")
            return None
        
        # Parse file
        try:
            tree = self.parser.parse(source_code)
            
            # Update cache (manage cache size)
            if len(self.tree_cache) >= self.max_cache_size:
                # Remove oldest entry
                oldest_path = min(self.tree_cache.keys(), key=lambda k: self.tree_cache[k][0])
                del self.tree_cache[oldest_path]
            
            self.tree_cache[file_path] = (mtime, tree)
            return tree
        except Exception as e:
            logger.error(f"Error parsing file {file_path}: {e}")
            return None
    
    def parse_code(self, source_code: str, language_name: str) -> Optional[Any]:
        """Parse source code string and return its syntax tree.
        
        Args:
            source_code: Source code string to parse
            language_name: Language name
            
        Returns:
            The parsed tree or None if parsing failed
        """
        # Get language
        language = self.get_language(language_name)
        if not language:
            logger.error(f"Failed to load language: {language_name}")
            return None
        
        # Set language
        self.parser.set_language(language)
        
        # Parse code
        try:
            if isinstance(source_code, str):
                source_code = source_code.encode("utf-8")
            return self.parser.parse(source_code)
        except Exception as e:
            logger.error(f"Error parsing code: {e}")
            return None
    
    def get_node_text(self, node: Any, source_code: bytes) -> str:
        """Get the text of a node from the source code.
        
        Args:
            node: The tree-sitter node
            source_code: The source code as bytes
            
        Returns:
            The text of the node
        """
        start_byte = node.start_byte
        end_byte = node.end_byte
        return source_code[start_byte:end_byte].decode("utf-8")
    
    def get_node_location(self, node: Any) -> Dict[str, int]:
        """Get the location of a node.
        
        Args:
            node: The tree-sitter node
            
        Returns:
            Dictionary with start_line, start_column, end_line, end_column
        """
        return {
            "start_line": node.start_point[0] + 1,  # 1-indexed
            "start_column": node.start_point[1] + 1,  # 1-indexed
            "end_line": node.end_point[0] + 1,  # 1-indexed
            "end_column": node.end_point[1] + 1,  # 1-indexed
        }
    
    def execute_query(self, language_name: str, query_string: str, source_code: Union[str, bytes]) -> List[Dict[str, Any]]:
        """Execute a tree-sitter query on source code.
        
        Args:
            language_name: The language name
            query_string: The tree-sitter query string
            source_code: The source code to query
            
        Returns:
            List of matches, each with captured nodes
        """
        from tree_sitter import Query
        
        # Get language
        language = self.get_language(language_name)
        if not language:
            logger.error(f"Failed to load language: {language_name}")
            return []
        
        # Parse code
        if isinstance(source_code, str):
            source_bytes = source_code.encode("utf-8")
        else:
            source_bytes = source_code
        
        tree = self.parse_code(source_bytes, language_name)
        if not tree:
            return []
        
        # Create and execute query
        try:
            query = Query(language, query_string)
            captures = query.captures(tree.root_node)
            
            # Process captures
            results = []
            current_match = {}
            
            for node, capture_name in captures:
                # Get node info
                node_text = self.get_node_text(node, source_bytes)
                node_location = self.get_node_location(node)
                
                # Add to result
                if capture_name not in current_match:
                    current_match[capture_name] = {
                        "text": node_text,
                        "location": node_location,
                        "type": node.type,
                    }
                else:
                    # If we have a capture with the same name, finish this match
                    results.append(current_match)
                    current_match = {
                        capture_name: {
                            "text": node_text,
                            "location": node_location,
                            "type": node.type,
                        }
                    }
            
            # Add the last match if not empty
            if current_match:
                results.append(current_match)
            
            return results
        except Exception as e:
            logger.error(f"Error executing query: {e}")
            return []
    
    def find_all_nodes_of_type(self, tree: Any, node_type: str) -> List[Any]:
        """Find all nodes of a specific type in a tree.
        
        Args:
            tree: The parsed tree
            node_type: The type of node to find
            
        Returns:
            List of matching nodes
        """
        nodes = []
        
        def traverse(node):
            if node.type == node_type:
                nodes.append(node)
            
            for child in node.children:
                traverse(child)
        
        traverse(tree.root_node)
        return nodes
    
    def get_symbol_references(self, tree: Any, symbol_name: str, source_code: bytes) -> List[Dict[str, Any]]:
        """Find all references to a symbol in a tree.
        
        Args:
            tree: The parsed tree
            symbol_name: The name of the symbol to find
            source_code: The source code as bytes
            
        Returns:
            List of reference nodes with location information
        """
        references = []
        
        def traverse(node):
            if node.type == "identifier" and self.get_node_text(node, source_code) == symbol_name:
                references.append({
                    "text": symbol_name,
                    "location": self.get_node_location(node),
                    "type": node.type,
                    "parent_type": node.parent.type if node.parent else None,
                })
            
            for child in node.children:
                traverse(child)
        
        traverse(tree.root_node)
        return references
