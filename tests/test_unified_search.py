"""Comprehensive test suite for unified search functionality."""

import asyncio
import os
import tempfile
import time
from pathlib import Path
from typing import List, Dict, Any
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem.unified_search import (
    UnifiedSearchTool,
    SearchResult,
    SearchType,
    UnifiedSearchResults
)


class TestUnifiedSearchTool:
    """Test suite for the UnifiedSearchTool."""
    
    @pytest.fixture
    def permission_manager(self):
        """Create a permission manager for testing."""
        pm = PermissionManager()
        pm.add_allowed_path("/tmp")
        pm.add_allowed_path(".")
        return pm
    
    @pytest.fixture
    def mock_project_manager(self):
        """Create a mock project manager."""
        mock_pm = MagicMock()
        mock_pm.search_all_projects = AsyncMock(return_value={})
        mock_pm.get_project_for_path = MagicMock(return_value=None)
        mock_pm._get_global_store = MagicMock()
        mock_pm.projects = {}
        return mock_pm
    
    @pytest.fixture
    def unified_search_tool(self, permission_manager, mock_project_manager):
        """Create a unified search tool instance."""
        return UnifiedSearchTool(permission_manager, mock_project_manager)
    
    @pytest.fixture
    def mock_context(self):
        """Create a mock MCP context."""
        ctx = MagicMock()
        ctx.meta = MagicMock()
        return ctx
    
    @pytest.fixture
    def test_files(self):
        """Create temporary test files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_dir = Path(tmpdir)
            
            # Create test Python file
            python_file = test_dir / "test_module.py"
            python_file.write_text("""
def hello_world():
    '''Say hello to the world.'''
    print("Hello, world!")
    return "greeting"

class TestClass:
    '''A test class for demonstration.'''
    
    def test_method(self):
        '''Test method with error handling.'''
        try:
            result = hello_world()
            return result
        except Exception as e:
            print(f"Error occurred: {e}")
            raise

def complex_function(data, options=None):
    '''Complex function for testing search.'''
    if options is None:
        options = {}
    
    # Process data with error handling
    processed = []
    for item in data:
        try:
            processed.append(item.upper())
        except AttributeError:
            processed.append(str(item))
    
    return processed
""")
            
            # Create test JavaScript file
            js_file = test_dir / "test_script.js"
            js_file.write_text("""
function helloWorld() {
    console.log("Hello, world!");
    return "greeting";
}

class TestClass {
    constructor() {
        this.name = "test";
    }
    
    testMethod() {
        try {
            return helloWorld();
        } catch (error) {
            console.error("Error occurred:", error);
            throw error;
        }
    }
}

function complexFunction(data, options = {}) {
    const processed = data.map(item => {
        try {
            return item.toUpperCase();
        } catch (error) {
            return String(item);
        }
    });
    
    return processed;
}
""")
            
            # Create test documentation file
            md_file = test_dir / "README.md"
            md_file.write_text("""
# Test Project

This is a test project for demonstrating unified search capabilities.

## Features

- Hello world functionality
- Error handling
- Complex data processing
- Multi-language support

## Usage

```python
from test_module import hello_world
result = hello_world()
```

## Error Handling

The project includes comprehensive error handling throughout.
""")
            
            yield {
                "dir": test_dir,
                "python": python_file,
                "javascript": js_file,
                "markdown": md_file
            }

    def test_search_intent_detection(self, unified_search_tool):
        """Test the search intent detection logic."""
        # Regex pattern should disable vector search
        use_vector, use_ast, use_symbol = unified_search_tool._detect_search_intent(".*error")
        assert not use_vector
        assert use_ast
        assert use_symbol
        
        # Function name should enable symbol and AST
        use_vector, use_ast, use_symbol = unified_search_tool._detect_search_intent("hello_world")
        assert use_vector  # Could be semantic
        assert use_ast
        assert use_symbol
        
        # Natural language should enable vector search
        use_vector, use_ast, use_symbol = unified_search_tool._detect_search_intent("error handling functionality")
        assert use_vector
        assert use_ast
        assert use_symbol

    @pytest.mark.asyncio
    async def test_grep_search(self, unified_search_tool, test_files, mock_context):
        """Test grep search functionality."""
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mock_context
        
        with patch.object(unified_search_tool, 'create_tool_context', return_value=tool_ctx):
            with patch.object(unified_search_tool.grep_tool, 'call') as mock_grep:
                mock_grep.return_value = """Found 2 matches in 1 file:

