"""Benchmark suite for search and database storage performance."""

import asyncio
import os
import time
import tempfile
import statistics
from pathlib import Path
from typing import List, Dict, Any, Tuple
import json
import sys

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem.search_tool import SearchTool
from hanzo_mcp.tools.vector.project_manager import ProjectVectorManager
from hanzo_mcp.tools.vector.vector_index import VectorIndexTool
from hanzo_mcp.tools.vector.ast_analyzer import ASTAnalyzer


class SearchBenchmark:
    """Comprehensive benchmark suite for search performance."""
    
    def __init__(self, project_root: str):
        """Initialize benchmark with project root."""
        self.project_root = Path(project_root)
        self.permission_manager = PermissionManager()
        self.permission_manager.add_allowed_path(str(self.project_root))
        
        # Database configuration
        self.db_config = {
            "data_path": str(self.project_root / ".vector_db"),
            "embedding_model": "text-embedding-3-small",
            "dimension": 1536,
        }
        
        self.results = {}
        
    def create_test_project(self, size: str = "medium") -> Path:
        """Create a test project of specified size."""
        test_dir = self.project_root / f"test_project_{size}"
        test_dir.mkdir(exist_ok=True)
        
        # Size configurations
        sizes = {
            "small": {"files": 10, "functions_per_file": 5, "lines_per_function": 10},
            "medium": {"files": 50, "functions_per_file": 10, "lines_per_function": 20},
            "large": {"files": 100, "functions_per_file": 15, "lines_per_function": 30},
        }
        
        config = sizes.get(size, sizes["medium"])
        
        for i in range(config["files"]):
            file_path = test_dir / f"module_{i:03d}.py"
            content = self._generate_file_content(i, config)
            file_path.write_text(content)
        
        # Create LLM.md for project detection
        llm_md = test_dir / "LLM.md"
        llm_md.write_text(f"""# Test Project ({size})

This is a test project for benchmarking search performance.

## Project Structure
- {config['files']} Python modules
- {config['functions_per_file']} functions per module
- {config['lines_per_function']} lines per function

## Features
- Error handling patterns
- Data processing functions
- Utility functions
- Configuration management
""")
        
        return test_dir
    
    def _generate_file_content(self, file_idx: int, config: Dict[str, int]) -> str:
        """Generate realistic Python file content."""
        functions = []
        
        for func_idx in range(config["functions_per_file"]):
            func_name = f"process_data_{func_idx}"
            
            if func_idx % 3 == 0:
                # Error handling function
                func_content = f'''def {func_name}(data, options=None):
    """Process data with comprehensive error handling."""
    if options is None:
        options = {{}}
    
    try:
        result = []
        for item in data:
            if not item:
                raise ValueError("Empty item encountered")
            
            processed = item.strip().upper()
            result.append(processed)
        
        return result
    except ValueError as e:
        logger.error(f"Validation error in {func_name}: {{e}}")
        return []
    except Exception as e:
        logger.critical(f"Unexpected error in {func_name}: {{e}}")
        raise'''
            
            elif func_idx % 3 == 1:
                # Utility function
                func_content = f'''def {func_name}(input_data, config=None):
    """Utility function for data transformation."""
    config = config or get_default_config()
    
    transformed = []
    for item in input_data:
        # Apply transformation rules
        if config.get("uppercase", True):
            item = item.upper()
        
        if config.get("trim", True):
            item = item.strip()
        
        transformed.append(item)
    
    return transformed'''
            
            else:
                # Regular processing function
                func_content = f'''def {func_name}(dataset, parameters):
    """Standard data processing function."""
    results = []
    
    for record in dataset:
        # Validate record
        if not validate_record(record):
            continue
        
        # Process record
        processed = apply_transformations(record, parameters)
        results.append(processed)
    
    return results'''
            
            functions.append(func_content)
        
        # File header and imports
        header = f'''"""Module {file_idx:03d} - Auto-generated for benchmarking."""

import logging
import json
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

def get_default_config() -> Dict[str, Any]:
    """Get default configuration for module {file_idx:03d}."""
    return {{
        "module_id": {file_idx},
        "uppercase": True,
        "trim": True,
        "validate": True,
    }}

def validate_record(record: Any) -> bool:
    """Validate a single record."""
    try:
        return record is not None and str(record).strip() != ""
    except Exception:
        return False

def apply_transformations(record: Any, params: Dict[str, Any]) -> Any:
    """Apply transformations to a record."""
    if params.get("stringify", True):
        record = str(record)
    
    if params.get("normalize", True):
        record = record.strip().lower()
    
    return record

'''
        
        return header + "\n\n".join(functions) + "\n"

    async def benchmark_indexing(self, project_path: Path) -> Dict[str, Any]:
        """Benchmark vector database indexing performance."""
        print(f"\\n=== Benchmarking Indexing Performance ===")
        print(f"Project: {project_path}")
        
        # Initialize project manager
        project_manager = ProjectVectorManager(
            global_db_path=self.db_config["data_path"],
            embedding_model=self.db_config["embedding_model"],
            dimension=self.db_config["dimension"],
        )
        
        # Create vector index tool
        vector_tool = VectorIndexTool(self.permission_manager, project_manager)
        
        # Mock context
        class MockContext:
            def __init__(self):
                self.meta = {}
        
        start_time = time.time()
        
        # Index the project
        try:
            result = await vector_tool.call(
                MockContext(),
                path=str(project_path),
                force_reindex=True,
                chunk_size=500,
                chunk_overlap=50
            )
            
            indexing_time = time.time() - start_time
            
            # Count files and analyze storage
            python_files = list(project_path.rglob("*.py"))
            total_size = sum(f.stat().st_size for f in python_files)
            
            # Get database size if it exists
            db_path = Path(self.db_config["data_path"])
            db_size = 0
            if db_path.exists():
                for db_file in db_path.rglob("*"):
                    if db_file.is_file():
                        db_size += db_file.stat().st_size
            
            storage_ratio = db_size / total_size if total_size > 0 else 0
            
            benchmark_result = {
                "success": "Successfully indexed" in result,
                "indexing_time_seconds": indexing_time,
                "files_count": len(python_files),
                "source_size_bytes": total_size,
                "database_size_bytes": db_size,
                "storage_ratio": storage_ratio,
                "files_per_second": len(python_files) / indexing_time if indexing_time > 0 else 0,
                "mb_per_second": (total_size / 1024 / 1024) / indexing_time if indexing_time > 0 else 0,
            }
            
            print(f"Indexing completed in {indexing_time:.2f} seconds")
            print(f"Files indexed: {len(python_files)}")
            print(f"Source size: {total_size / 1024 / 1024:.2f} MB")
            print(f"Database size: {db_size / 1024 / 1024:.2f} MB")
            print(f"Storage ratio: {storage_ratio:.2f}x")
            print(f"Performance: {len(python_files) / indexing_time:.1f} files/sec, {(total_size / 1024 / 1024) / indexing_time:.1f} MB/sec")
            
            return benchmark_result
            
        except Exception as e:
            print(f"Indexing failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "indexing_time_seconds": time.time() - start_time
            }

    async def benchmark_search_performance(self, project_path: Path, queries: List[str]) -> Dict[str, Any]:
        """Benchmark search performance across different query types."""
        print(f"\\n=== Benchmarking Search Performance ===")
        
        # Initialize tools
        project_manager = ProjectVectorManager(
            global_db_path=self.db_config["data_path"],
            embedding_model=self.db_config["embedding_model"],
            dimension=self.db_config["dimension"],
        )
        
        unified_tool = SearchTool(self.permission_manager, project_manager)
        
        class MockContext:
            def __init__(self):
                self.meta = {}
        
        search_results = {}
        
        for query in queries:
            print(f"\\nTesting query: '{query}'")
            times = []
            result_counts = []
            
            # Run each query multiple times for statistical accuracy
            for run in range(3):
                start_time = time.time()
                
                try:
                    # Mock path validation methods
                    unified_tool.validate_path = lambda x: type('obj', (object,), {'is_error': False})()
                    unified_tool.check_path_allowed = lambda x, y: (True, None)
                    unified_tool.check_path_exists = lambda x, y: (True, None)
                    
                    result = await unified_tool.call(
                        MockContext(),
                        pattern=query,
                        path=str(project_path),
                        max_results=20,
                        enable_vector=True,
                        enable_ast=True,
                        enable_symbol=True,
                        include_context=True
                    )
                    
                    search_time = time.time() - start_time
                    times.append(search_time)
                    
                    # Count results
                    result_count = result.count("Result ") if "Result " in result else 0
                    result_counts.append(result_count)
                    
                except Exception as e:
                    print(f"Search failed for '{query}': {e}")
                    times.append(float('inf'))
                    result_counts.append(0)
            
            # Calculate statistics
            valid_times = [t for t in times if t != float('inf')]
            
            search_results[query] = {
                "avg_time_seconds": statistics.mean(valid_times) if valid_times else float('inf'),
                "min_time_seconds": min(valid_times) if valid_times else float('inf'),
                "max_time_seconds": max(valid_times) if valid_times else float('inf'),
                "avg_results": statistics.mean(result_counts) if result_counts else 0,
                "success_rate": len(valid_times) / len(times),
                "runs": len(times)
            }
            
            if valid_times:
                print(f"  Average time: {statistics.mean(valid_times):.3f}s")
                print(f"  Average results: {statistics.mean(result_counts):.1f}")
                print(f"  Success rate: {len(valid_times) / len(times) * 100:.1f}%")
        
        return search_results

    async def benchmark_ast_analysis(self, project_path: Path) -> Dict[str, Any]:
        """Benchmark AST analysis performance."""
        print(f"\\n=== Benchmarking AST Analysis ===")
        
        analyzer = ASTAnalyzer()
        python_files = list(project_path.rglob("*.py"))
        
        analysis_times = []
        symbol_counts = []
        
        start_time = time.time()
        
        for file_path in python_files:
            file_start = time.time()
            
            try:
                file_ast = analyzer.analyze_file(str(file_path))
                file_time = time.time() - file_start
                
                analysis_times.append(file_time)
                symbol_counts.append(len(file_ast.symbols) if file_ast else 0)
                
            except Exception as e:
                print(f"AST analysis failed for {file_path}: {e}")
                analysis_times.append(float('inf'))
                symbol_counts.append(0)
        
        total_time = time.time() - start_time
        valid_times = [t for t in analysis_times if t != float('inf')]
        
        return {
            "total_files": len(python_files),
            "successful_analyses": len(valid_times),
            "total_time_seconds": total_time,
            "avg_time_per_file": statistics.mean(valid_times) if valid_times else float('inf'),
            "total_symbols": sum(symbol_counts),
            "avg_symbols_per_file": statistics.mean(symbol_counts) if symbol_counts else 0,
            "files_per_second": len(valid_times) / total_time if total_time > 0 else 0,
        }

    async def run_comprehensive_benchmark(self) -> Dict[str, Any]:
        """Run comprehensive benchmark suite."""
        print("🚀 Starting Comprehensive Unified Search Benchmark")
        print("=" * 60)
        
        benchmark_results = {
            "timestamp": time.time(),
            "project_root": str(self.project_root),
            "database_config": self.db_config,
            "results": {}
        }
        
        # Test queries of different types
        test_queries = [
            # Exact matches
            "process_data_0",
            "get_default_config",
            
            # Regex patterns  
            "def.*error",
            ".*handling.*",
            
            # Natural language
            "error handling functionality",
            "data transformation utilities",
            
            # Code patterns
            "try.*except",
            "logger\\.error",
        ]
        
        # Benchmark different project sizes
        for size in ["small", "medium"]:  # Skip large for now
            print(f"\\n{'=' * 20} Testing {size.upper()} Project {'=' * 20}")
            
            # Create test project
            test_project = self.create_test_project(size)
            
            size_results = {}
            
            # 1. Benchmark indexing
            size_results["indexing"] = await self.benchmark_indexing(test_project)
            
            # 2. Benchmark AST analysis
            size_results["ast_analysis"] = await self.benchmark_ast_analysis(test_project)
            
            # 3. Benchmark search performance
            size_results["search_performance"] = await self.benchmark_search_performance(
                test_project, test_queries
            )
            
            benchmark_results["results"][size] = size_results
        
        return benchmark_results

    def generate_report(self, results: Dict[str, Any]) -> str:
        """Generate a comprehensive benchmark report."""
        report = []
        report.append("#  Search Benchmark Report")
        report.append(f"Generated at: {time.ctime(results['timestamp'])}")
        report.append(f"Project: {results['project_root']}")
        report.append("")
        
        for size, size_results in results["results"].items():
            report.append(f"## {size.upper()} Project Results")
            report.append("")
            
            # Indexing results
            indexing = size_results["indexing"]
            report.append("### Indexing Performance")
            if indexing["success"]:
                report.append(f"- **Indexing Time**: {indexing['indexing_time_seconds']:.2f} seconds")
                report.append(f"- **Files Indexed**: {indexing['files_count']}")
                report.append(f"- **Source Size**: {indexing['source_size_bytes'] / 1024 / 1024:.2f} MB")
                report.append(f"- **Database Size**: {indexing['database_size_bytes'] / 1024 / 1024:.2f} MB")
                report.append(f"- **Storage Ratio**: {indexing['storage_ratio']:.2f}x")
                report.append(f"- **Performance**: {indexing['files_per_second']:.1f} files/sec, {indexing['mb_per_second']:.1f} MB/sec")
            else:
                report.append(f"- **Status**: Failed - {indexing.get('error', 'Unknown error')}")
            report.append("")
            
            # AST Analysis results
            ast = size_results["ast_analysis"]
            report.append("### AST Analysis Performance")
            report.append(f"- **Total Files**: {ast['total_files']}")
            report.append(f"- **Successful Analyses**: {ast['successful_analyses']}")
            report.append(f"- **Total Time**: {ast['total_time_seconds']:.2f} seconds")
            report.append(f"- **Avg Time per File**: {ast['avg_time_per_file']:.3f} seconds")
            report.append(f"- **Total Symbols**: {ast['total_symbols']}")
            report.append(f"- **Avg Symbols per File**: {ast['avg_symbols_per_file']:.1f}")
            report.append(f"- **Files per Second**: {ast['files_per_second']:.1f}")
            report.append("")
            
            # Search Performance results
            search = size_results["search_performance"]
            report.append("### Search Performance")
            report.append("| Query | Avg Time (s) | Avg Results | Success Rate |")
            report.append("|-------|--------------|-------------|--------------|")
            
            for query, metrics in search.items():
                avg_time = metrics['avg_time_seconds']
                avg_results = metrics['avg_results']
                success_rate = metrics['success_rate'] * 100
                
                if avg_time == float('inf'):
                    time_str = "Failed"
                else:
                    time_str = f"{avg_time:.3f}"
                
                report.append(f"| `{query}` | {time_str} | {avg_results:.1f} | {success_rate:.1f}% |")
            
            report.append("")
        
        # Performance summary
        report.append("## Performance Summary")
        report.append("")
        
        for size, size_results in results["results"].items():
            indexing = size_results["indexing"]
            ast = size_results["ast_analysis"]
            
            if indexing["success"]:
                report.append(f"**{size.upper()} Project:**")
                report.append(f"- Indexed {indexing['files_count']} files in {indexing['indexing_time_seconds']:.2f}s")
                report.append(f"- Database compression: {indexing['storage_ratio']:.2f}x")
                report.append(f"- AST analysis: {ast['files_per_second']:.1f} files/sec")
                report.append("")
        
        return "\\n".join(report)


async def main():
    """Run the benchmark suite."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Benchmark search performance")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--output", help="Output file for results")
    args = parser.parse_args()
    
    # Initialize benchmark
    benchmark = SearchBenchmark(args.project_root)
    
    try:
        # Run comprehensive benchmark
        results = await benchmark.run_comprehensive_benchmark()
        
        # Generate report
        report = benchmark.generate_report(results)
        
        # Output results
        if args.output:
            with open(args.output, 'w') as f:
                f.write(report)
            print(f"\\nBenchmark report saved to: {args.output}")
        else:
            print("\\n" + "=" * 60)
            print(report)
        
        # Save raw results as JSON
        json_file = Path(args.project_root) / "benchmark_results.json"
        with open(json_file, 'w') as f:
            json.dump(results, f, indent=2)
        
        print(f"Raw results saved to: {json_file}")
        
    except Exception as e:
        print(f"Benchmark failed: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())