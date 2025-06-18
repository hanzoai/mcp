"""AST analysis and symbol extraction for code understanding."""

import ast
import json
from pathlib import Path
from typing import Dict, List, Any, Optional, Set, Tuple
from dataclasses import dataclass, asdict
import hashlib

try:
    import tree_sitter_python as tspython
    import tree_sitter
    TREE_SITTER_AVAILABLE = True
except ImportError:
    TREE_SITTER_AVAILABLE = False


@dataclass
class Symbol:
    """Represents a code symbol (function, class, variable, etc.)."""
    name: str
    type: str  # function, class, variable, import, etc.
    file_path: str
    line_start: int
    line_end: int
    column_start: int
    column_end: int
    scope: str  # global, class, function
    parent: Optional[str] = None  # parent class/function
    docstring: Optional[str] = None
    signature: Optional[str] = None
    references: List[str] = None  # Files that reference this symbol
    
    def __post_init__(self):
        if self.references is None:
            self.references = []


@dataclass 
class ASTNode:
    """Represents an AST node with metadata."""
    type: str
    name: Optional[str]
    line_start: int
    line_end: int
    column_start: int
    column_end: int
    children: List['ASTNode'] = None
    parent: Optional[str] = None
    
    def __post_init__(self):
        if self.children is None:
            self.children = []


