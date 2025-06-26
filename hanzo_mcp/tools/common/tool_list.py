"""List all available tools and their status."""

from typing import Annotated, TypedDict, Unpack, final, override, Optional

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.tool_enable import ToolEnableTool


ShowDisabled = Annotated[
    bool,
    Field(
        description="Show only disabled tools",
        default=False,
    ),
]

ShowEnabled = Annotated[
    bool,
    Field(
        description="Show only enabled tools",
        default=False,
    ),
]

Category = Annotated[
    Optional[str],
    Field(
        description="Filter by category (filesystem, shell, database, etc.)",
        default=None,
    ),
]


class ToolListParams(TypedDict, total=False):
    """Parameters for tool list."""

    show_disabled: bool
    show_enabled: bool
    category: Optional[str]


@final
class ToolListTool(BaseTool):
    """Tool for listing all available tools and their status."""
    
    # Tool information organized by category
    TOOL_INFO = {
        "filesystem": [
            ("read", "Read contents of files"),
            ("write", "Write contents to files"),
            ("edit", "Edit specific parts of files"),
            ("multi_edit", "Make multiple edits to a file"),
            ("tree", "Directory tree visualization (Unix-style)"),
            ("find", "Find text in files (rg/ag/ack/grep)"),
            ("symbols", "Code symbols search with tree-sitter"),
            ("search", "Unified search (parallel grep/symbols/vector/git)"),
            ("git_search", "Search git history"),
            ("glob", "Find files by name pattern"),
            ("content_replace", "Replace content across files"),
        ],
        "shell": [
            ("run_command", "Execute shell commands (--background option)"),
            ("processes", "List background processes"),
            ("pkill", "Kill background processes"),
            ("logs", "View process logs"),
            ("uvx", "Run Python packages (--background option)"),
            ("npx", "Run Node.js packages (--background option)"),
        ],
        "database": [
            ("sql", "SQLite operations (query/search/schema/stats)"),
            ("graph", "Graph database (query/add/remove/search/stats)"),
            ("vector", "Semantic search (search/index/stats/clear)"),
        ],
        "ai": [
            ("llm", "LLM interface (query/consensus/list/models/enable/disable)"),
            ("agent", "AI agents (run/start/call/stop/list with A2A support)"),
            ("mcp", "MCP servers (list/add/remove/enable/disable/restart)"),
        ],
        "config": [
            ("config", "Git-style configuration (get/set/list/toggle)"),
            ("tool_enable", "Enable tools"),
            ("tool_disable", "Disable tools"),
            ("tool_list", "List all tools (this tool)"),
        ],
        "productivity": [
            ("todo", "Todo management (list/add/update/remove/clear)"),
            ("jupyter", "Jupyter notebooks (read/edit/create/delete/execute)"),
            ("think", "Structured thinking space"),
        ],
        "system": [
            ("stats", "System and resource statistics"),
            ("batch", "Run multiple tools in parallel"),
        ],
        "legacy": [
            ("directory_tree", "Legacy: Use 'tree' instead"),
            ("grep", "Legacy: Use 'find' instead"),
            ("grep_ast", "Legacy: Use 'symbols' instead"),
            ("batch_search", "Legacy: Use 'search' instead"),
            ("find_files", "Legacy: Use 'glob' instead"),
            ("run_background", "Legacy: Use 'run_command --background'"),
            ("uvx_background", "Legacy: Use 'uvx --background'"),
            ("npx_background", "Legacy: Use 'npx --background'"),
            ("sql_query", "Legacy: Use 'sql' instead"),
            ("sql_search", "Legacy: Use 'sql --action search'"),
            ("sql_stats", "Legacy: Use 'sql --action stats'"),
            ("graph_add", "Legacy: Use 'graph --action add'"),
            ("graph_remove", "Legacy: Use 'graph --action remove'"),
            ("graph_query", "Legacy: Use 'graph' instead"),
            ("graph_search", "Legacy: Use 'graph --action search'"),
            ("graph_stats", "Legacy: Use 'graph --action stats'"),
            ("vector_index", "Legacy: Use 'vector --action index'"),
            ("vector_search", "Legacy: Use 'vector' instead"),
            ("dispatch_agent", "Legacy: Use 'agent' instead"),
            ("todo_read", "Legacy: Use 'todo' instead"),
            ("todo_write", "Legacy: Use 'todo --action add/update'"),
            ("notebook_read", "Legacy: Use 'jupyter' instead"),
            ("notebook_edit", "Legacy: Use 'jupyter --action edit'"),
        ],
    }

    def __init__(self):
        """Initialize the tool list tool."""
        pass

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "tool_list"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """List all available tools and their current status.

Shows:
- Tool names and descriptions
- Whether each tool is enabled or disabled
- Tools organized by category

Examples:
- tool_list                    # Show all tools
- tool_list --show-disabled    # Show only disabled tools
- tool_list --show-enabled     # Show only enabled tools
- tool_list --category shell   # Show only shell tools

Use 'tool_enable' and 'tool_disable' to change tool status.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ToolListParams],
    ) -> str:
        """List all tools.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            List of tools and their status
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        show_disabled = params.get("show_disabled", False)
        show_enabled = params.get("show_enabled", False)
        category_filter = params.get("category")

        # Get all tool states
        all_states = ToolEnableTool.get_all_states()
        
        output = []
        
        # Header
        if show_disabled:
            output.append("=== Disabled Tools ===")
        elif show_enabled:
            output.append("=== Enabled Tools ===")
        else:
            output.append("=== All Available Tools ===")
        
        if category_filter:
            output.append(f"Category: {category_filter}")
        
        output.append("")
        
        # Count statistics
        total_tools = 0
        disabled_count = 0
        shown_count = 0
        
        # Iterate through categories
        categories = [category_filter] if category_filter and category_filter in self.TOOL_INFO else self.TOOL_INFO.keys()
        
        for category in categories:
            if category not in self.TOOL_INFO:
                continue
                
            category_tools = self.TOOL_INFO[category]
            category_shown = []
            
            for tool_name, description in category_tools:
                total_tools += 1
                is_enabled = ToolEnableTool.is_tool_enabled(tool_name)
                
                if not is_enabled:
                    disabled_count += 1
                
                # Apply filters
                if show_disabled and is_enabled:
                    continue
                if show_enabled and not is_enabled:
                    continue
                
                status = "✅" if is_enabled else "❌"
                category_shown.append((tool_name, description, status))
                shown_count += 1
            
            # Show category if it has tools
            if category_shown:
                output.append(f"=== {category.title()} Tools ===")
                
                # Find max tool name length for alignment
                max_name_len = max(len(name) for name, _, _ in category_shown)
                
                for tool_name, description, status in category_shown:
                    output.append(f"{status} {tool_name.ljust(max_name_len)} - {description}")
                
                output.append("")
        
        # Summary
        if not show_disabled and not show_enabled:
            output.append("=== Summary ===")
            output.append(f"Total tools: {total_tools}")
            output.append(f"Enabled: {total_tools - disabled_count}")
            output.append(f"Disabled: {disabled_count}")
        else:
            output.append(f"Showing {shown_count} tool(s)")
        
        if disabled_count > 0 and not show_disabled:
            output.append("\nUse 'tool_list --show-disabled' to see disabled tools.")
            output.append("Use 'tool_enable --tool <name>' to enable a tool.")
        
        if show_disabled:
            output.append("\nUse 'tool_enable --tool <name>' to enable these tools.")
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
