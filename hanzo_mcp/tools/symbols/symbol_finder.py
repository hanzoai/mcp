"""Symbol finder for locating and navigating code symbols using tree-sitter.

This module provides functionality for finding and navigating code symbols
like variables, functions, classes, and their references.
"""

import os
import logging
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Union, Any

from hanzo_mcp.tools.symbols.tree_sitter_manager import TreeSitterManager

logger = logging.getLogger(__name__)


class SymbolFinder:
    """Finds and navigates code symbols using tree-sitter."""

    def __init__(self, tree_sitter_manager: TreeSitterManager):
        """Initialize the SymbolFinder.
        
        Args:
            tree_sitter_manager: TreeSitterManager instance for parsing
        """
        self.tree_sitter_manager = tree_sitter_manager
    
    def find_symbol_definitions(self, file_path: str, symbol_name: Optional[str] = None) -> List[Dict[str, Any]]:
        """Find symbol definitions in a file.
        
        Args:
            file_path: Path to the file to search
            symbol_name: Optional specific symbol name to find
            
        Returns:
            List of symbol definitions with location and metadata
        """
        # Parse the file
        tree = self.tree_sitter_manager.parse_file(file_path)
        if not tree:
            logger.error(f"Failed to parse file: {file_path}")
            return []
        
        # Read the file content
        with open(file_path, "rb") as f:
            source_code = f.read()
        
        # Detect language
        language_name = self.tree_sitter_manager.detect_language(file_path)
        if not language_name:
            logger.warning(f"Unsupported file type: {file_path}")
            return []
        
        # Get appropriate query for the language
        query_string = self._get_definition_query(language_name)
        if not query_string:
            logger.warning(f"No definition query available for language: {language_name}")
            return []
        
        # Execute query
        matches = self.tree_sitter_manager.execute_query(language_name, query_string, source_code)
        
        # Filter by symbol name if specified
        symbols = []
        for match in matches:
            if "name" in match and (not symbol_name or match["name"]["text"] == symbol_name):
                symbol_info = {
                    "name": match["name"]["text"],
                    "type": self._get_symbol_type(match),
                    "location": match["name"]["location"],
                    "file_path": file_path
                }
                
                # Add scope if available
                if "scope" in match:
                    symbol_info["scope"] = match["scope"]["text"]
                
                # Add additional info if available
                if "body" in match:
                    first_line = match["body"]["text"].splitlines()[0] if match["body"]["text"] else ""
                    symbol_info["preview"] = first_line[:60] + "..." if len(first_line) > 60 else first_line
                
                symbols.append(symbol_info)
        
        return symbols
    
    def find_symbol_references(self, file_path: str, symbol_name: str) -> List[Dict[str, Any]]:
        """Find references to a symbol in a file.
        
        Args:
            file_path: Path to the file to search
            symbol_name: Symbol name to find references for
            
        Returns:
            List of references with location information
        """
        # Parse the file
        tree = self.tree_sitter_manager.parse_file(file_path)
        if not tree:
            logger.error(f"Failed to parse file: {file_path}")
            return []
        
        # Read the file content
        with open(file_path, "rb") as f:
            source_code = f.read()
        
        # Find references
        references = self.tree_sitter_manager.get_symbol_references(tree, symbol_name, source_code)
        
        # Enhance references with context
        for ref in references:
            # Add file path
            ref["file_path"] = file_path
            
            # Add context (line of code)
            line_number = ref["location"]["start_line"] - 1  # 0-indexed
            lines = source_code.splitlines()
            if 0 <= line_number < len(lines):
                try:
                    line_text = lines[line_number].decode("utf-8")
                    ref["context"] = line_text.strip()
                except (UnicodeDecodeError, IndexError):
                    ref["context"] = ""
        
        return references
    
    def find_symbols_in_directory(
        self, 
        directory_path: str, 
        symbol_name: Optional[str] = None,
        recursive: bool = True,
        file_pattern: str = "*.*"
    ) -> List[Dict[str, Any]]:
        """Find symbols in all supported files in a directory.
        
        Args:
            directory_path: Path to the directory to search
            symbol_name: Optional specific symbol name to find
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            
        Returns:
            List of symbol definitions across files
        """
        import glob
        
        # Validate directory
        if not os.path.isdir(directory_path):
            logger.error(f"Not a directory: {directory_path}")
            return []
        
        # Get all files
        pattern = os.path.join(directory_path, "**" if recursive else "", file_pattern)
        all_files = glob.glob(pattern, recursive=recursive)
        
        # Filter to supported files
        supported_files = [
            f for f in all_files 
            if os.path.isfile(f) and self.tree_sitter_manager.detect_language(f)
        ]
        
        # Find symbols in each file
        all_symbols = []
        for file_path in supported_files:
            try:
                symbols = self.find_symbol_definitions(file_path, symbol_name)
                all_symbols.extend(symbols)
            except Exception as e:
                logger.error(f"Error processing file {file_path}: {e}")
        
        return all_symbols
    
    def find_references_in_directory(
        self, 
        directory_path: str, 
        symbol_name: str,
        recursive: bool = True,
        file_pattern: str = "*.*"
    ) -> List[Dict[str, Any]]:
        """Find references to a symbol in all supported files in a directory.
        
        Args:
            directory_path: Path to the directory to search
            symbol_name: Symbol name to find references for
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            
        Returns:
            List of references across files
        """
        import glob
        
        # Validate directory
        if not os.path.isdir(directory_path):
            logger.error(f"Not a directory: {directory_path}")
            return []
        
        # Get all files
        pattern = os.path.join(directory_path, "**" if recursive else "", file_pattern)
        all_files = glob.glob(pattern, recursive=recursive)
        
        # Filter to supported files
        supported_files = [
            f for f in all_files 
            if os.path.isfile(f) and self.tree_sitter_manager.detect_language(f)
        ]
        
        # Find references in each file
        all_references = []
        for file_path in supported_files:
            try:
                references = self.find_symbol_references(file_path, symbol_name)
                all_references.extend(references)
            except Exception as e:
                logger.error(f"Error processing file {file_path}: {e}")
        
        return all_references
    
    def _get_symbol_type(self, match: Dict[str, Any]) -> str:
        """Determine the symbol type from a match.
        
        Args:
            match: Tree-sitter query match
            
        Returns:
            Symbol type (function, class, variable, etc.)
        """
        # Try to determine from parent type
        if "name" in match and "parent_type" in match["name"]:
            parent_type = match["name"]["parent_type"]
            
            if "function" in parent_type or "method" in parent_type:
                return "function"
            elif "class" in parent_type:
                return "class"
            elif "variable" in parent_type:
                return "variable"
            elif "parameter" in parent_type:
                return "parameter"
            elif "import" in parent_type:
                return "import"
        
        # Try from captured node types
        for key in match:
            if key == "function" or key == "method":
                return "function"
            elif key == "class":
                return "class"
            elif key == "variable":
                return "variable"
            elif key == "parameter":
                return "parameter"
            elif key == "import":
                return "import"
        
        # Default
        return "unknown"
    
    def _get_definition_query(self, language: str) -> Optional[str]:
        """Get the appropriate definition query for a language.
        
        Args:
            language: The language name
            
        Returns:
            Query string for finding definitions or None if not available
        """
        queries = {
            "python": """
                (function_definition
                    name: (identifier) @name
                    body: (block) @body) @function
                
                (class_definition
                    name: (identifier) @name
                    body: (block) @body) @class
                
                (assignment
                    left: (identifier) @name
                    right: (_) @body) @variable
                
                (parameters
                    (identifier) @name) @parameter
            """,
            
            "javascript": """
                (function_declaration
                    name: (identifier) @name
                    body: (statement_block) @body) @function
                
                (class_declaration
                    name: (identifier) @name
                    body: (class_body) @body) @class
                
                (variable_declarator
                    name: (identifier) @name
                    value: (_) @body) @variable
                
                (formal_parameters
                    (identifier) @name) @parameter
                
                (arrow_function
                    parameters: (formal_parameters
                        (identifier) @name) @parameter
                    body: (_) @body) @function
                
                (method_definition
                    name: (property_identifier) @name
                    body: (statement_block) @body) @method
            """,
            
            "typescript": """
                (function_declaration
                    name: (identifier) @name
                    body: (statement_block) @body) @function
                
                (class_declaration
                    name: (identifier) @name
                    body: (class_body) @body) @class
                
                (variable_declarator
                    name: (identifier) @name
                    value: (_) @body) @variable
                
                (formal_parameters
                    (identifier) @name) @parameter
                
                (arrow_function
                    parameters: (formal_parameters
                        (identifier) @name) @parameter
                    body: (_) @body) @function
                
                (method_definition
                    name: (property_identifier) @name
                    body: (statement_block) @body) @method
                
                (interface_declaration
                    name: (identifier) @name
                    body: (object_type) @body) @interface
                
                (type_alias_declaration
                    name: (identifier) @name
                    value: (_) @body) @type
            """,
            
            "java": """
                (method_declaration
                    name: (identifier) @name
                    body: (block) @body) @method
                
                (class_declaration
                    name: (identifier) @name
                    body: (class_body) @body) @class
                
                (variable_declarator
                    name: (identifier) @name
                    value: (_) @body) @variable
                
                (formal_parameter
                    name: (identifier) @name) @parameter
                
                (interface_declaration
                    name: (identifier) @name
                    body: (interface_body) @body) @interface
            """,
            
            "c": """
                (function_definition
                    declarator: (function_declarator
                        declarator: (identifier) @name) @declarator
                    body: (compound_statement) @body) @function
                
                (declaration
                    declarator: (init_declarator
                        declarator: (identifier) @name
                        value: (_) @body)) @variable
                
                (parameter_declaration
                    declarator: (identifier) @name) @parameter
                
                (struct_specifier
                    name: (identifier) @name
                    body: (_) @body) @struct
            """,
            
            "cpp": """
                (function_definition
                    declarator: (function_declarator
                        declarator: (identifier) @name) @declarator
                    body: (compound_statement) @body) @function
                
                (declaration
                    declarator: (init_declarator
                        declarator: (identifier) @name
                        value: (_) @body)) @variable
                
                (parameter_declaration
                    declarator: (identifier) @name) @parameter
                
                (struct_specifier
                    name: (identifier) @name
                    body: (_) @body) @struct
                
                (class_specifier
                    name: (identifier) @name
                    body: (_) @body) @class
                
                (function_definition
                    declarator: (function_declarator
                        declarator: (qualified_identifier
                            name: (identifier) @name)) @declarator
                    body: (compound_statement) @body) @method
            """,
            
            "go": """
                (function_declaration
                    name: (identifier) @name
                    body: (block) @body) @function
                
                (method_declaration
                    name: (identifier) @name
                    body: (block) @body) @method
                
                (var_declaration
                    (var_spec
                        name: (identifier) @name
                        value: (_) @body)) @variable
                
                (parameter_declaration
                    name: (identifier) @name) @parameter
                
                (type_declaration
                    (type_spec
                        name: (identifier) @name
                        type: (_) @body)) @type
                
                (struct_type
                    name: (identifier) @name
                    body: (_) @body) @struct
                
                (interface_type
                    name: (identifier) @name
                    body: (_) @body) @interface
            """,
            
            "ruby": """
                (method
                    name: (identifier) @name
                    body: (body_statement) @body) @method
                
                (class
                    name: (constant) @name
                    body: (body_statement) @body) @class
                
                (assignment
                    left: (identifier) @name
                    right: (_) @body) @variable
                
                (block_parameter
                    (identifier) @name) @parameter
            """,
            
            # Default if no language-specific query
            "default": """
                (identifier) @name
            """
        }
        
        return queries.get(language, queries.get("default"))