@dataclass
class FileAST:
    """Complete AST representation of a file."""
    file_path: str
    file_hash: str
    language: str
    symbols: List[Symbol]
    ast_nodes: List[ASTNode]
    imports: List[str]
    exports: List[str]
    dependencies: List[str]  # Files this file depends on
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for storage."""
        return {
            "file_path": self.file_path,
            "file_hash": self.file_hash,
            "language": self.language,
            "symbols": [asdict(s) for s in self.symbols],
            "ast_nodes": [asdict(n) for n in self.ast_nodes],
            "imports": self.imports,
            "exports": self.exports,
            "dependencies": self.dependencies,
        }


class ASTAnalyzer:
    """Analyzes code files and extracts AST information and symbols."""
    
    def __init__(self):
        """Initialize the AST analyzer."""
        self.parsers = {}
        self._setup_parsers()
    
    def _setup_parsers(self):
        """Set up tree-sitter parsers for different languages."""
        if TREE_SITTER_AVAILABLE:
            try:
                # Python parser
                self.parsers['python'] = tree_sitter.Language(tspython.language())
            except Exception as e:
                print(f"Warning: Could not initialize Python parser: {e}")
    
    def analyze_file(self, file_path: str) -> Optional[FileAST]:
        """Analyze a file and extract AST information and symbols.
        
        Args:
            file_path: Path to the file to analyze
            
        Returns:
            FileAST object with extracted information, or None if analysis fails
        """
        path = Path(file_path)
        if not path.exists():
            return None
        
        # Determine language
        language = self._detect_language(path)
        if not language:
            return None
        
        try:
            # Read file content
            content = path.read_text(encoding='utf-8')
            file_hash = hashlib.sha256(content.encode()).hexdigest()
            
            # Extract symbols and AST
            if language == 'python':
                return self._analyze_python_file(file_path, content, file_hash)
            else:
                # Generic analysis for other languages
                return self._analyze_generic_file(file_path, content, file_hash, language)
                
        except Exception as e:
            print(f"Error analyzing file {file_path}: {e}")
            return None
    
    def _detect_language(self, path: Path) -> Optional[str]:
        """Detect programming language from file extension."""
        extension = path.suffix.lower()
        
        language_map = {
            '.py': 'python',
            '.js': 'javascript',
            '.ts': 'typescript',
            '.jsx': 'javascript',
            '.tsx': 'typescript',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'c',
            '.hpp': 'cpp',
            '.rs': 'rust',
            '.go': 'go',
            '.rb': 'ruby',
            '.php': 'php',
            '.cs': 'csharp',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.clj': 'clojure',
            '.hs': 'haskell',
            '.ml': 'ocaml',
            '.elm': 'elm',
            '.dart': 'dart',
            '.lua': 'lua',
            '.r': 'r',
            '.m': 'objective-c',
            '.mm': 'objective-cpp',
        }
        
        return language_map.get(extension)
    
    def _analyze_python_file(self, file_path: str, content: str, file_hash: str) -> FileAST:
        """Analyze Python file using both AST and tree-sitter."""
        symbols = []
        ast_nodes = []
        imports = []
        exports = []
        dependencies = []
        
        try:
            # Parse with Python AST
            tree = ast.parse(content)
            
            # Extract symbols using AST visitor
            visitor = PythonSymbolExtractor(file_path)
            visitor.visit(tree)
            
            symbols.extend(visitor.symbols)
            imports.extend(visitor.imports)
            exports.extend(visitor.exports)
            dependencies.extend(visitor.dependencies)
            
            # If tree-sitter is available, get more detailed AST
            if TREE_SITTER_AVAILABLE and 'python' in self.parsers:
                parser = tree_sitter.Parser(self.parsers['python'])
                ts_tree = parser.parse(content.encode())
                ast_nodes = self._extract_tree_sitter_nodes(ts_tree.root_node, content)
            
        except SyntaxError as e:
            print(f"Syntax error in {file_path}: {e}")
        except Exception as e:
            print(f"Error parsing Python file {file_path}: {e}")
        
        return FileAST(
            file_path=file_path,
            file_hash=file_hash,
            language='python',
            symbols=symbols,
            ast_nodes=ast_nodes,
            imports=imports,
            exports=exports,
            dependencies=dependencies,
        )
    
    def _analyze_generic_file(self, file_path: str, content: str, file_hash: str, language: str) -> FileAST:
        """Generic analysis for non-Python files."""
        # For now, just basic line-based analysis
        # Could be enhanced with language-specific parsers
        
        symbols = []
        ast_nodes = []
        imports = []
        exports = []
        dependencies = []
        
        # Basic pattern matching for common constructs
        lines = content.split('\n')
        for i, line in enumerate(lines, 1):
            line = line.strip()
            
            # Basic function detection (works for many C-style languages)
            if language in ['javascript', 'typescript', 'java', 'cpp', 'c']:
                if 'function ' in line or line.startswith('def ') or ' function(' in line:
                    # Extract function name
                    parts = line.split()
                    for j, part in enumerate(parts):
                        if part == 'function' and j + 1 < len(parts):
                            func_name = parts[j + 1].split('(')[0]
                            symbols.append(Symbol(
                                name=func_name,
                                type='function',
                                file_path=file_path,
                                line_start=i,
                                line_end=i,
                                column_start=0,
                                column_end=len(line),
                                scope='global',
                            ))
                            break
            
            # Basic import detection
            if 'import ' in line or '#include ' in line or 'require(' in line:
                imports.append(line)
        
        return FileAST(
            file_path=file_path,
            file_hash=file_hash,
            language=language,
            symbols=symbols,
            ast_nodes=ast_nodes,
            imports=imports,
            exports=exports,
            dependencies=dependencies,
        )
    
    def _extract_tree_sitter_nodes(self, node, content: str) -> List[ASTNode]:
        """Extract AST nodes from tree-sitter parse tree."""
        nodes = []
        
        def traverse(ts_node, parent_name=None):
            node_name = None
            
            # Try to extract node name for named nodes
            if ts_node.type in ['function_definition', 'class_definition', 'identifier']:
                for child in ts_node.children:
                    if child.type == 'identifier':
                        start_byte = child.start_byte
                        end_byte = child.end_byte
                        node_name = content[start_byte:end_byte]
                        break
            
            ast_node = ASTNode(
                type=ts_node.type,
                name=node_name,
                line_start=ts_node.start_point[0] + 1,
                line_end=ts_node.end_point[0] + 1,
                column_start=ts_node.start_point[1],
                column_end=ts_node.end_point[1],
                parent=parent_name,
            )
            
            nodes.append(ast_node)
            
            # Recursively process children
            for child in ts_node.children:
                traverse(child, node_name or parent_name)
        
        traverse(node)
        return nodes


class PythonSymbolExtractor(ast.NodeVisitor):
    """AST visitor for extracting Python symbols."""
    
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.symbols = []
        self.imports = []
        self.exports = []
        self.dependencies = []
        self.scope_stack = ['global']
    
    def visit_FunctionDef(self, node):
        """Visit function definitions."""
        scope = '.'.join(self.scope_stack)
        parent = self.scope_stack[-1] if len(self.scope_stack) > 1 else None
        
        # Extract docstring
        docstring = None
        if (node.body and isinstance(node.body[0], ast.Expr) and 
            isinstance(node.body[0].value, ast.Constant) and 
            isinstance(node.body[0].value.value, str)):
            docstring = node.body[0].value.value
        
        # Create function signature
        args = [arg.arg for arg in node.args.args]
        signature = f"{node.name}({', '.join(args)})"
        
        symbol = Symbol(
            name=node.name,
            type='function',
            file_path=self.file_path,
            line_start=node.lineno,
            line_end=node.end_lineno or node.lineno,
            column_start=node.col_offset,
            column_end=node.end_col_offset or 0,
            scope=scope,
            parent=parent if parent != 'global' else None,
            docstring=docstring,
            signature=signature,
        )
        
        self.symbols.append(symbol)
        
        # Enter function scope
        self.scope_stack.append(node.name)
        self.generic_visit(node)
        self.scope_stack.pop()
    
    def visit_AsyncFunctionDef(self, node):
        """Visit async function definitions."""
        self.visit_FunctionDef(node)  # Same logic
    
    def visit_ClassDef(self, node):
        """Visit class definitions."""
        scope = '.'.join(self.scope_stack)
        parent = self.scope_stack[-1] if len(self.scope_stack) > 1 else None
        
        # Extract docstring
        docstring = None
        if (node.body and isinstance(node.body[0], ast.Expr) and 
            isinstance(node.body[0].value, ast.Constant) and 
            isinstance(node.body[0].value.value, str)):
            docstring = node.body[0].value.value
        
        # Extract base classes
        bases = [self._get_name(base) for base in node.bases]
        signature = f"class {node.name}({', '.join(bases)})" if bases else f"class {node.name}"
        
        symbol = Symbol(
            name=node.name,
            type='class',
            file_path=self.file_path,
            line_start=node.lineno,
            line_end=node.end_lineno or node.lineno,
            column_start=node.col_offset,
            column_end=node.end_col_offset or 0,
            scope=scope,
            parent=parent if parent != 'global' else None,
            docstring=docstring,
            signature=signature,
        )
        
        self.symbols.append(symbol)
        
        # Enter class scope
        self.scope_stack.append(node.name)
        self.generic_visit(node)
        self.scope_stack.pop()
    
    def visit_Import(self, node):
        """Visit import statements."""
        for alias in node.names:
            import_name = alias.name
            self.imports.append(import_name)
            if '.' not in import_name:  # Top-level module
                self.dependencies.append(import_name)
    
    def visit_ImportFrom(self, node):
        """Visit from...import statements."""
        if node.module:
            self.imports.append(node.module)
            if '.' not in node.module:  # Top-level module
                self.dependencies.append(node.module)
        
        for alias in node.names:
            if alias.name != '*':
                import_item = f"{node.module}.{alias.name}" if node.module else alias.name
                self.imports.append(import_item)
    
    def visit_Assign(self, node):
        """Visit variable assignments."""
        scope = '.'.join(self.scope_stack)
        parent = self.scope_stack[-1] if len(self.scope_stack) > 1 else None
        
        for target in node.targets:
            if isinstance(target, ast.Name):
                symbol = Symbol(
                    name=target.id,
                    type='variable',
                    file_path=self.file_path,
                    line_start=node.lineno,
                    line_end=node.end_lineno or node.lineno,
                    column_start=node.col_offset,
                    column_end=node.end_col_offset or 0,
                    scope=scope,
                    parent=parent if parent != 'global' else None,
                )
                self.symbols.append(symbol)
        
        self.generic_visit(node)
    
    def _get_name(self, node):
        """Extract name from AST node."""
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Attribute):
            return f"{self._get_name(node.value)}.{node.attr}"
        elif isinstance(node, ast.Constant):
            return str(node.value)
        else:
            return str(node)


def create_symbol_embedding_text(symbol: Symbol) -> str:
    """Create text representation of symbol for vector embedding."""
    parts = [
        f"Symbol: {symbol.name}",
        f"Type: {symbol.type}",
        f"Scope: {symbol.scope}",
    ]
    
    if symbol.parent:
        parts.append(f"Parent: {symbol.parent}")
    
    if symbol.signature:
        parts.append(f"Signature: {symbol.signature}")
    
    if symbol.docstring:
        parts.append(f"Documentation: {symbol.docstring}")
    
    return " | ".join(parts)