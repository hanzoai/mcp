"""Git search tool for searching through git history."""

import os
import subprocess
import re
from typing import Annotated, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager


Pattern = Annotated[
    str,
    Field(
        description="Search pattern (regex supported)",
        min_length=1,
    ),
]

SearchPath = Annotated[
    str | None,
    Field(
        description="Path to search in (defaults to current directory)",
        default=None,
    ),
]

SearchType = Annotated[
    str,
    Field(
        description="Type of git search: 'commits', 'content', 'diff', 'log', 'blame'",
        default="content",
    ),
]

CaseSensitive = Annotated[
    bool,
    Field(
        description="Case sensitive search",
        default=False,
    ),
]

MaxCount = Annotated[
    int,
    Field(
        description="Maximum number of results",
        default=100,
    ),
]

Branch = Annotated[
    str | None,
    Field(
        description="Branch to search (defaults to current branch)",
        default=None,
    ),
]

Author = Annotated[
    str | None,
    Field(
        description="Filter by author (for commits/log)",
        default=None,
    ),
]

Since = Annotated[
    str | None,
    Field(
        description="Search commits since date (e.g., '2 weeks ago', '2024-01-01')",
        default=None,
    ),
]

Until = Annotated[
    str | None,
    Field(
        description="Search commits until date",
        default=None,
    ),
]

FilePattern = Annotated[
    str | None,
    Field(
        description="Limit search to files matching pattern",
        default=None,
    ),
]


class GitSearchParams(TypedDict, total=False):
    """Parameters for git search tool."""

    pattern: str
    path: str | None
    search_type: str
    case_sensitive: bool
    max_count: int
    branch: str | None
    author: str | None
    since: str | None
    until: str | None
    file_pattern: str | None


