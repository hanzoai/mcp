"""Unified search tool that combines grep, vector, AST, and semantic search.

This tool provides an intelligent multi-search approach that:
1. Always starts with fast grep/regex search 
2. Enhances with vector similarity, AST context, and symbol search
3. Returns comprehensive results with function/method context
4. Optimizes performance through intelligent caching and batching
"""

import asyncio
import json
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Any, Union
from enum import Enum

from fastmcp import Context as MCPContext
from fastmcp import FastMCP
from pydantic import Field
from typing_extensions import Annotated, TypedDict, Unpack, final, override

from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool
from hanzo_mcp.tools.filesystem.grep import Grep
from hanzo_mcp.tools.filesystem.grep_ast_tool import GrepAstTool
from hanzo_mcp.tools.vector.vector_search import VectorSearchTool
from hanzo_mcp.tools.vector.ast_analyzer import ASTAnalyzer, Symbol
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.vector.project_manager import ProjectVectorManager


class SearchType(Enum):
    """Types of searches that can be performed."""
    GREP = "grep"
    VECTOR = "vector" 
    AST = "ast"
    SYMBOL = "symbol"


@dataclass 
class SearchResult:
    """Unified search result combining different search types."""
    file_path: str
    line_number: Optional[int]
    content: str
    search_type: SearchType
    score: float  # Relevance score (0-1)
    context: Optional[str] = None  # AST/function context
    symbol_info: Optional[Symbol] = None
    project: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = asdict(self)
        result['search_type'] = self.search_type.value
        if self.symbol_info:
            result['symbol_info'] = asdict(self.symbol_info)
        return result


@dataclass
class UnifiedSearchResults:
    """Container for all unified search results."""
    query: str
    total_results: int
    results_by_type: Dict[SearchType, List[SearchResult]]
    combined_results: List[SearchResult]
    search_time_ms: float
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'query': self.query,
            'total_results': self.total_results,
            'results_by_type': {k.value: [r.to_dict() for r in v] for k, v in self.results_by_type.items()},
            'combined_results': [r.to_dict() for r in self.combined_results],
            'search_time_ms': self.search_time_ms,
        }


Pattern = Annotated[str, Field(description="The search pattern/query", min_length=1)]
SearchPath = Annotated[str, Field(description="Path to search in", default=".")]
Include = Annotated[str, Field(description="File pattern to include", default="*")]
MaxResults = Annotated[int, Field(description="Maximum results per search type", default=20)]
EnableVector = Annotated[bool, Field(description="Enable vector/semantic search", default=True)]
EnableAST = Annotated[bool, Field(description="Enable AST context search", default=True)]
EnableSymbol = Annotated[bool, Field(description="Enable symbol search", default=True)]
IncludeContext = Annotated[bool, Field(description="Include function/method context", default=True)]


class UnifiedSearchParams(TypedDict):
    """Parameters for unified search."""
    pattern: Pattern
    path: SearchPath
    include: Include
    max_results: MaxResults
    enable_vector: EnableVector
    enable_ast: EnableAST
    enable_symbol: EnableSymbol
    include_context: IncludeContext


@final
class UnifiedSearchTool(FilesystemBaseTool):
    """Unified search tool combining multiple search strategies."""
    
    def __init__(self, permission_manager: PermissionManager, 
                 project_manager: Optional[ProjectVectorManager] = None):
        """Initialize the unified search tool."""
        super().__init__(permission_manager)
        self.project_manager = project_manager
        
        # Initialize component search tools
        self.grep_tool = Grep(permission_manager)
        self.grep_ast_tool = GrepAstTool(permission_manager)
        self.ast_analyzer = ASTAnalyzer()
        
        # Vector search is optional
        self.vector_tool = None
        if project_manager:
            self.vector_tool = VectorSearchTool(permission_manager, project_manager)
        
        # Cache for AST analysis results
        self._ast_cache: Dict[str, Any] = {}
        self._symbol_cache: Dict[str, List[Symbol]] = {}
    
    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "unified_search"
    
    @property  
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Intelligent unified search combining grep, vector similarity, AST context, and symbol search.

This tool provides the most comprehensive search experience by:
1. Starting with fast grep/regex search for immediate results
2. Enhancing with vector similarity for semantic matches
3. Adding AST context to show structural information
4. Including symbol search for code definitions
5. Providing function/method body context when relevant