test_module.py:3: def hello_world():
test_module.py:15: result = hello_world()"""
                
                results = await unified_search_tool._run_grep_search(
                    "hello_world", str(test_files["dir"]), "*", tool_ctx, 10
                )
                
                assert len(results) == 2
                assert all(r.search_type == SearchType.GREP for r in results)
                assert results[0].file_path == "test_module.py"
                assert results[0].line_number == 3
                assert "def hello_world():" in results[0].content

    @pytest.mark.asyncio
    async def test_ast_search(self, unified_search_tool, test_files, mock_context):
        """Test AST search functionality."""
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mock_context
        
        with patch.object(unified_search_tool, 'create_tool_context', return_value=tool_ctx):
            with patch.object(unified_search_tool.grep_ast_tool, 'call') as mock_ast:
                mock_ast.return_value = f"""
{test_files["python"]}:
3: def hello_world():
4:     '''Say hello to the world.'''
5:     print("Hello, world!")
6:     return "greeting"
"""
                
                results = await unified_search_tool._run_ast_search(
                    "hello_world", str(test_files["dir"]), "*", tool_ctx, 10
                )
                
                assert len(results) > 0
                assert all(r.search_type == SearchType.AST for r in results)

    @pytest.mark.asyncio
    async def test_symbol_search(self, unified_search_tool, test_files, mock_context):
        """Test symbol search functionality."""
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        
        with patch.object(unified_search_tool, 'create_tool_context', return_value=tool_ctx):
            # Mock the AST analyzer
            with patch.object(unified_search_tool.ast_analyzer, 'analyze_file') as mock_analyze:
                from hanzo_mcp.tools.vector.ast_analyzer import Symbol, FileAST
                
                # Create mock symbols
                symbol = Symbol(
                    name="hello_world",
                    type="function", 
                    file_path=str(test_files["python"]),
                    line_start=3,
                    line_end=6,
                    column_start=0,
                    column_end=20,
                    scope="global",
                    signature="hello_world()"
                )
                
                mock_ast = FileAST(
                    file_path=str(test_files["python"]),
                    file_hash="test_hash",
                    language="python",
                    symbols=[symbol],
                    ast_nodes=[],
                    imports=[],
                    exports=[],
                    dependencies=[]
                )
                
                mock_analyze.return_value = mock_ast
                
                results = await unified_search_tool._run_symbol_search(
                    "hello_world", str(test_files["dir"]), tool_ctx, 10
                )
                
                assert len(results) > 0
                assert all(r.search_type == SearchType.SYMBOL for r in results)
                assert results[0].symbol_info is not None
                assert results[0].symbol_info.name == "hello_world"

    @pytest.mark.asyncio
    async def test_vector_search(self, unified_search_tool, test_files, mock_context):
        """Test vector search functionality."""
        tool_ctx = MagicMock()
        tool_ctx.info = AsyncMock()
        tool_ctx.error = AsyncMock()
        tool_ctx.mcp_context = mock_context
        
        # Mock vector tool
        unified_search_tool.vector_tool = MagicMock()
        unified_search_tool.vector_tool.call = AsyncMock()
        unified_search_tool.vector_tool.call.return_value = """Found 1 results for query: 'error handling'

Result 1 (Score: 85.5%) - Project: test
test_module.py [Chunk 0]
Content:
Test method with error handling.
try:
    result = hello_world()
    return result
