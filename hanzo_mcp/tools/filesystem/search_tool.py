"""Search tool that runs multiple search types in parallel.

This tool consolidates all search capabilities and runs them concurrently:
- grep: Fast pattern/regex search using ripgrep
- grep_ast: AST-aware code search with structural context
- vector_search: Semantic similarity search
- git_search: Search through git history
- symbol_search: Find symbols (functions, classes) in code

Results are combined, deduplicated, and ranked for comprehensive search coverage.
"""

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Dict, List, Optional, Set, Tuple, TypedDict, Unpack, final, override
from enum import Enum

from mcp.server.fastmcp import Context as MCPContext
from mcp.server import FastMCP
from pydantic import Field

from hanzo_mcp.tools.filesystem.base import FilesystemBaseTool
from hanzo_mcp.tools.filesystem.grep import Grep
from hanzo_mcp.tools.filesystem.symbols import SymbolsTool
from hanzo_mcp.tools.filesystem.git_search import GitSearchTool
from hanzo_mcp.tools.vector.vector_search import VectorSearchTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.vector.project_manager import ProjectVectorManager


class SearchType(Enum):
    """Types of searches that can be performed."""
    GREP = "grep"
    GREP_AST = "grep_ast"
    VECTOR = "vector"
    GIT = "git"
    SYMBOL = "symbol"  # Searches for function/class definitions


@dataclass
class SearchResult:
    """Search result from any search type."""
    file_path: str
    line_number: Optional[int]
    content: str
    search_type: SearchType
    score: float  # Relevance score (0-1)
    context: Optional[str] = None  # Function/class context
    match_count: int = 1  # Number of matches in this location


Pattern = Annotated[
    str,
    Field(
        description="The search pattern (supports regex for grep, natural language for vector search)",
        min_length=1,
    ),
]

SearchPath = Annotated[
    str,
    Field(
        description="The directory to search in. Defaults to current directory.",
        default=".",
    ),
]

Include = Annotated[
    str,
    Field(
        description='File pattern to include (e.g. "*.js", "*.{ts,tsx}")',
        default="*",
    ),
]

MaxResults = Annotated[
    int,
    Field(
        description="Maximum number of results to return",
        default=50,
    ),
]

EnableGrep = Annotated[
    bool,
    Field(
        description="Enable fast pattern/regex search",
        default=True,
    ),
]

EnableGrepAst = Annotated[
    bool,
    Field(
        description="Enable AST-aware search with code structure context",
        default=True,
    ),
]

EnableVector = Annotated[
    bool,
    Field(
        description="Enable semantic similarity search",
        default=True,
    ),
]

EnableGit = Annotated[
    bool,
    Field(
        description="Enable git history search",
        default=True,
    ),
]

EnableSymbol = Annotated[
    bool,
    Field(
        description="Enable symbol search (functions, classes)",
        default=True,
    ),
]

IncludeContext = Annotated[
    bool,
    Field(
        description="Include function/class context for matches",
        default=True,
    ),
]


class UnifiedSearchParams(TypedDict):
    """Parameters for search."""
    pattern: Pattern
    path: SearchPath
    include: Include
    max_results: MaxResults
    enable_grep: EnableGrep
    enable_grep_ast: EnableGrepAst
    enable_vector: EnableVector
    enable_git: EnableGit
    enable_symbol: EnableSymbol
    include_context: IncludeContext


@final
class SearchTool(FilesystemBaseTool):
    """Search tool that runs multiple search types in parallel."""
    
    def __init__(self, permission_manager: PermissionManager, 
                 project_manager: Optional[ProjectVectorManager] = None):
        """Initialize the search tool.
        
        Args:
            permission_manager: Permission manager for access control
            project_manager: Optional project manager for vector search
        """
        super().__init__(permission_manager)
        self.project_manager = project_manager
        
        # Initialize component tools
        self.grep_tool = Grep(permission_manager)
        self.grep_ast_tool = SymbolsTool(permission_manager)
        self.git_search_tool = GitSearchTool(permission_manager)
        
        # Vector search is optional
        self.vector_tool = None
        if project_manager:
            self.vector_tool = VectorSearchTool(permission_manager, project_manager)
    
    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "search"
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Search that runs multiple search strategies in parallel.

