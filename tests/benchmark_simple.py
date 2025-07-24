"""Simplified benchmark script for testing search on this project."""

import asyncio
import time
from pathlib import Path
import json

# Add project root to path
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem.search_tool import SearchTool
from hanzo_mcp.tools.filesystem.grep import Grep
from hanzo_mcp.tools.filesystem.symbols import SymbolsTool
from hanzo_mcp.tools.vector.ast_analyzer import ASTAnalyzer


async def simple_benchmark():
    """Run a simple benchmark on this MCP project."""
    print("🔍 Simple Unified Search Benchmark")
    print("=" * 50)
    
    # Setup
    project_root = Path(__file__).parent.parent
    permission_manager = PermissionManager()
    permission_manager.add_allowed_path(str(project_root))
    
    # Count project files
    python_files = list(project_root.rglob("*.py"))
    total_size = sum(f.stat().st_size for f in python_files)
    
    print(f"Project: {project_root}")
    print(f"Python files: {len(python_files)}")
    print(f"Total size: {total_size / 1024 / 1024:.2f} MB")
    print()
    
    # Mock context
    class MockContext:
        def __init__(self):
            self.meta = {}
    
    # Test AST Analysis Performance
    print("🧠 AST Analysis Performance")
    print("-" * 30)
    
    analyzer = ASTAnalyzer()
    analysis_times = []
    symbol_counts = []
    
    # Test on a sample of files (first 10)
    test_files = python_files[:10]
    
    for file_path in test_files:
        start_time = time.time()
        try:
            file_ast = analyzer.analyze_file(str(file_path))
            analysis_time = time.time() - start_time
            
            analysis_times.append(analysis_time)
            symbol_counts.append(len(file_ast.symbols) if file_ast else 0)
            
            print(f"  {file_path.name}: {analysis_time:.3f}s, {len(file_ast.symbols) if file_ast else 0} symbols")
            
        except Exception as e:
            print(f"  {file_path.name}: FAILED - {e}")
    
    if analysis_times:
        avg_time = sum(analysis_times) / len(analysis_times)
        avg_symbols = sum(symbol_counts) / len(symbol_counts)
        print(f"\\nAverage: {avg_time:.3f}s per file, {avg_symbols:.1f} symbols per file")
    
    print()
    
    # Test Search Performance
    print("🔍 Search Performance Tests")
    print("-" * 30)
    
    # Initialize tools (without vector search for simplicity)
    unified_tool = SearchTool(permission_manager, None)
    grep_tool = Grep(permission_manager)
    ast_tool = SymbolsTool(permission_manager)
    
    # Mock the validation methods
    unified_tool.validate_path = lambda x: type('obj', (object,), {'is_error': False})()
    unified_tool.check_path_allowed = lambda x, y: asyncio.coroutine(lambda: (True, None))()
    unified_tool.check_path_exists = lambda x, y: asyncio.coroutine(lambda: (True, None))()
    
    # Test queries
    queries = [
        "SearchTool",
        "def.*search",
        "error.handling", 
        "import.*typing",
        "class.*Tool"
    ]
    
    for query in queries:
        print(f"\\nQuery: '{query}'")
        
        # Test grep search
        start_time = time.time()
        try:
            grep_result = await grep_tool.call(
                MockContext(),
                pattern=query,
                path=str(project_root),
                include="*.py"
            )
            grep_time = time.time() - start_time
            grep_matches = grep_result.count("\\n") if grep_result and "Found" in grep_result else 0
            
            print(f"  Grep: {grep_time:.3f}s, ~{grep_matches} matches")
        except Exception as e:
            print(f"  Grep: FAILED - {e}")
        
        # Test AST search
        start_time = time.time()
        try:
            ast_result = await ast_tool.call(
                MockContext(),
                pattern=query,
                path=str(project_root),
                ignore_case=False,
                line_number=True
            )
            ast_time = time.time() - start_time
            ast_matches = ast_result.count("\\n") if ast_result and not ast_result.startswith("No matches") else 0
            
            print(f"  AST: {ast_time:.3f}s, ~{ast_matches} matches")
        except Exception as e:
            print(f"  AST: FAILED - {e}")
        
        # Test search (without vector)
        start_time = time.time()
        try:
            unified_result = await unified_tool.call(
                MockContext(),
                pattern=query,
                path=str(project_root),
                enable_vector=False,  # Disable vector to avoid dependencies
                max_results=20
            )
            unified_time = time.time() - start_time
            unified_matches = unified_result.count("Result ") if "Result " in unified_result else 0
            
            print(f"  Unified: {unified_time:.3f}s, {unified_matches} results")
        except Exception as e:
            print(f"  Unified: FAILED - {e}")
    
    print("\\n" + "=" * 50)
    print("✅ Simple benchmark completed!")


if __name__ == "__main__":
    asyncio.run(simple_benchmark())