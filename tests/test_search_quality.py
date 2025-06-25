"""Test search result quality and relevance scoring for unified search."""

import asyncio
import tempfile
from pathlib import Path
from typing import List, Dict, Any
import pytest

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem.unified_search import UnifiedSearchTool, SearchResult, SearchType
from hanzo_mcp.tools.vector.ast_analyzer import ASTAnalyzer, Symbol


class TestSearchQuality:
    """Test suite for search result quality and relevance."""
    
    @pytest.fixture
    def test_codebase(self):
        """Create a realistic test codebase."""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_dir = Path(tmpdir)
            
            # Create a realistic Python project
            
            # Main application file
            main_py = test_dir / "main.py"
            main_py.write_text('''
"""Main application with error handling."""

import logging
from typing import List, Optional
from data_processor import DataProcessor

logger = logging.getLogger(__name__)

class ApplicationError(Exception):
    """Custom application error."""
    pass

def main():
    """Main function with comprehensive error handling."""
    try:
        processor = DataProcessor()
        data = ["item1", "item2", "item3"]
        
        results = processor.process_data(data)
        logger.info(f"Processed {len(results)} items successfully")
        
        return results
    except ApplicationError as e:
        logger.error(f"Application error: {e}")
        return []
    except Exception as e:
        logger.critical(f"Unexpected error in main: {e}")
        raise

def validate_input(data: List[str]) -> bool:
    """Validate input data with error handling."""
    try:
        return all(isinstance(item, str) and item.strip() for item in data)
    except (TypeError, AttributeError):
        return False

if __name__ == "__main__":
    main()
''')
            
            # Data processor module
            processor_py = test_dir / "data_processor.py"
            processor_py.write_text('''
"""Data processing module with error handling."""

import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

class DataProcessor:
    """Process data with comprehensive error handling."""
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """Initialize processor with configuration."""
        self.config = config or {}
        logger.info("DataProcessor initialized")
    
    def process_data(self, items: List[str]) -> List[str]:
        """Process a list of items with error handling."""
        processed = []
        
        for item in items:
            try:
                result = self._process_single_item(item)
                processed.append(result)
            except ValueError as e:
                logger.error(f"Error processing item {item}: {e}")
                continue
            except Exception as e:
                logger.critical(f"Unexpected processing error: {e}")
                raise
        
        return processed
    
    def _process_single_item(self, item: str) -> str:
        """Process a single item with validation."""
        if not item or not item.strip():
            raise ValueError("Empty or whitespace-only item")
        
        # Transform the item
        return item.upper().strip()
    
    def batch_process(self, data_batches: List[List[str]]) -> Dict[str, List[str]]:
        """Process multiple batches of data."""
        results = {}
        
        for i, batch in enumerate(data_batches):
            batch_key = f"batch_{i}"
            try:
                batch_results = self.process_data(batch)
                results[batch_key] = batch_results
            except Exception as e:
                logger.error(f"Error processing {batch_key}: {e}")
                results[batch_key] = []
        
        return results
''')
            
            # Utility module
            utils_py = test_dir / "utils.py"
            utils_py.write_text('''
"""Utility functions with error handling."""

import re
from typing import Union, Optional, List

def validate_email(email: str) -> bool:
    """Validate email address with error handling."""
    try:
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
        return bool(re.match(pattern, email))
    except (TypeError, re.error):
        return False

def safe_divide(a: Union[int, float], b: Union[int, float]) -> Optional[float]:
    """Safely divide two numbers with error handling."""
    try:
        if b == 0:
            raise ValueError("Division by zero")
        return float(a) / float(b)
    except (TypeError, ValueError) as e:
        print(f"Division error: {e}")
        return None

def format_error_message(error: Exception, context: str = "") -> str:
    """Format error messages consistently."""
    error_type = type(error).__name__
    error_msg = str(error)
    
    if context:
        return f"[{context}] {error_type}: {error_msg}"
    else:
        return f"{error_type}: {error_msg}"

def extract_function_names(code: str) -> List[str]:
    """Extract function names from Python code."""
    try:
        pattern = r'def\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\('
        matches = re.findall(pattern, code)
        return matches
    except re.error:
        return []

class ErrorHandler:
    """Centralized error handling class."""
    
    def __init__(self, log_errors: bool = True):
        self.log_errors = log_errors
        self.error_count = 0
    
    def handle_error(self, error: Exception, context: str = "") -> str:
        """Handle an error and return formatted message."""
        self.error_count += 1
        message = format_error_message(error, context)
        
        if self.log_errors:
            print(f"Error #{self.error_count}: {message}")
        
        return message
''')
            
            # Test file
            test_py = test_dir / "test_main.py"
            test_py.write_text('''
"""Test file for the main application."""

import unittest
from unittest.mock import patch, MagicMock
from main import main, validate_input, ApplicationError
from data_processor import DataProcessor

class TestMain(unittest.TestCase):
    """Test cases for main application."""
    
    def test_main_success(self):
        """Test successful main execution."""
        with patch('main.DataProcessor') as mock_processor:
            mock_instance = MagicMock()
            mock_instance.process_data.return_value = ["ITEM1", "ITEM2", "ITEM3"]
            mock_processor.return_value = mock_instance
            
            result = main()
            self.assertEqual(result, ["ITEM1", "ITEM2", "ITEM3"])
    
    def test_main_application_error(self):
        """Test main with application error."""
        with patch('main.DataProcessor') as mock_processor:
            mock_instance = MagicMock()
            mock_instance.process_data.side_effect = ApplicationError("Test error")
            mock_processor.return_value = mock_instance
            
            result = main()
            self.assertEqual(result, [])
    
    def test_validate_input_valid(self):
        """Test input validation with valid data."""
        data = ["item1", "item2", "item3"]
        self.assertTrue(validate_input(data))
    
    def test_validate_input_invalid(self):
        """Test input validation with invalid data."""
        self.assertFalse(validate_input(["", "item2"]))
        self.assertFalse(validate_input([None, "item2"]))
        self.assertFalse(validate_input("not a list"))

class TestDataProcessor(unittest.TestCase):
    """Test cases for data processor."""
    
    def setUp(self):
        """Set up test processor."""
        self.processor = DataProcessor()
    
    def test_process_data_success(self):
        """Test successful data processing."""
        data = ["item1", "item2", "item3"]
        result = self.processor.process_data(data)
        expected = ["ITEM1", "ITEM2", "ITEM3"]
        self.assertEqual(result, expected)
    
    def test_process_data_with_empty_items(self):
        """Test processing with empty items."""
        data = ["item1", "", "item3"]
        result = self.processor.process_data(data)
        # Empty item should be skipped
        expected = ["ITEM1", "ITEM3"]
        self.assertEqual(result, expected)

if __name__ == "__main__":
    unittest.main()
''')
            
            yield {
                "dir": test_dir,
                "main": main_py,
                "processor": processor_py,
                "utils": utils_py,
                "test": test_py
            }

    def test_search_relevance_scoring(self, test_codebase):
        """Test that search results are properly scored for relevance."""
        
        # Test different search scenarios and expected relevance order
        test_cases = [
            {
                "query": "error handling",
                "expected_files": ["main.py", "data_processor.py", "utils.py"],
                "description": "Natural language query should find relevant files"
            },
            {
                "query": "DataProcessor",
                "expected_files": ["data_processor.py", "main.py", "test_main.py"],
                "description": "Class name should prioritize definition file"
            },
            {
                "query": "def process_data",
                "expected_files": ["data_processor.py"],
                "description": "Function definition should find exact matches"
            },
            {
                "query": "ApplicationError",
                "expected_files": ["main.py", "test_main.py"],
                "description": "Custom exception should find definition and usage"
            }
        ]
        
        permission_manager = PermissionManager()
        permission_manager.add_allowed_path(str(test_codebase["dir"]))
        
        # Test with different search types
        search_tools = {
            "grep": lambda: self._test_grep_relevance(test_codebase, test_cases, permission_manager),
            "ast": lambda: self._test_ast_relevance(test_codebase, test_cases, permission_manager),
            "symbol": lambda: self._test_symbol_relevance(test_codebase, test_cases, permission_manager),
        }
        
        results = {}
        for tool_name, test_func in search_tools.items():
            print(f"\\n=== Testing {tool_name.upper()} Search Relevance ===")
            results[tool_name] = test_func()
        
        return results

    def _test_grep_relevance(self, test_codebase, test_cases, permission_manager):
        """Test grep search relevance."""
        from hanzo_mcp.tools.filesystem.grep import Grep
        
        grep_tool = Grep(permission_manager)
        results = {}
        
        class MockContext:
            def __init__(self):
                self.meta = {}
        
        for case in test_cases:
            query = case["query"]
            expected_files = case["expected_files"]
            
            try:
                # Use asyncio.run for individual calls
                result = asyncio.run(grep_tool.call(
                    MockContext(),
                    pattern=query,
                    path=str(test_codebase["dir"]),
                    include="*.py"
                ))
                
                # Extract found files
                found_files = set()
                if "Found" in result:
                    lines = result.split('\\n')
                    for line in lines:
                        if ':' in line and line.strip():
                            try:
                                file_path = line.split(':')[0]
                                if file_path:
                                    found_files.add(Path(file_path).name)
                            except:
                                continue
                
                # Calculate relevance score
                expected_set = set(expected_files)
                precision = len(found_files & expected_set) / len(found_files) if found_files else 0
                recall = len(found_files & expected_set) / len(expected_set) if expected_set else 0
                f1_score = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
                
                results[query] = {
                    "found_files": list(found_files),
                    "expected_files": expected_files,
                    "precision": precision,
                    "recall": recall,
                    "f1_score": f1_score,
                    "success": True
                }
                
                print(f"Query: '{query}'")
                print(f"  Found: {sorted(found_files)}")
                print(f"  Expected: {expected_files}")
                print(f"  F1 Score: {f1_score:.3f}")
                
            except Exception as e:
                results[query] = {"success": False, "error": str(e)}
                print(f"Query: '{query}' - FAILED: {e}")
        
        return results

    def _test_ast_relevance(self, test_codebase, test_cases, permission_manager):
        """Test AST search relevance."""
        from hanzo_mcp.tools.filesystem.grep_ast_tool import GrepAstTool
        
        ast_tool = GrepAstTool(permission_manager)
        results = {}
        
        class MockContext:
            def __init__(self):
                self.meta = {}
        
        for case in test_cases:
            query = case["query"]
            expected_files = case["expected_files"]
            
            try:
                result = asyncio.run(ast_tool.call(
                    MockContext(),
                    pattern=query,
                    path=str(test_codebase["dir"]),
                    ignore_case=False,
                    line_number=True
                ))
                
                # Extract found files from AST results
                found_files = set()
                if result and not result.startswith("No matches"):
                    lines = result.split('\\n')
                    for line in lines:
                        if line.endswith(':') and '/' in line:
                            file_path = line[:-1]
                            found_files.add(Path(file_path).name)
                
                # Calculate relevance metrics
                expected_set = set(expected_files)
                precision = len(found_files & expected_set) / len(found_files) if found_files else 0
                recall = len(found_files & expected_set) / len(expected_set) if expected_set else 0
                f1_score = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
                
                results[query] = {
                    "found_files": list(found_files),
                    "expected_files": expected_files,
                    "precision": precision,
                    "recall": recall,
                    "f1_score": f1_score,
                    "success": True
                }
                
                print(f"Query: '{query}'")
                print(f"  Found: {sorted(found_files)}")
                print(f"  Expected: {expected_files}")
                print(f"  F1 Score: {f1_score:.3f}")
                
            except Exception as e:
                results[query] = {"success": False, "error": str(e)}
                print(f"Query: '{query}' - FAILED: {e}")
        
        return results

    def _test_symbol_relevance(self, test_codebase, test_cases, permission_manager):
        """Test symbol search relevance."""
        analyzer = ASTAnalyzer()
        results = {}
        
        # Analyze all files first
        file_symbols = {}
        for file_path in test_codebase["dir"].rglob("*.py"):
            try:
                file_ast = analyzer.analyze_file(str(file_path))
                if file_ast:
                    file_symbols[file_path.name] = file_ast.symbols
            except Exception as e:
                print(f"Failed to analyze {file_path}: {e}")
        
        for case in test_cases:
            query = case["query"]
            expected_files = case["expected_files"]
            
            try:
                # Search for symbols matching the query
                found_files = set()
                
                for file_name, symbols in file_symbols.items():
                    for symbol in symbols:
                        if query.lower() in symbol.name.lower():
                            found_files.add(file_name)
                            break
                
                # Calculate relevance metrics
                expected_set = set(expected_files)
                precision = len(found_files & expected_set) / len(found_files) if found_files else 0
                recall = len(found_files & expected_set) / len(expected_set) if expected_set else 0
                f1_score = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
                
                results[query] = {
                    "found_files": list(found_files),
                    "expected_files": expected_files,
                    "precision": precision,
                    "recall": recall,
                    "f1_score": f1_score,
                    "success": True
                }
                
                print(f"Query: '{query}'")
                print(f"  Found: {sorted(found_files)}")
                print(f"  Expected: {expected_files}")
                print(f"  F1 Score: {f1_score:.3f}")
                
            except Exception as e:
                results[query] = {"success": False, "error": str(e)}
                print(f"Query: '{query}' - FAILED: {e}")
        
        return results

    def test_search_performance_comparison(self, test_codebase):
        """Compare performance across different search methods."""
        import time
        
        permission_manager = PermissionManager()
        permission_manager.add_allowed_path(str(test_codebase["dir"]))
        
        queries = ["error", "DataProcessor", "def.*process", "import.*typing"]
        
        from hanzo_mcp.tools.filesystem.grep import Grep
        from hanzo_mcp.tools.filesystem.grep_ast_tool import GrepAstTool
        
        grep_tool = Grep(permission_manager)
        ast_tool = GrepAstTool(permission_manager)
        
        class MockContext:
            def __init__(self):
                self.meta = {}
        
        performance_results = {}
        
        for query in queries:
            query_results = {}
            
            # Test grep performance
            start_time = time.time()
            try:
                result = asyncio.run(grep_tool.call(
                    MockContext(),
                    pattern=query,
                    path=str(test_codebase["dir"]),
                    include="*.py"
                ))
                grep_time = time.time() - start_time
                grep_matches = result.count('\\n') if result and "Found" in result else 0
                
                query_results["grep"] = {
                    "time": grep_time,
                    "matches": grep_matches,
                    "success": True
                }
            except Exception as e:
                query_results["grep"] = {
                    "time": time.time() - start_time,
                    "matches": 0,
                    "success": False,
                    "error": str(e)
                }
            
            # Test AST performance
            start_time = time.time()
            try:
                result = asyncio.run(ast_tool.call(
                    MockContext(),
                    pattern=query,
                    path=str(test_codebase["dir"]),
                    ignore_case=False,
                    line_number=True
                ))
                ast_time = time.time() - start_time
                ast_matches = result.count('\\n') if result and not result.startswith("No matches") else 0
                
                query_results["ast"] = {
                    "time": ast_time,
                    "matches": ast_matches,
                    "success": True
                }
            except Exception as e:
                query_results["ast"] = {
                    "time": time.time() - start_time,
                    "matches": 0,
                    "success": False,
                    "error": str(e)
                }
            
            performance_results[query] = query_results
        
        # Print performance comparison
        print("\\n=== Performance Comparison ===")
        print(f"{'Query':<20} {'Grep Time':<12} {'AST Time':<12} {'Speedup':<10}")
        print("-" * 60)
        
        for query, results in performance_results.items():
            grep_time = results["grep"]["time"]
            ast_time = results["ast"]["time"]
            speedup = ast_time / grep_time if grep_time > 0 else float('inf')
            
            print(f"{query:<20} {grep_time:<12.3f} {ast_time:<12.3f} {speedup:<10.1f}x")
        
        return performance_results


if __name__ == "__main__":
    # Run the search quality tests
    tester = TestSearchQuality()
    
    # Create test codebase
    test_codebase_gen = tester.create_test_codebase()
    test_codebase = next(test_codebase_gen)
    
    try:
        print("🎯 Search Quality and Relevance Testing")
        print("=" * 50)
        
        # Test search relevance
        relevance_results = tester.test_search_relevance_scoring(test_codebase)
        
        # Test performance comparison
        print("\\n" + "=" * 50)
        performance_results = tester.test_search_performance_comparison(test_codebase)
        
        print("\\n✅ Search quality testing completed!")
        
    finally:
        # Cleanup handled by context manager
        pass