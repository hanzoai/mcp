"""Symbolic search for finding related code symbols and patterns.

This module provides functionality for searching code symbols and
patterns across files using tree-sitter and symbolic relationships.
"""

import os
import glob
import logging
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Union, Any
import re

from hanzo_mcp.tools.symbols.tree_sitter_manager import TreeSitterManager
from hanzo_mcp.tools.symbols.symbol_finder import SymbolFinder

logger = logging.getLogger(__name__)


class SymbolicSearch:
    """Searches for symbolically related code using tree-sitter."""

    def __init__(self, tree_sitter_manager: TreeSitterManager, symbol_finder: SymbolFinder):
        """Initialize the SymbolicSearch.
        
        Args:
            tree_sitter_manager: TreeSitterManager instance for parsing
            symbol_finder: SymbolFinder instance for finding symbols
        """
        self.tree_sitter_manager = tree_sitter_manager
        self.symbol_finder = symbol_finder
    
    def find_related_symbols(
        self, 
        symbol_name: str, 
        project_dir: str,
        max_depth: int = 2,
        recursive: bool = True,
        file_pattern: str = "*.*"
    ) -> Dict[str, Any]:
        """Find symbols related to a given symbol in a project.
        
        Args:
            symbol_name: Symbol name to search for
            project_dir: Project directory to search in
            max_depth: Maximum relation depth to search
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            
        Returns:
            Dictionary with related symbols and their relationships
        """
        if not os.path.isdir(project_dir):
            logger.error(f"Not a directory: {project_dir}")
            return {"error": f"Not a directory: {project_dir}"}
        
        # Find all references to the symbol
        all_references = self.symbol_finder.find_references_in_directory(
            project_dir, symbol_name, recursive, file_pattern
        )
        
        # Find all definitions of the symbol
        all_definitions = self.symbol_finder.find_symbols_in_directory(
            project_dir, symbol_name, recursive, file_pattern
        )
        
        # Find directly related symbols (symbols that reference the target symbol)
        direct_relations = self._find_direct_relations(
            symbol_name, project_dir, recursive, file_pattern
        )
        
        # Find usage context of the symbol
        usage_contexts = self._analyze_usage_contexts(all_references)
        
        return {
            "symbol": symbol_name,
            "definitions": all_definitions,
            "references": all_references,
            "direct_relations": direct_relations,
            "usage_contexts": usage_contexts
        }
    
    def search_symbol_pattern(
        self, 
        pattern: str, 
        project_dir: str,
        recursive: bool = True,
        file_pattern: str = "*.*",
        symbol_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Search for symbols matching a pattern in a project.
        
        Args:
            pattern: Regular expression pattern to match
            project_dir: Project directory to search in
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            symbol_type: Optional type of symbol to restrict search to
            
        Returns:
            List of matching symbols with their definitions
        """
        if not os.path.isdir(project_dir):
            logger.error(f"Not a directory: {project_dir}")
            return []
        
        # Find all symbols in the project
        all_symbols = self.symbol_finder.find_symbols_in_directory(
            project_dir, None, recursive, file_pattern
        )
        
        # Filter by symbol type if specified
        if symbol_type:
            all_symbols = [s for s in all_symbols if s.get("type") == symbol_type]
        
        # Filter by pattern
        try:
            regex = re.compile(pattern)
            return [s for s in all_symbols if regex.search(s.get("name", ""))]
        except re.error as e:
            logger.error(f"Invalid regular expression pattern: {e}")
            return []
    
    def find_symbol_usages(
        self, 
        symbol_name: str, 
        project_dir: str,
        recursive: bool = True,
        file_pattern: str = "*.*",
        categorize: bool = True
    ) -> Dict[str, Any]:
        """Find and categorize usages of a symbol.
        
        Args:
            symbol_name: Symbol name to search for
            project_dir: Project directory to search in
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            categorize: Whether to categorize usages by type
            
        Returns:
            Dictionary with usage information
        """
        if not os.path.isdir(project_dir):
            logger.error(f"Not a directory: {project_dir}")
            return {"error": f"Not a directory: {project_dir}"}
        
        # Find all references to the symbol
        all_references = self.symbol_finder.find_references_in_directory(
            project_dir, symbol_name, recursive, file_pattern
        )
        
        # Find all definitions of the symbol
        all_definitions = self.symbol_finder.find_symbols_in_directory(
            project_dir, symbol_name, recursive, file_pattern
        )
        
        result = {
            "symbol": symbol_name,
            "definitions": all_definitions,
            "references": all_references,
            "total_usages": len(all_references)
        }
        
        # Categorize usages if requested
        if categorize:
            categorized_usages = self._categorize_usages(all_references)
            result["categorized_usages"] = categorized_usages
        
        return result
    
    def find_call_sites(
        self, 
        function_name: str, 
        project_dir: str,
        recursive: bool = True,
        file_pattern: str = "*.*"
    ) -> List[Dict[str, Any]]:
        """Find call sites for a function.
        
        Args:
            function_name: Function name to search for
            project_dir: Project directory to search in
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            
        Returns:
            List of call sites with location and context
        """
        if not os.path.isdir(project_dir):
            logger.error(f"Not a directory: {project_dir}")
            return []
        
        # Get all files
        pattern = os.path.join(project_dir, "**" if recursive else "", file_pattern)
        all_files = glob.glob(pattern, recursive=recursive)
        
        # Filter to supported files
        supported_files = [
            f for f in all_files 
            if os.path.isfile(f) and self.tree_sitter_manager.detect_language(f)
        ]
        
        call_sites = []
        
        # Search each file for call sites
        for file_path in supported_files:
            # Detect language
            language_name = self.tree_sitter_manager.detect_language(file_path)
            if not language_name:
                continue
            
            # Read file content
            try:
                with open(file_path, "rb") as f:
                    source_code = f.read()
            except Exception as e:
                logger.error(f"Error reading file {file_path}: {e}")
                continue
            
            # Language-specific query for function calls
            query_string = self._get_call_site_query(language_name, function_name)
            if not query_string:
                continue
            
            # Execute query
            matches = self.tree_sitter_manager.execute_query(language_name, query_string, source_code)
            
            # Process matches
            for match in matches:
                if "call" in match:
                    call_site = {
                        "file_path": file_path,
                        "location": match["call"]["location"],
                    }
                    
                    # Add arguments if available
                    if "arguments" in match:
                        call_site["arguments"] = match["arguments"]["text"]
                    
                    # Add context
                    line_number = match["call"]["location"]["start_line"] - 1  # 0-indexed
                    lines = source_code.splitlines()
                    if 0 <= line_number < len(lines):
                        try:
                            line_text = lines[line_number].decode("utf-8")
                            call_site["context"] = line_text.strip()
                        except (UnicodeDecodeError, IndexError):
                            call_site["context"] = ""
                    
                    call_sites.append(call_site)
        
        return call_sites
    
    def find_imports_for_symbol(
        self, 
        symbol_name: str, 
        project_dir: str,
        recursive: bool = True,
        file_pattern: str = "*.*"
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Find import statements related to a symbol.
        
        Args:
            symbol_name: Symbol name to search for
            project_dir: Project directory to search in
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            
        Returns:
            Dictionary with import statements grouped by file
        """
        # Get all files
        pattern = os.path.join(project_dir, "**" if recursive else "", file_pattern)
        all_files = glob.glob(pattern, recursive=recursive)
        
        # Filter to supported files
        supported_files = [
            f for f in all_files 
            if os.path.isfile(f) and self.tree_sitter_manager.detect_language(f)
        ]
        
        result = {}
        
        # Search each file for imports
        for file_path in supported_files:
            # Check if file contains the symbol
            references = self.symbol_finder.find_symbol_references(file_path, symbol_name)
            if not references:
                # If no references to the symbol, skip import analysis
                continue
            
            # Detect language
            language_name = self.tree_sitter_manager.detect_language(file_path)
            if not language_name:
                continue
            
            # Get import query for the language
            query_string = self._get_import_query(language_name)
            if not query_string:
                continue
            
            # Read file content
            try:
                with open(file_path, "rb") as f:
                    source_code = f.read()
            except Exception as e:
                logger.error(f"Error reading file {file_path}: {e}")
                continue
            
            # Execute query
            matches = self.tree_sitter_manager.execute_query(language_name, query_string, source_code)
            
            imports = []
            for match in matches:
                import_info = {"type": "unknown"}
                
                # Process based on language
                if language_name == "python":
                    if "import" in match:
                        import_info["type"] = "import"
                        if "import_name" in match:
                            import_info["name"] = match["import_name"]["text"]
                    elif "import_from" in match:
                        import_info["type"] = "from_import"
                        if "from_module" in match:
                            import_info["module"] = match["from_module"]["text"]
                        if "import_item" in match:
                            import_info["name"] = match["import_item"]["text"]
                
                elif language_name in ["javascript", "typescript"]:
                    if "import" in match:
                        import_info["type"] = "import"
                        if "import_source" in match:
                            import_info["source"] = match["import_source"]["text"].strip('\'"')
                
                elif language_name in ["java", "c", "cpp", "c_sharp"]:
                    if "include" in match:
                        import_info["type"] = "include"
                        if "include_path" in match:
                            import_info["path"] = match["include_path"]["text"].strip('\'"<>')
                
                # Add location
                for key, value in match.items():
                    if isinstance(value, dict) and "location" in value:
                        import_info["location"] = value["location"]
                        break
                
                imports.append(import_info)
            
            if imports:
                result[file_path] = imports
        
        return result
    
    def _find_direct_relations(
        self, 
        symbol_name: str, 
        project_dir: str,
        recursive: bool = True,
        file_pattern: str = "*.*"
    ) -> List[Dict[str, Any]]:
        """Find symbols that directly relate to the target symbol.
        
        Args:
            symbol_name: Symbol name to search for
            project_dir: Project directory to search in
            recursive: Whether to search recursively
            file_pattern: File pattern to match
            
        Returns:
            List of directly related symbols
        """
        # Get references to the symbol
        references = self.symbol_finder.find_references_in_directory(
            project_dir, symbol_name, recursive, file_pattern
        )
        
        # Extract potential parent symbols (e.g., functions that use this symbol)
        related_symbols = []
        processed_symbols = set()
        
        for ref in references:
            file_path = ref["file_path"]
            location = ref["location"]
            
            # Parse the file
            tree = self.tree_sitter_manager.parse_file(file_path)
            if not tree:
                continue
            
            # Find the node at the reference location
            line = location["start_line"] - 1  # 0-indexed
            column = location["start_column"] - 1  # 0-indexed
            point = (line, column)
            
            try:
                node = tree.root_node.descendant_for_point_range(point, point)
                
                # Find containing function, class, or method
                parent_node = node
                while parent_node and parent_node.type not in [
                    "function_definition", "class_definition", "method_definition", 
                    "function_declaration", "class_declaration", "method_declaration"
                ]:
                    parent_node = parent_node.parent
                
                if parent_node:
                    # Get parent node name
                    with open(file_path, "rb") as f:
                        source_code = f.read()
                    
                    # Find name node based on parent type
                    name_node = None
                    for child in parent_node.children:
                        if child.type == "identifier" or child.type == "property_identifier":
                            name_node = child
                            break
                    
                    if name_node:
                        parent_name = self.tree_sitter_manager.get_node_text(name_node, source_code)
                        
                        # Skip if this is the symbol itself or already processed
                        if parent_name == symbol_name or parent_name in processed_symbols:
                            continue
                        
                        processed_symbols.add(parent_name)
                        
                        # Add to related symbols
                        related_symbols.append({
                            "name": parent_name,
                            "type": parent_node.type.replace("_definition", "").replace("_declaration", ""),
                            "file_path": file_path,
                            "relation": "contains",
                            "location": {
                                "start_line": parent_node.start_point[0] + 1,
                                "start_column": parent_node.start_point[1] + 1,
                                "end_line": parent_node.end_point[0] + 1,
                                "end_column": parent_node.end_point[1] + 1
                            }
                        })
            except Exception as e:
                logger.error(f"Error processing node: {e}")
        
        return related_symbols
    
    def _analyze_usage_contexts(self, references: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Analyze the contexts in which a symbol is used.
        
        Args:
            references: List of references to analyze
            
        Returns:
            Dictionary with usage context information
        """
        # Count types of usage
        usage_types = {}
        
        for ref in references:
            parent_type = ref.get("parent_type", "unknown")
            
            # Normalize parent type names
            if "call" in parent_type or parent_type.endswith("_call"):
                context = "function_call"
            elif "assignment" in parent_type:
                context = "assignment"
            elif "parameter" in parent_type or "argument" in parent_type:
                context = "parameter"
            elif "condition" in parent_type or "if" in parent_type or "while" in parent_type:
                context = "condition"
            elif "return" in parent_type:
                context = "return"
            else:
                context = parent_type
            
            # Count occurrences
            usage_types[context] = usage_types.get(context, 0) + 1
        
        # Group references by file
        files = {}
        for ref in references:
            file_path = ref["file_path"]
            if file_path not in files:
                files[file_path] = 0
            files[file_path] += 1
        
        # Get most common usage contexts
        sorted_contexts = sorted(usage_types.items(), key=lambda x: x[1], reverse=True)
        
        return {
            "usage_count": len(references),
            "usage_types": usage_types,
            "files_count": len(files),
            "files": files,
            "most_common_contexts": sorted_contexts[:5] if sorted_contexts else []
        }
    
    def _categorize_usages(self, references: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
        """Categorize symbol usages by type.
        
        Args:
            references: List of references to categorize
            
        Returns:
            Dictionary with usages categorized by type
        """
        categories = {
            "read": [],
            "write": [],
            "call": [],
            "parameter": [],
            "other": []
        }
        
        for ref in references:
            parent_type = ref.get("parent_type", "unknown")
            
            if "call" in parent_type or parent_type.endswith("_call"):
                categories["call"].append(ref)
            elif "assignment" in parent_type and "left" in parent_type:
                categories["write"].append(ref)
            elif "parameter" in parent_type or "argument" in parent_type:
                categories["parameter"].append(ref)
            elif any(x in parent_type for x in ["assignment", "right", "value"]):
                categories["read"].append(ref)
            else:
                categories["other"].append(ref)
        
        return categories
    
    def _get_call_site_query(self, language: str, function_name: str) -> Optional[str]:
        """Get the appropriate query for finding function call sites.
        
        Args:
            language: The language name
            function_name: The function name to search for
            
        Returns:
            Query string for finding call sites or None if not available
        """
        # Escape function name for use in query
        escaped_name = function_name.replace("\"", "\\\"")
        
        queries = {
            "python": f"""
                (call
                    function: (identifier) @func_name
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """,
            
            "javascript": f"""
                (call_expression
                    function: (identifier) @func_name
                    arguments: (arguments) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
                
                (call_expression
                    function: (member_expression
                        property: (property_identifier) @func_name)
                    arguments: (arguments) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """,
            
            "typescript": f"""
                (call_expression
                    function: (identifier) @func_name
                    arguments: (arguments) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
                
                (call_expression
                    function: (member_expression
                        property: (property_identifier) @func_name)
                    arguments: (arguments) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """,
            
            "java": f"""
                (method_invocation
                    name: (identifier) @func_name
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """,
            
            "c": f"""
                (call_expression
                    function: (identifier) @func_name
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """,
            
            "cpp": f"""
                (call_expression
                    function: (identifier) @func_name
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
                
                (call_expression
                    function: (qualified_identifier
                        name: (identifier) @func_name)
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """,
            
            "go": f"""
                (call_expression
                    function: (identifier) @func_name
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
                
                (call_expression
                    function: (selector_expression
                        field: (identifier) @func_name)
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """,
            
            "ruby": f"""
                (call
                    method: (identifier) @func_name
                    arguments: (argument_list) @arguments) @call
                    (#eq? @func_name "{escaped_name}")
            """
        }
        
        return queries.get(language)
    
    def _get_import_query(self, language: str) -> Optional[str]:
        """Get the appropriate query for finding import statements.
        
        Args:
            language: The language name
            
        Returns:
            Query string for finding imports or None if not available
        """
        queries = {
            "python": """
                (import_statement
                    name: (dotted_name) @import_name) @import
                
                (import_from_statement
                    module_name: (dotted_name) @from_module
                    name: (dotted_name) @import_item) @import_from
            """,
            
            "javascript": """
                (import_statement
                    source: (string) @import_source) @import
            """,
            
            "typescript": """
                (import_statement
                    source: (string) @import_source) @import
            """,
            
            "java": """
                (import_declaration
                    name: (identifier) @import_name) @import
                
                (import_declaration
                    name: (qualified_identifier) @import_name) @import
            """,
            
            "c": """
                (preproc_include
                    path: (string_literal) @include_path) @include
                
                (preproc_include
                    path: (system_lib_string) @include_path) @include
            """,
            
            "cpp": """
                (preproc_include
                    path: (string_literal) @include_path) @include
                
                (preproc_include
                    path: (system_lib_string) @include_path) @include
            """
        }
        
        return queries.get(language)