@final
class GitSearchTool(BaseTool):
    """Tool for searching through git history efficiently."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the git search tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "git_search"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Search through git history using native git commands.

Supports multiple search types:
- 'content': Search file contents in history (git grep)
- 'commits': Search commit messages (git log --grep)
- 'diff': Search changes/patches (git log -G)
- 'log': Search commit logs with filters
- 'blame': Find who changed lines matching pattern

Features:
- Regex pattern support
- Case sensitive/insensitive search
- Filter by author, date range, branch
- Limit to specific file patterns
- Efficient native git performance

Examples:
- Search for "TODO" in all history: pattern="TODO", search_type="content"
- Find commits mentioning "fix": pattern="fix", search_type="commits"
- Find when function was added: pattern="def my_func", search_type="diff"
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[GitSearchParams],
    ) -> str:
        """Execute git search.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Search results
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        pattern = params.get("pattern")
        if not pattern:
            return "Error: pattern is required"

        path = params.get("path", os.getcwd())
        search_type = params.get("search_type", "content")
        case_sensitive = params.get("case_sensitive", False)
        max_count = params.get("max_count", 100)
        branch = params.get("branch")
        author = params.get("author")
        since = params.get("since")
        until = params.get("until")
        file_pattern = params.get("file_pattern")

        # Resolve absolute path
        abs_path = os.path.abspath(path)
        
        # Check permissions
        if not self.permission_manager.has_permission(abs_path):
            return f"Permission denied: {abs_path}"

        # Check if it's a git repository
        if not os.path.exists(os.path.join(abs_path, ".git")):
            # Try to find parent git directory
            parent = abs_path
            while parent != os.path.dirname(parent):
                parent = os.path.dirname(parent)
                if os.path.exists(os.path.join(parent, ".git")):
                    abs_path = parent
                    break
            else:
                return f"Not a git repository: {path}"

        await tool_ctx.info(f"Searching git history in {abs_path}")

        try:
            if search_type == "content":
                return await self._search_content(
                    abs_path, pattern, case_sensitive, max_count, 
                    branch, file_pattern, tool_ctx
                )
            elif search_type == "commits":
                return await self._search_commits(
                    abs_path, pattern, case_sensitive, max_count,
                    branch, author, since, until, file_pattern, tool_ctx
                )
            elif search_type == "diff":
                return await self._search_diff(
                    abs_path, pattern, case_sensitive, max_count,
                    branch, author, since, until, file_pattern, tool_ctx
                )
            elif search_type == "log":
                return await self._search_log(
                    abs_path, pattern, max_count, branch, 
                    author, since, until, file_pattern, tool_ctx
                )
            elif search_type == "blame":
                return await self._search_blame(
                    abs_path, pattern, case_sensitive, file_pattern, tool_ctx
                )
            else:
                return f"Unknown search type: {search_type}"

        except subprocess.CalledProcessError as e:
            await tool_ctx.error(f"Git command failed: {e}")
            return f"Git search failed: {e.stderr if e.stderr else str(e)}"
        except Exception as e:
            await tool_ctx.error(f"Search failed: {e}")
            return f"Error: {str(e)}"

    async def _search_content(
        self, repo_path: str, pattern: str, case_sensitive: bool,
        max_count: int, branch: str | None, file_pattern: str | None,
        tool_ctx
    ) -> str:
        """Search file contents in git history."""
        cmd = ["git", "grep", "-n", f"--max-count={max_count}"]
        
        if not case_sensitive:
            cmd.append("-i")
        
        if branch:
            cmd.append(branch)
        else:
            cmd.append("--all")  # Search all branches
        
        cmd.append(pattern)
        
        if file_pattern:
            cmd.extend(["--", file_pattern])
        
        result = subprocess.run(
            cmd, cwd=repo_path, capture_output=True, text=True
        )
        
        if result.returncode == 0:
            lines = result.stdout.strip().split('\n')
            if lines and lines[0]:
                await tool_ctx.info(f"Found {len(lines)} matches")
                return self._format_grep_results(lines, pattern)
            else:
                return f"No matches found for pattern: {pattern}"
        elif result.returncode == 1:
            return f"No matches found for pattern: {pattern}"
        else:
            raise subprocess.CalledProcessError(
                result.returncode, cmd, result.stdout, result.stderr
            )

    async def _search_commits(
        self, repo_path: str, pattern: str, case_sensitive: bool,
        max_count: int, branch: str | None, author: str | None,
        since: str | None, until: str | None, file_pattern: str | None,
        tool_ctx
    ) -> str:
        """Search commit messages."""
        cmd = ["git", "log", f"--max-count={max_count}", "--oneline"]
        
        grep_flag = "--grep" if case_sensitive else "--grep-ignore-case"
        cmd.extend([grep_flag, pattern])
        
        if branch:
            cmd.append(branch)
        else:
            cmd.append("--all")
        
        if author:
            cmd.extend(["--author", author])
        
        if since:
            cmd.extend(["--since", since])
        
        if until:
            cmd.extend(["--until", until])
        
        if file_pattern:
            cmd.extend(["--", file_pattern])
        
        result = subprocess.run(
            cmd, cwd=repo_path, capture_output=True, text=True
        )
        
        if result.returncode == 0:
            lines = result.stdout.strip().split('\n')
            if lines and lines[0]:
                await tool_ctx.info(f"Found {len(lines)} commits")
                return f"Found {len(lines)} commits matching '{pattern}':\n\n" + result.stdout
            else:
                return f"No commits found matching: {pattern}"
        else:
            raise subprocess.CalledProcessError(
                result.returncode, cmd, result.stdout, result.stderr
            )

    async def _search_diff(
        self, repo_path: str, pattern: str, case_sensitive: bool,
        max_count: int, branch: str | None, author: str | None,
        since: str | None, until: str | None, file_pattern: str | None,
        tool_ctx
    ) -> str:
        """Search for pattern in diffs (when code was added/removed)."""
        cmd = ["git", "log", f"--max-count={max_count}", "-p"]
        
        # Use -G for diff search (shows commits that added/removed pattern)
        search_flag = f"-G{pattern}"
        if not case_sensitive:
            # For case-insensitive, we need to use -G with regex
            import re
            case_insensitive_pattern = "".join(
                f"[{c.upper()}{c.lower()}]" if c.isalpha() else re.escape(c)
                for c in pattern
            )
            search_flag = f"-G{case_insensitive_pattern}"
        
        cmd.append(search_flag)
        
        if branch:
            cmd.append(branch)
        else:
            cmd.append("--all")
        
        if author:
            cmd.extend(["--author", author])
        
        if since:
            cmd.extend(["--since", since])
        
        if until:
            cmd.extend(["--until", until])
        
        if file_pattern:
            cmd.extend(["--", file_pattern])
        
        result = subprocess.run(
            cmd, cwd=repo_path, capture_output=True, text=True
        )
        
        if result.returncode == 0 and result.stdout.strip():
            # Parse and highlight matching lines
            output = self._highlight_diff_matches(result.stdout, pattern, case_sensitive)
            matches = output.count("commit ")
            await tool_ctx.info(f"Found {matches} commits with changes")
            return f"Found {matches} commits with changes matching '{pattern}':\n\n{output}"
        else:
            return f"No changes found matching: {pattern}"

    async def _search_log(
        self, repo_path: str, pattern: str | None, max_count: int,
        branch: str | None, author: str | None, since: str | None,
        until: str | None, file_pattern: str | None, tool_ctx
    ) -> str:
        """Search git log with filters."""
        cmd = ["git", "log", f"--max-count={max_count}", "--oneline"]
        
        if pattern:
            # Search in commit message and changes
            cmd.extend(["--grep", pattern, f"-G{pattern}"])
        
        if branch:
            cmd.append(branch)
        else:
            cmd.append("--all")
        
        if author:
            cmd.extend(["--author", author])
        
        if since:
            cmd.extend(["--since", since])
        
        if until:
            cmd.extend(["--until", until])
        
        if file_pattern:
            cmd.extend(["--", file_pattern])
        
        result = subprocess.run(
            cmd, cwd=repo_path, capture_output=True, text=True
        )
        
        if result.returncode == 0 and result.stdout.strip():
            lines = result.stdout.strip().split('\n')
            await tool_ctx.info(f"Found {len(lines)} commits")
            return f"Found {len(lines)} commits:\n\n" + result.stdout
        else:
            return "No commits found matching criteria"

    async def _search_blame(
        self, repo_path: str, pattern: str, case_sensitive: bool,
        file_pattern: str | None, tool_ctx
    ) -> str:
        """Search using git blame to find who changed lines."""
        if not file_pattern:
            return "Error: file_pattern is required for blame search"
        
        # First, find files matching the pattern
        cmd = ["git", "ls-files", file_pattern]
        result = subprocess.run(
            cmd, cwd=repo_path, capture_output=True, text=True
        )
        
        if result.returncode != 0 or not result.stdout.strip():
            return f"No files found matching: {file_pattern}"
        
        files = result.stdout.strip().split('\n')
        all_matches = []
        
        for file_path in files[:10]:  # Limit to 10 files
            # Get blame for the file
            cmd = ["git", "blame", "-l", file_path]
            result = subprocess.run(
                cmd, cwd=repo_path, capture_output=True, text=True
            )
            
            if result.returncode == 0:
                # Search for pattern in blame output
                flags = 0 if case_sensitive else re.IGNORECASE
                for line in result.stdout.split('\n'):
                    if re.search(pattern, line, flags):
                        all_matches.append(f"{file_path}: {line}")
        
        if all_matches:
            await tool_ctx.info(f"Found {len(all_matches)} matching lines")
            return f"Found {len(all_matches)} lines matching '{pattern}':\n\n" + \
                   "\n".join(all_matches[:50])  # Limit output
        else:
            return f"No lines found matching: {pattern}"

    def _format_grep_results(self, lines: list[str], pattern: str) -> str:
        """Format git grep results nicely."""
        output = []
        current_ref = None
        
        for line in lines:
            if ':' in line:
                parts = line.split(':', 3)
                if len(parts) >= 3:
                    ref = parts[0]
                    file_path = parts[1]
                    line_num = parts[2]
                    content = parts[3] if len(parts) > 3 else ""
                    
                    if ref != current_ref:
                        current_ref = ref
                        output.append(f"\n=== {ref} ===")
                    
                    output.append(f"{file_path}:{line_num}: {content}")
        
        return f"Found matches for '{pattern}':\n" + "\n".join(output)

    def _highlight_diff_matches(
        self, diff_output: str, pattern: str, case_sensitive: bool
    ) -> str:
        """Highlight matching lines in diff output."""
        lines = diff_output.split('\n')
        output = []
        flags = 0 if case_sensitive else re.IGNORECASE
        
        for line in lines:
            if line.startswith(('+', '-')) and not line.startswith(('+++', '---')):
                if re.search(pattern, line[1:], flags):
                    output.append(f">>> {line}")  # Highlight matching lines
                else:
                    output.append(line)
            else:
                output.append(line)
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass