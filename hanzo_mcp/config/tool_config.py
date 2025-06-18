"""Tool configuration definitions for Hanzo MCP."""

from enum import Enum
from typing import Dict, List, Optional
from dataclasses import dataclass


class ToolCategory(str, Enum):
    """Categories of tools available in Hanzo MCP."""
    FILESYSTEM = "filesystem"
    SHELL = "shell"
    JUPYTER = "jupyter"
    TODO = "todo"
    AGENT = "agent"
    COMMON = "common"
    VECTOR = "vector"


@dataclass
class ToolConfig:
    """Configuration for an individual tool."""
    name: str
    category: ToolCategory
    enabled: bool = True
    description: str = ""
    requires_permissions: bool = True
    cli_flag: str = ""
    
    def __post_init__(self):
        """Generate CLI flag if not provided."""
        if not self.cli_flag:
            self.cli_flag = f"--{'enable' if self.enabled else 'disable'}-{self.name.replace('_', '-')}"


# Complete tool registry with all 17 tools
TOOL_REGISTRY: Dict[str, ToolConfig] = {
    # Filesystem Tools (8)
    "read": ToolConfig(
        name="read",
        category=ToolCategory.FILESYSTEM,
        description="Read file contents with line numbers and truncation support",
        cli_flag="--disable-read"
    ),
    "write": ToolConfig(
        name="write", 
        category=ToolCategory.FILESYSTEM,
        description="Write content to files, create new files or overwrite existing ones",
        cli_flag="--disable-write"
    ),
    "edit": ToolConfig(
        name="edit",
        category=ToolCategory.FILESYSTEM, 
        description="Make precise string replacements in files with validation",
        cli_flag="--disable-edit"
    ),
    "multi_edit": ToolConfig(
        name="multi_edit",
        category=ToolCategory.FILESYSTEM,
        description="Perform multiple edits to a single file in one operation", 
        cli_flag="--disable-multi-edit"
    ),
    "directory_tree": ToolConfig(
        name="directory_tree",
        category=ToolCategory.FILESYSTEM,
        description="Display directory structure as a tree",
        cli_flag="--disable-directory-tree"
    ),
    "grep": ToolConfig(
        name="grep",
        category=ToolCategory.FILESYSTEM,
        description="Fast content search using ripgrep or fallback Python implementation",
        cli_flag="--disable-grep"
    ),
    "grep_ast": ToolConfig(
        name="grep_ast", 
        category=ToolCategory.FILESYSTEM,
        description="Search source code with AST context using tree-sitter",
        cli_flag="--disable-grep-ast"
    ),
    "content_replace": ToolConfig(
        name="content_replace",
        category=ToolCategory.FILESYSTEM,
        description="Bulk text replacement across multiple files",
        cli_flag="--disable-content-replace"
    ),
    
    # Shell Tools (1)
    "run_command": ToolConfig(
        name="run_command",
        category=ToolCategory.SHELL,
        description="Execute shell commands with session support",
        cli_flag="--disable-run-command"
    ),
    
    # Jupyter Tools (2)
    "notebook_read": ToolConfig(
        name="notebook_read",
        category=ToolCategory.JUPYTER,
        description="Read Jupyter notebook files (.ipynb)",
        cli_flag="--disable-notebook-read"
    ),
    "notebook_edit": ToolConfig(
        name="notebook_edit",
        category=ToolCategory.JUPYTER,
        description="Edit Jupyter notebook cells (replace, insert, delete)",
        cli_flag="--disable-notebook-edit"
    ),
    
    # Todo Tools (2)
    "todo_read": ToolConfig(
        name="todo_read",
        category=ToolCategory.TODO,
        description="Read the current todo list for a session",
        cli_flag="--disable-todo-read"
    ),
    "todo_write": ToolConfig(
        name="todo_write", 
        category=ToolCategory.TODO,
        description="Create and manage structured task lists",
        cli_flag="--disable-todo-write"
    ),
    
    # Agent Tools (1)
    "dispatch_agent": ToolConfig(
        name="dispatch_agent",
        category=ToolCategory.AGENT,
        enabled=False,  # Disabled by default
        description="Delegate tasks to sub-agents for concurrent/specialized processing",
        cli_flag="--enable-dispatch-agent"
    ),
    
    # Common Tools (3)
    "think": ToolConfig(
        name="think",
        category=ToolCategory.COMMON,
        description="Provide structured thinking space for complex reasoning",
        cli_flag="--disable-think"
    ),
    "batch": ToolConfig(
        name="batch",
        category=ToolCategory.COMMON,
        description="Execute multiple tools in parallel or serial",
        cli_flag="--disable-batch"
    ),
    
    # Vector Tools (2)
    "vector_index": ToolConfig(
        name="vector_index",
        category=ToolCategory.VECTOR,
        enabled=False,  # Disabled by default
        description="Index documents in local vector database for semantic search",
        cli_flag="--enable-vector-index"
    ),
    "vector_search": ToolConfig(
        name="vector_search",
        category=ToolCategory.VECTOR,
        enabled=False,  # Disabled by default
        description="Search documents using semantic similarity in vector database",
        cli_flag="--enable-vector-search"
    ),
}


def get_tools_by_category(category: ToolCategory) -> List[ToolConfig]:
    """Get all tools in a specific category."""
    return [tool for tool in TOOL_REGISTRY.values() if tool.category == category]


def get_enabled_tools() -> List[ToolConfig]:
    """Get all enabled tools."""
    return [tool for tool in TOOL_REGISTRY.values() if tool.enabled]


def get_disabled_tools() -> List[ToolConfig]:
    """Get all disabled tools."""
    return [tool for tool in TOOL_REGISTRY.values() if not tool.enabled]


def enable_tool(tool_name: str) -> bool:
    """Enable a specific tool. Returns True if successful."""
    if tool_name in TOOL_REGISTRY:
        TOOL_REGISTRY[tool_name].enabled = True
        return True
    return False


def disable_tool(tool_name: str) -> bool:
    """Disable a specific tool. Returns True if successful."""
    if tool_name in TOOL_REGISTRY:
        TOOL_REGISTRY[tool_name].enabled = False
        return True
    return False


def is_tool_enabled(tool_name: str) -> bool:
    """Check if a tool is enabled."""
    return TOOL_REGISTRY.get(tool_name, ToolConfig("", ToolCategory.COMMON, False)).enabled