The tool intelligently combines results and provides relevance scoring across all search types.
Use this when you need comprehensive search results or aren't sure which search type is best."""

    def _detect_search_intent(self, pattern: str) -> Tuple[bool, bool, bool]:
        """Analyze pattern to determine which search types to enable.
        
        Returns:
            Tuple of (should_use_vector, should_use_ast, should_use_symbol)
        """
        # Default to all enabled
        use_vector = True  
        use_ast = True
        use_symbol = True
        
        # If pattern looks like regex, focus on text search
        regex_indicators = ['.*', '\\w', '\\d', '\\s', '[', ']', '(', ')', '|', '^', '$']
        if any(indicator in pattern for indicator in regex_indicators):
            use_vector = False  # Regex patterns don't work well with vector search
        
        # If pattern looks like a function/class name, prioritize symbol search
        if re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', pattern):
            use_symbol = True
            use_ast = True
        
        # If pattern contains natural language, prioritize vector search  
        words = pattern.split()
        if len(words) > 2 and not any(c in pattern for c in ['(', ')', '{', '}', '[', ']']):
            use_vector = True
            
        return use_vector, use_ast, use_symbol
    
    async def _run_grep_search(self, pattern: str, path: str, include: str, 
                              tool_ctx, max_results: int) -> List[SearchResult]:
        """Run grep search and convert results."""
        await tool_ctx.info(f"Running grep search for: {pattern}")
        
        try:
            # Use the existing grep tool
            grep_result = await self.grep_tool.call(
                tool_ctx.mcp_context,
                pattern=pattern,
                path=path, 
                include=include
            )
            
            results = []
            if "Found" in grep_result and "matches" in grep_result:
                # Parse grep results
                lines = grep_result.split('\n')
                for line in lines[2:]:  # Skip header lines
                    if ':' in line and len(line.strip()) > 0:
                        try:
                            parts = line.split(':', 2)
                            if len(parts) >= 3:
                                file_path = parts[0]
                                line_num = int(parts[1])
                                content = parts[2].strip()
                                
                                result = SearchResult(
                                    file_path=file_path,
                                    line_number=line_num,
                                    content=content,
                                    search_type=SearchType.GREP,
                                    score=1.0,  # Grep results are exact matches
                                )
                                results.append(result)
                                
                                if len(results) >= max_results:
                                    break
                        except (ValueError, IndexError):
                            continue
            
            await tool_ctx.info(f"Grep search found {len(results)} results")
            return results
                        
        except Exception as e:
            await tool_ctx.error(f"Grep search failed: {str(e)}")
            return []
    
    async def _run_vector_search(self, pattern: str, path: str, tool_ctx, 
                                max_results: int) -> List[SearchResult]:
        """Run vector search and convert results."""
        if not self.vector_tool:
            return []
            
        await tool_ctx.info(f"Running vector search for: {pattern}")
        
        try:
            # Determine search scope based on path
            if path == ".":
                search_scope = "current"
            else:
                search_scope = "all"  # Could be enhanced to detect project
            
            vector_result = await self.vector_tool.call(
                tool_ctx.mcp_context,
                query=pattern,
                limit=max_results,
                score_threshold=0.3,
                search_scope=search_scope,
                include_content=True
            )
            
            results = []
            # Parse vector search results - this would need to be enhanced
            # based on the actual format returned by vector_tool
            if "Found" in vector_result:
                # This is a simplified parser - would need to match actual format
                lines = vector_result.split('\n')
                current_file = None
                current_score = 0.0
                
                for line in lines:
                    if "Result" in line and "Score:" in line:
                        # Extract score
                        score_match = re.search(r'Score: ([\d.]+)%', line)
                        if score_match:
                            current_score = float(score_match.group(1)) / 100.0
                        
                        # Extract file path
                        if " - " in line:
                            parts = line.split(" - ")
                            if len(parts) > 1:
                                current_file = parts[-1].strip()
                    
                    elif current_file and line.strip() and not line.startswith('-'):
                        # This is content
                        result = SearchResult(
                            file_path=current_file,
                            line_number=None,
                            content=line.strip(),
                            search_type=SearchType.VECTOR,
                            score=current_score,
                        )
                        results.append(result)
                        
                        if len(results) >= max_results:
                            break
            
            await tool_ctx.info(f"Vector search found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"Vector search failed: {str(e)}")
            return []
    
    async def _run_ast_search(self, pattern: str, path: str, include: str,
                             tool_ctx, max_results: int) -> List[SearchResult]:
        """Run AST-aware search and convert results.""" 
        await tool_ctx.info(f"Running AST search for: {pattern}")
        
        try:
            ast_result = await self.grep_ast_tool.call(
                tool_ctx.mcp_context,
                pattern=pattern,
                path=path,
                ignore_case=False,
                line_number=True
            )
            
            results = []
            if ast_result and not ast_result.startswith("No matches"):
                # Parse AST results - they include structural context
                current_file = None
                context_lines = []
                
                for line in ast_result.split('\n'):
                    if line.endswith(':') and '/' in line:
                        # This is a file header
                        current_file = line[:-1]
                        context_lines = []
                    elif current_file and line.strip():
                        if ':' in line and line.strip()[0].isdigit():
                            # This looks like a line with number
                            try:
                                parts = line.split(':', 1)
                                line_num = int(parts[0].strip())
                                content = parts[1].strip() if len(parts) > 1 else ""
                                
                                result = SearchResult(
                                    file_path=current_file,
                                    line_number=line_num,
                                    content=content,
                                    search_type=SearchType.AST,
                                    score=0.9,  # High score for AST matches
                                    context='\n'.join(context_lines) if context_lines else None
                                )
                                results.append(result)
                                
                                if len(results) >= max_results:
                                    break
                                    
                            except ValueError:
                                context_lines.append(line)
                        else:
                            context_lines.append(line)
            
            await tool_ctx.info(f"AST search found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"AST search failed: {str(e)}")
            return []
    
    async def _run_symbol_search(self, pattern: str, path: str, tool_ctx,
                                max_results: int) -> List[SearchResult]:
        """Run symbol search using AST analysis."""
        await tool_ctx.info(f"Running symbol search for: {pattern}")
        
        try:
            results = []
            path_obj = Path(path)
            
            # Find files to analyze
            files_to_check = []
            if path_obj.is_file():
                files_to_check.append(str(path_obj))
            elif path_obj.is_dir():
                # Look for source files
                for ext in ['.py', '.js', '.ts', '.java', '.cpp', '.c']:
                    files_to_check.extend(path_obj.rglob(f'*{ext}'))
                files_to_check = [str(f) for f in files_to_check[:50]]  # Limit for performance
            
            # Analyze files for symbols
            for file_path in files_to_check:
                if not self.is_path_allowed(file_path):
                    continue
                    
                # Check cache first
                if file_path in self._symbol_cache:
                    symbols = self._symbol_cache[file_path]
                else:
                    # Analyze file
                    file_ast = self.ast_analyzer.analyze_file(file_path)
                    symbols = file_ast.symbols if file_ast else []
                    self._symbol_cache[file_path] = symbols
                
                # Search symbols
                for symbol in symbols:
                    if re.search(pattern, symbol.name, re.IGNORECASE):
                        result = SearchResult(
                            file_path=symbol.file_path,
                            line_number=symbol.line_start,
                            content=f"{symbol.type} {symbol.name}" + (f" - {symbol.docstring[:100]}..." if symbol.docstring else ""),
                            search_type=SearchType.SYMBOL,
                            score=0.95,  # Very high score for symbol matches
                            symbol_info=symbol,
                            context=symbol.signature
                        )
                        results.append(result)
                        
                        if len(results) >= max_results:
                            break
                
                if len(results) >= max_results:
                    break
            
            await tool_ctx.info(f"Symbol search found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"Symbol search failed: {str(e)}")
            return []
    
    async def _add_function_context(self, results: List[SearchResult], tool_ctx) -> List[SearchResult]:
        """Add function/method context to results where relevant."""
        enhanced_results = []
        
        for result in results:
            enhanced_result = result
            
            if result.line_number and not result.context:
                try:
                    # Read the file and find surrounding function
                    file_path = Path(result.file_path)
                    if file_path.exists() and self.is_path_allowed(str(file_path)):
                        
                        # Check if we have AST analysis cached
                        if str(file_path) not in self._ast_cache:
                            file_ast = self.ast_analyzer.analyze_file(str(file_path))
                            self._ast_cache[str(file_path)] = file_ast
                        else:
                            file_ast = self._ast_cache[str(file_path)]
                        
                        if file_ast:
                            # Find symbol containing this line
                            for symbol in file_ast.symbols:
                                if (symbol.line_start <= result.line_number <= symbol.line_end and
                                    symbol.type in ['function', 'method']):
                                    enhanced_result = SearchResult(
                                        file_path=result.file_path,
                                        line_number=result.line_number,
                                        content=result.content,
                                        search_type=result.search_type,
                                        score=result.score,
                                        context=f"In {symbol.type} {symbol.name}(): {symbol.signature or ''}",
                                        symbol_info=symbol,
                                        project=result.project
                                    )
                                    break
                except Exception as e:
                    await tool_ctx.warning(f"Could not add context for {result.file_path}: {str(e)}")
            
            enhanced_results.append(enhanced_result)
        
        return enhanced_results
    
    def _combine_and_rank_results(self, results_by_type: Dict[SearchType, List[SearchResult]]) -> List[SearchResult]:
        """Combine results from different search types and rank by relevance."""
        all_results = []
        seen_combinations = set()
        
        # Combine all results, avoiding duplicates
        for search_type, results in results_by_type.items():
            for result in results:
                # Create a key to identify duplicates
                key = (result.file_path, result.line_number)
                
                if key not in seen_combinations:
                    seen_combinations.add(key)
                    all_results.append(result)
                else:
                    # Merge with existing result based on score and type priority
                    type_priority = {
                        SearchType.SYMBOL: 4,
                        SearchType.GREP: 3, 
                        SearchType.AST: 2,
                        SearchType.VECTOR: 1
                    }
                    
                    for existing in all_results:
                        existing_key = (existing.file_path, existing.line_number)
                        if existing_key == key:
                            # Update if the new result has higher priority or better score
                            result_priority = type_priority[result.search_type]
                            existing_priority = type_priority[existing.search_type]
                            
                            # Replace existing if: higher priority type, or same priority but higher score
                            if (result_priority > existing_priority or 
                                (result_priority == existing_priority and result.score > existing.score)):
                                # Replace the entire result to preserve type
                                idx = all_results.index(existing)
                                all_results[idx] = result
                            else:
                                # Still merge useful information
                                existing.context = existing.context or result.context
                                existing.symbol_info = existing.symbol_info or result.symbol_info
                            break
        
        # Sort by score (descending) then by search type priority
        type_priority = {
            SearchType.SYMBOL: 4,
            SearchType.GREP: 3, 
            SearchType.AST: 2,
            SearchType.VECTOR: 1
        }
        
        all_results.sort(key=lambda r: (r.score, type_priority[r.search_type]), reverse=True)
        
        return all_results
    
    @override
    async def call(self, ctx: MCPContext, **params: Unpack[UnifiedSearchParams]) -> str:
        """Execute unified search with all enabled search types."""
        import time
        start_time = time.time()
        
        tool_ctx = self.create_tool_context(ctx)
        
        # Extract parameters
        pattern = params["pattern"]
        path = params.get("path", ".")
        include = params.get("include", "*")
        max_results = params.get("max_results", 20)
        enable_vector = params.get("enable_vector", True)
        enable_ast = params.get("enable_ast", True) 
        enable_symbol = params.get("enable_symbol", True)
        include_context = params.get("include_context", True)
        
        # Validate path
        path_validation = self.validate_path(path)
        if path_validation.is_error:
            await tool_ctx.error(path_validation.error_message)
            return f"Error: {path_validation.error_message}"
        
        # Check path permissions and existence
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg
            
        exists, error_msg = await self.check_path_exists(path, tool_ctx)
        if not exists:
            return error_msg
        
        # Analyze search intent to optimize which searches to run
        should_vector, should_ast, should_symbol = self._detect_search_intent(pattern)
        enable_vector = enable_vector and should_vector
        enable_ast = enable_ast and should_ast
        enable_symbol = enable_symbol and should_symbol
        
        await tool_ctx.info(f"Starting unified search for '{pattern}' in {path}")
        await tool_ctx.info(f"Enabled searches: grep=True vector={enable_vector} ast={enable_ast} symbol={enable_symbol}")
        
        # Run searches in parallel for maximum efficiency
        search_tasks = []
        
        # Always run grep first (fastest, most reliable)
        search_tasks.append(
            self._run_grep_search(pattern, path, include, tool_ctx, max_results)
        )
        
        if enable_vector and self.vector_tool:
            search_tasks.append(
                self._run_vector_search(pattern, path, tool_ctx, max_results)
            )
        
        if enable_ast:
            search_tasks.append(
                self._run_ast_search(pattern, path, include, tool_ctx, max_results)
            )
        
        if enable_symbol:
            search_tasks.append(
                self._run_symbol_search(pattern, path, tool_ctx, max_results)
            )
        
        # Execute all searches in parallel
        search_results = await asyncio.gather(*search_tasks, return_exceptions=True)
        
        # Organize results by type
        results_by_type = {}
        search_types = [SearchType.GREP]
        if enable_vector and self.vector_tool:
            search_types.append(SearchType.VECTOR)
        if enable_ast:
            search_types.append(SearchType.AST)
        if enable_symbol:
            search_types.append(SearchType.SYMBOL)
        
        for i, result in enumerate(search_results):
            if isinstance(result, Exception):
                await tool_ctx.error(f"Search failed: {str(result)}")
                continue
            
            search_type = search_types[i]
            results_by_type[search_type] = result
        
        # Add function context if requested
        if include_context:
            for search_type, results in results_by_type.items():
                if results:
                    results_by_type[search_type] = await self._add_function_context(results, tool_ctx)
        
        # Combine and rank all results
        combined_results = self._combine_and_rank_results(results_by_type)
        
        end_time = time.time()
        search_time_ms = (end_time - start_time) * 1000
        
        # Create unified results object
        unified_results = UnifiedSearchResults(
            query=pattern,
            total_results=len(combined_results),
            results_by_type=results_by_type,
            combined_results=combined_results[:max_results * 2],  # Allow some extra for variety
            search_time_ms=search_time_ms
        )
        
        # Format output
        return self._format_unified_results(unified_results)
    
    def _format_unified_results(self, results: UnifiedSearchResults) -> str:
        """Format unified search results for display."""
        if results.total_results == 0:
            return f"No results found for query: '{results.query}'"
        
        lines = [
            f"Unified Search Results for '{results.query}' ({results.search_time_ms:.1f}ms)",
            f"Found {results.total_results} total results across {len(results.results_by_type)} search types",
            ""
        ]
        
        # Show summary by type
        for search_type, type_results in results.results_by_type.items():
            if type_results:
                lines.append(f"• {search_type.value.title()}: {len(type_results)} results")
        lines.append("")
        
        # Show top combined results
        lines.append("=== Top Results (Combined & Ranked) ===")
        for i, result in enumerate(results.combined_results[:20], 1):
            score_display = f"{result.score:.2f}" if result.score < 1.0 else "1.00"
            
            header = f"Result {i} [{result.search_type.value}] (Score: {score_display})"
            if result.line_number:
                header += f" - {result.file_path}:{result.line_number}"
            else:
                header += f" - {result.file_path}"
            
            lines.append(header)
            lines.append("-" * len(header))
            
            if result.context:
                lines.append(f"Context: {result.context}")
            
            lines.append(f"Content: {result.content}")
            
            if result.symbol_info:
                lines.append(f"Symbol: {result.symbol_info.type} {result.symbol_info.name}")
                if result.symbol_info.signature:
                    lines.append(f"Signature: {result.symbol_info.signature}")
            
            lines.append("")
        
        return "\n".join(lines)
    
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register the unified search tool with the MCP server."""
        tool_self = self
        
        @mcp_server.tool(name=self.name, description=self.description)
        async def unified_search(
            ctx: MCPContext,
            pattern: Pattern,
            path: SearchPath = ".",
            include: Include = "*",
            max_results: MaxResults = 20,
            enable_vector: EnableVector = True,
            enable_ast: EnableAST = True,  
            enable_symbol: EnableSymbol = True,
            include_context: IncludeContext = True,
        ) -> str:
            return await tool_self.call(
                ctx,
                pattern=pattern,
                path=path,
                include=include,
                max_results=max_results,
                enable_vector=enable_vector,
                enable_ast=enable_ast,
                enable_symbol=enable_symbol,
                include_context=include_context,
            )