except Exception as e:
    print(f"Error occurred: {e}")"""
        
        with patch.object(unified_search_tool, 'create_tool_context', return_value=tool_ctx):
            results = await unified_search_tool._run_vector_search(
                "error handling", str(test_files["dir"]), tool_ctx, 10
            )
            
            assert len(results) > 0
            assert all(r.search_type == SearchType.VECTOR for r in results)

    @pytest.mark.asyncio
    async def test_full_unified_search(self, unified_search_tool, test_files, mock_context):
        """Test complete unified search functionality."""
        with patch.object(unified_search_tool, 'validate_path') as mock_validate:
            mock_validate.return_value = MagicMock(is_error=False)
            
            with patch.object(unified_search_tool, 'check_path_allowed') as mock_allowed:
                mock_allowed.return_value = (True, None)
                
                with patch.object(unified_search_tool, 'check_path_exists') as mock_exists:
                    mock_exists.return_value = (True, None)
                    
                    with patch.object(unified_search_tool, 'create_tool_context') as mock_tool_ctx:
                        tool_ctx = MagicMock()
                        tool_ctx.info = AsyncMock()
                        tool_ctx.error = AsyncMock()
                        tool_ctx.mcp_context = mock_context
                        mock_tool_ctx.return_value = tool_ctx
                        
                        # Mock all search methods
                        with patch.object(unified_search_tool, '_run_grep_search') as mock_grep:
                            with patch.object(unified_search_tool, '_run_ast_search') as mock_ast:
                                with patch.object(unified_search_tool, '_run_symbol_search') as mock_symbol:
                                    
                                    # Setup mock results
                                    grep_result = SearchResult(
                                        file_path="test.py",
                                        line_number=1,
                                        content="def hello_world():",
                                        search_type=SearchType.GREP,
                                        score=1.0
                                    )
                                    
                                    ast_result = SearchResult(
                                        file_path="test.py", 
                                        line_number=1,
                                        content="def hello_world():",
                                        search_type=SearchType.AST,
                                        score=0.9,
                                        context="function definition"
                                    )
                                    
                                    symbol_result = SearchResult(
                                        file_path="test.py",
                                        line_number=1, 
                                        content="function hello_world",
                                        search_type=SearchType.SYMBOL,
                                        score=0.95
                                    )
                                    
                                    mock_grep.return_value = [grep_result]
                                    mock_ast.return_value = [ast_result]
                                    mock_symbol.return_value = [symbol_result]
                                    
                                    # Execute unified search
                                    result = await unified_search_tool.call(
                                        mock_context,
                                        pattern="hello_world",
                                        path=str(test_files["dir"]),
                                        max_results=10
                                    )
                                    
                                    assert "Unified Search Results" in result
                                    assert "hello_world" in result
                                    assert "Found" in result

    def test_result_combination_and_ranking(self, unified_search_tool):
        """Test result combination and ranking logic."""
        # Create test results
        grep_result = SearchResult(
            file_path="test.py",
            line_number=1,
            content="def hello_world():",
            search_type=SearchType.GREP,
            score=1.0
        )
        
        ast_result = SearchResult(
            file_path="test.py",
            line_number=1,
            content="def hello_world():",
            search_type=SearchType.AST,
            score=0.9,
            context="function definition"
        )
        
        symbol_result = SearchResult(
            file_path="test.py",
            line_number=1,
            content="function hello_world",
            search_type=SearchType.SYMBOL,
            score=0.95
        )
        
        vector_result = SearchResult(
            file_path="other.py",
            line_number=5,
            content="call hello_world function",
            search_type=SearchType.VECTOR,
            score=0.8
        )
        
        results_by_type = {
            SearchType.GREP: [grep_result],
            SearchType.AST: [ast_result], 
            SearchType.SYMBOL: [symbol_result],
            SearchType.VECTOR: [vector_result]
        }
        
        combined = unified_search_tool._combine_and_rank_results(results_by_type)
        
        # Should have 2 unique results (3 duplicates merged into 1)
        assert len(combined) == 2
        
        # Should be sorted by score (symbol score should win for duplicates)
        assert combined[0].score == 0.95  # Symbol result wins
        assert combined[1].score == 0.8   # Vector result

    def test_search_result_serialization(self):
        """Test SearchResult and UnifiedSearchResults serialization."""
        from hanzo_mcp.tools.vector.ast_analyzer import Symbol
        
        symbol = Symbol(
            name="test_func",
            type="function",
            file_path="test.py",
            line_start=1,
            line_end=5,
            column_start=0,
            column_end=20,
            scope="global"
        )
        
        result = SearchResult(
            file_path="test.py",
            line_number=1,
            content="def test_func():",
            search_type=SearchType.GREP,
            score=1.0,
            context="function definition",
            symbol_info=symbol
        )
        
        # Test serialization
        result_dict = result.to_dict()
        assert result_dict["file_path"] == "test.py"
        assert result_dict["search_type"] == "grep"
        assert result_dict["symbol_info"]["name"] == "test_func"
        
        # Test UnifiedSearchResults
        unified_results = UnifiedSearchResults(
            query="test",
            total_results=1,
            results_by_type={SearchType.GREP: [result]},
            combined_results=[result],
            search_time_ms=100.5
        )
        
        unified_dict = unified_results.to_dict()
        assert unified_dict["query"] == "test"
        assert unified_dict["total_results"] == 1
        assert unified_dict["search_time_ms"] == 100.5


class TestUnifiedSearchIntegration:
    """Integration tests for unified search with real file operations."""
    
    @pytest.fixture
    def real_test_environment(self):
        """Create a real test environment with actual files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_dir = Path(tmpdir)
            
            # Create a small Python project
            (test_dir / "__init__.py").touch()
            
            main_file = test_dir / "main.py"
            main_file.write_text("""
#!/usr/bin/env python3
'''Main module for testing unified search.'''

import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

class DataProcessor:
    '''Processes data with error handling.'''
    
    def __init__(self, config: Optional[dict] = None):
        self.config = config or {}
        logger.info("DataProcessor initialized")
    
    def process_items(self, items: List[str]) -> List[str]:
        '''Process a list of items with error handling.'''
        processed = []
        
        for item in items:
            try:
                result = self._process_single_item(item)
                processed.append(result)
            except ValueError as e:
                logger.error(f"Error processing item {item}: {e}")
                continue
            except Exception as e:
                logger.critical(f"Unexpected error: {e}")
                raise
        
        return processed
    
    def _process_single_item(self, item: str) -> str:
        '''Process a single item.'''
        if not item.strip():
            raise ValueError("Empty item")
        
        return item.upper().strip()

def main():
    '''Main function with comprehensive error handling.'''
    try:
        processor = DataProcessor()
        test_data = ["hello", "world", "", "test"]
        
        results = processor.process_items(test_data)
        print(f"Processed {len(results)} items successfully")
        
        return results
    except Exception as e:
        logger.error(f"Main execution failed: {e}")
        return []

if __name__ == "__main__":
    main()
""")
            
            utils_file = test_dir / "utils.py"
            utils_file.write_text("""
'''Utility functions for the test project.'''

import re
from typing import Union, Optional

def validate_input(data: Union[str, int, float]) -> bool:
    '''Validate input data with error handling.'''
    try:
        if isinstance(data, str):
            return bool(data.strip())
        elif isinstance(data, (int, float)):
            return not (data is None or data != data)  # Check for NaN
        else:
            return False
    except Exception:
        return False

def format_error_message(error: Exception, context: Optional[str] = None) -> str:
    '''Format error messages consistently.'''
    base_msg = f"{type(error).__name__}: {str(error)}"
    
    if context:
        return f"[{context}] {base_msg}"
    
    return base_msg

def extract_function_names(code: str) -> List[str]:
    '''Extract function names from Python code.'''
    pattern = r'def\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\('
    matches = re.findall(pattern, code)
    return matches
""")
            
            yield {
                "dir": test_dir,
                "main": main_file,
                "utils": utils_file
            }

    @pytest.mark.asyncio
    async def test_real_unified_search(self, real_test_environment):
        """Test unified search on real files."""
        permission_manager = PermissionManager()
        permission_manager.add_allowed_path(str(real_test_environment["dir"]))
        
        # Test without vector search (no project manager)
        unified_tool = UnifiedSearchTool(permission_manager, None)
        
        # Mock context
        ctx = MagicMock()
        
        # Test search for "error handling"
        with patch.object(unified_tool, 'validate_path') as mock_validate:
            mock_validate.return_value = MagicMock(is_error=False)
            
            with patch.object(unified_tool, 'check_path_allowed') as mock_allowed:
                mock_allowed.return_value = (True, None)
                
                with patch.object(unified_tool, 'check_path_exists') as mock_exists:
                    mock_exists.return_value = (True, None)
                    
                    result = await unified_tool.call(
                        ctx,
                        pattern="error.handling",
                        path=str(real_test_environment["dir"]),
                        enable_vector=False,  # Disable vector search
                        max_results=20
                    )
                    
                    # Should find multiple instances of error handling
                    assert "Unified Search Results" in result
                    assert "error" in result.lower()


if __name__ == "__main__":
    # Run tests
    pytest.main([__file__, "-v"])