Automatically runs the most appropriate search types based on your pattern:
- Pattern matching (grep) for exact text/regex
- AST search for code structure understanding  
- Semantic search for concepts and meaning
- Git history for tracking changes
- Symbol search for finding definitions

All searches run concurrently for maximum speed. Results are combined,
deduplicated, and ranked by relevance.

Examples:
- Search for TODO comments: pattern="TODO"
- Find error handling: pattern="error handling implementation"
- Locate function: pattern="processPayment"
- Track changes: pattern="bug fix" (searches git history too)

This is the recommended search tool for comprehensive results."""
    
    def _analyze_pattern(self, pattern: str) -> Dict[str, bool]:
        """Analyze the pattern to determine optimal search strategies.
        
        Args:
            pattern: The search pattern
            
        Returns:
            Dictionary of search type recommendations
        """
        # Check if pattern looks like regex
        regex_chars = r'[.*+?^${}()|[\]\\]'
        has_regex = bool(re.search(regex_chars, pattern))
        
        # Check if pattern looks like a symbol name
        is_symbol = bool(re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', pattern))
        
        # Check if pattern is natural language
        words = pattern.split()
        is_natural_language = len(words) > 2 and not has_regex
        
        return {
            'use_grep': True,  # Always useful
            'use_grep_ast': not has_regex,  # AST doesn't handle regex well
            'use_vector': is_natural_language or len(pattern) > 10,
            'use_git': True,  # Always check history
            'use_symbol': is_symbol or 'def' in pattern or 'class' in pattern
        }
    
    async def _run_grep_search(self, pattern: str, path: str, include: str,
                              tool_ctx, max_results: int) -> List[SearchResult]:
        """Run grep search and parse results."""
        try:
            result = await self.grep_tool.call(
                tool_ctx.mcp_context,
                pattern=pattern,
                path=path,
                include=include
            )
            
            results = []
            if "Found" in result and "matches" in result:
                lines = result.split('\n')
                for line in lines[2:]:  # Skip header
                    if ':' in line and line.strip():
                        try:
                            parts = line.split(':', 2)
                            if len(parts) >= 3:
                                results.append(SearchResult(
                                    file_path=parts[0],
                                    line_number=int(parts[1]),
                                    content=parts[2].strip(),
                                    search_type=SearchType.GREP,
                                    score=1.0  # Exact matches get perfect score
                                ))
                                if len(results) >= max_results:
                                    break
                        except ValueError:
                            continue
            
            await tool_ctx.info(f"Grep found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"Grep search failed: {e}")
            return []
    
    async def _run_grep_ast_search(self, pattern: str, path: str,
                                  tool_ctx, max_results: int) -> List[SearchResult]:
        """Run AST-aware search and parse results."""
        try:
            result = await self.grep_ast_tool.call(
                tool_ctx.mcp_context,
                pattern=pattern,
                path=path,
                ignore_case=True,
                line_number=True
            )
            
            results = []
            if result and not result.startswith("No matches"):
                current_file = None
                current_context = []
                
                for line in result.split('\n'):
                    if line.endswith(':') and '/' in line:
                        current_file = line[:-1]
                        current_context = []
                    elif current_file and ':' in line:
                        try:
                            # Try to parse line with number
                            parts = line.split(':', 1)
                            line_num = int(parts[0].strip())
                            content = parts[1].strip() if len(parts) > 1 else ""
                            
                            results.append(SearchResult(
                                file_path=current_file,
                                line_number=line_num,
                                content=content,
                                search_type=SearchType.GREP_AST,
                                score=0.95,  # High score for AST matches
                                context=" > ".join(current_context) if current_context else None
                            ))
                            
                            if len(results) >= max_results:
                                break
                        except ValueError:
                            # This might be context info
                            if line.strip():
                                current_context.append(line.strip())
            
            await tool_ctx.info(f"AST search found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"AST search failed: {e}")
            return []
    
    async def _run_vector_search(self, pattern: str, path: str,
                                tool_ctx, max_results: int) -> List[SearchResult]:
        """Run semantic vector search."""
        if not self.vector_tool:
            return []
            
        try:
            # Determine search scope
            search_scope = "current" if path == "." else "all"
            
            result = await self.vector_tool.call(
                tool_ctx.mcp_context,
                query=pattern,
                limit=max_results,
                score_threshold=0.3,
                search_scope=search_scope,
                include_content=True
            )
            
            results = []
            if "Found" in result:
                # Parse vector search results
                lines = result.split('\n')
                current_file = None
                current_score = 0.0
                
                for line in lines:
                    if "Result" in line and "Score:" in line:
                        # Extract score and file
                        score_match = re.search(r'Score: ([\d.]+)%', line)
                        if score_match:
                            current_score = float(score_match.group(1)) / 100.0
                        
                        file_match = re.search(r' - ([^\s]+)$', line)
                        if file_match:
                            current_file = file_match.group(1)
                    
                    elif current_file and line.strip() and not line.startswith('-'):
                        # Content line
                        results.append(SearchResult(
                            file_path=current_file,
                            line_number=None,
                            content=line.strip()[:200],  # Limit content length
                            search_type=SearchType.VECTOR,
                            score=current_score
                        ))
                        
                        if len(results) >= max_results:
                            break
            
            await tool_ctx.info(f"Vector search found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"Vector search failed: {e}")
            return []
    
    async def _run_git_search(self, pattern: str, path: str,
                             tool_ctx, max_results: int) -> List[SearchResult]:
        """Run git history search."""
        try:
            # Search in both content and commits
            tasks = [
                self.git_search_tool.call(
                    tool_ctx.mcp_context,
                    pattern=pattern,
                    path=path,
                    search_type="content",
                    max_count=max_results // 2
                ),
                self.git_search_tool.call(
                    tool_ctx.mcp_context,
                    pattern=pattern,
                    path=path,
                    search_type="commits",
                    max_count=max_results // 2
                )
            ]
            
            git_results = await asyncio.gather(*tasks, return_exceptions=True)
            
            results = []
            for i, result in enumerate(git_results):
                if isinstance(result, Exception):
                    continue
                    
                if "Found" in result:
                    # Parse git results
                    lines = result.split('\n')
                    for line in lines:
                        if ':' in line and line.strip():
                            parts = line.split(':', 2)
                            if len(parts) >= 2:
                                results.append(SearchResult(
                                    file_path=parts[0].strip(),
                                    line_number=None,
                                    content=parts[-1].strip() if len(parts) > 2 else line,
                                    search_type=SearchType.GIT,
                                    score=0.8  # Good score for git matches
                                ))
                                
                                if len(results) >= max_results:
                                    break
            
            await tool_ctx.info(f"Git search found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"Git search failed: {e}")
            return []
    
    async def _run_symbol_search(self, pattern: str, path: str,
                                tool_ctx, max_results: int) -> List[SearchResult]:
        """Search for symbol definitions using grep with specific patterns."""
        try:
            # Create patterns for common symbol definitions
            symbol_patterns = [
                f"(def|class|function|func|fn)\\s+{pattern}",  # Python, JS, various
                f"(public|private|protected)?\\s*(static)?\\s*\\w+\\s+{pattern}\\s*\\(",  # Java/C++
                f"const\\s+{pattern}\\s*=",  # JS/TS const
                f"let\\s+{pattern}\\s*=",  # JS/TS let
                f"var\\s+{pattern}\\s*=",  # JS/TS var
            ]
            
            # Run grep searches in parallel for each pattern
            tasks = []
            for sp in symbol_patterns:
                tasks.append(
                    self.grep_tool.call(
                        tool_ctx.mcp_context,
                        pattern=sp,
                        path=path,
                        include="*"
                    )
                )
            
            grep_results = await asyncio.gather(*tasks, return_exceptions=True)
            
            results = []
            for result in grep_results:
                if isinstance(result, Exception):
                    continue
                    
                if "Found" in result and "matches" in result:
                    lines = result.split('\n')
                    for line in lines[2:]:  # Skip header
                        if ':' in line and line.strip():
                            try:
                                parts = line.split(':', 2)
                                if len(parts) >= 3:
                                    results.append(SearchResult(
                                        file_path=parts[0],
                                        line_number=int(parts[1]),
                                        content=parts[2].strip(),
                                        search_type=SearchType.SYMBOL,
                                        score=0.98  # Very high score for symbol definitions
                                    ))
                                    if len(results) >= max_results:
                                        break
                            except ValueError:
                                continue
            
            await tool_ctx.info(f"Symbol search found {len(results)} results")
            return results
            
        except Exception as e:
            await tool_ctx.error(f"Symbol search failed: {e}")
            return []
    
    def _deduplicate_results(self, all_results: List[SearchResult]) -> List[SearchResult]:
        """Deduplicate results, keeping the highest scoring version."""
        seen = {}
        
        for result in all_results:
            key = (result.file_path, result.line_number)
            
            if key not in seen or result.score > seen[key].score:
                seen[key] = result
            elif key in seen and result.context and not seen[key].context:
                # Add context if missing
                seen[key].context = result.context
        
        return list(seen.values())
    
    def _rank_results(self, results: List[SearchResult]) -> List[SearchResult]:
        """Rank results by relevance score and search type priority."""
        # Define search type priorities
        type_priority = {
            SearchType.SYMBOL: 5,
            SearchType.GREP: 4,
            SearchType.GREP_AST: 3,
            SearchType.GIT: 2,
            SearchType.VECTOR: 1
        }
        
        # Sort by score (descending) and then by type priority
        results.sort(
            key=lambda r: (r.score, type_priority.get(r.search_type, 0)),
            reverse=True
        )
        
        return results
    
    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[UnifiedSearchParams],
    ) -> str:
        """Execute search across all enabled search types."""
        import time
        start_time = time.time()
        
        tool_ctx = self.create_tool_context(ctx)
        
        # Extract parameters
        pattern = params["pattern"]
        path = params.get("path", ".")
        include = params.get("include", "*")
        max_results = params.get("max_results", 50)
        include_context = params.get("include_context", True)
        
        # Validate path
        path_validation = self.validate_path(path)
        if path_validation.is_error:
            await tool_ctx.error(path_validation.error_message)
            return f"Error: {path_validation.error_message}"
        
        # Check permissions
        allowed, error_msg = await self.check_path_allowed(path, tool_ctx)
        if not allowed:
            return error_msg
        
        # Check existence
        exists, error_msg = await self.check_path_exists(path, tool_ctx)
        if not exists:
            return error_msg
        
        # Analyze pattern to determine best search strategies
        pattern_analysis = self._analyze_pattern(pattern)
        
        await tool_ctx.info(f"Starting search for '{pattern}' in {path}")
        
        # Build list of search tasks based on enabled types and pattern analysis
        search_tasks = []
        search_names = []
        
        if params.get("enable_grep", True) and pattern_analysis['use_grep']:
            search_tasks.append(self._run_grep_search(pattern, path, include, tool_ctx, max_results))
            search_names.append("grep")
        
        if params.get("enable_grep_ast", True) and pattern_analysis['use_grep_ast']:
            search_tasks.append(self._run_grep_ast_search(pattern, path, tool_ctx, max_results))
            search_names.append("grep_ast")
        
        if params.get("enable_vector", True) and self.vector_tool and pattern_analysis['use_vector']:
            search_tasks.append(self._run_vector_search(pattern, path, tool_ctx, max_results))
            search_names.append("vector")
        
        if params.get("enable_git", True) and pattern_analysis['use_git']:
            search_tasks.append(self._run_git_search(pattern, path, tool_ctx, max_results))
            search_names.append("git")
        
        if params.get("enable_symbol", True) and pattern_analysis['use_symbol']:
            search_tasks.append(self._run_symbol_search(pattern, path, tool_ctx, max_results))
            search_names.append("symbol")
        
        await tool_ctx.info(f"Running {len(search_tasks)} search types in parallel: {', '.join(search_names)}")
        
        # Run all searches in parallel
        search_results = await asyncio.gather(*search_tasks, return_exceptions=True)
        
        # Collect all results
        all_results = []
        results_by_type = {}
        
        for search_type, results in zip(search_names, search_results):
            if isinstance(results, Exception):
                await tool_ctx.error(f"{search_type} search failed: {results}")
                results_by_type[search_type] = []
            else:
                results_by_type[search_type] = results
                all_results.extend(results)
        
        # Deduplicate and rank results
        unique_results = self._deduplicate_results(all_results)
        ranked_results = self._rank_results(unique_results)
        
        # Limit total results
        final_results = ranked_results[:max_results]
        
        # Calculate search time
        search_time = (time.time() - start_time) * 1000
        
        # Format output
        return self._format_results(
            pattern=pattern,
            results=final_results,
            results_by_type=results_by_type,
            search_time_ms=search_time,
            include_context=include_context
        )
    
    def _format_results(self, pattern: str, results: List[SearchResult],
                       results_by_type: Dict[str, List[SearchResult]],
                       search_time_ms: float, include_context: bool) -> str:
        """Format search results for display."""
        output = []
        
        # Header
        output.append(f"=== Unified Search Results ===")
        output.append(f"Pattern: '{pattern}'")
        output.append(f"Total results: {len(results)}")
        output.append(f"Search time: {search_time_ms:.1f}ms")
        
        # Summary by type
        output.append("\nResults by type:")
        for search_type, type_results in results_by_type.items():
            if type_results:
                output.append(f"  {search_type}: {len(type_results)} matches")
        
        if not results:
            output.append("\nNo results found.")
            return "\n".join(output)
        
        # Group results by file
        results_by_file = {}
        for result in results:
            if result.file_path not in results_by_file:
                results_by_file[result.file_path] = []
            results_by_file[result.file_path].append(result)
        
        # Display results
        output.append(f"\n=== Results ({len(results)} total) ===\n")
        
        for file_path, file_results in results_by_file.items():
            output.append(f"{file_path}")
            output.append("-" * len(file_path))
            
            # Sort by line number
            file_results.sort(key=lambda r: r.line_number or 0)
            
            for result in file_results:
                # Format result line
                score_str = f"[{result.search_type.value} {result.score:.2f}]"
                
                if result.line_number:
                    output.append(f"  {result.line_number:>4}: {score_str} {result.content}")
                else:
                    output.append(f"       {score_str} {result.content}")
                
                # Add context if available and requested
                if include_context and result.context:
                    output.append(f"         Context: {result.context}")
            
            output.append("")  # Empty line between files
        
        return "\n".join(output)
    
    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register the search tool with the MCP server."""
        tool_self = self
        
        @mcp_server.tool(name=self.name, description=self.description)
        async def search(
            ctx: MCPContext,
            pattern: Pattern,
            path: SearchPath = ".",
            include: Include = "*",
            max_results: MaxResults = 50,
            enable_grep: EnableGrep = True,
            enable_grep_ast: EnableGrepAst = True,
            enable_vector: EnableVector = True,
            enable_git: EnableGit = True,
            enable_symbol: EnableSymbol = True,
            include_context: IncludeContext = True,
        ) -> str:
            return await tool_self.call(
                ctx,
                pattern=pattern,
                path=path,
                include=include,
                max_results=max_results,
                enable_grep=enable_grep,
                enable_grep_ast=enable_grep_ast,
                enable_vector=enable_vector,
                enable_git=enable_git,
                enable_symbol=enable_symbol,
                include_context=include_context,
            )