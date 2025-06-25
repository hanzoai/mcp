"""Tools package for Hanzo MCP.

This package contains all the tools for the Hanzo MCP server.
It provides a unified interface for registering all tools with an MCP server.

This includes a "think" tool implementation based on Anthropic's research showing
improved performance for complex tool-based interactions when Claude has a dedicated
space for structured thinking. It also includes an "agent" tool that enables Claude
to delegate tasks to sub-agents for concurrent execution and specialized processing.
"""

from fastmcp import FastMCP

from hanzo_mcp.tools.agent import register_agent_tools
from hanzo_mcp.tools.common import register_batch_tool, register_thinking_tool
from hanzo_mcp.tools.common.base import BaseTool

from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem import register_filesystem_tools
from hanzo_mcp.tools.jupyter import register_jupyter_tools
from hanzo_mcp.tools.shell import register_shell_tools
from hanzo_mcp.tools.todo import register_todo_tools
from hanzo_mcp.tools.vector import register_vector_tools


def register_all_tools(
    mcp_server: FastMCP,
    permission_manager: PermissionManager,
    agent_model: str | None = None,
    agent_max_tokens: int | None = None,
    agent_api_key: str | None = None,
    agent_base_url: str | None = None,
    agent_max_iterations: int = 10,
    agent_max_tool_uses: int = 30,
    enable_agent_tool: bool = False,
    disable_write_tools: bool = False,
    disable_search_tools: bool = False,
    enabled_tools: dict[str, bool] | None = None,
    vector_config: dict | None = None,
) -> None:
    """Register all Hanzo tools with the MCP server.

    Args:
        mcp_server: The FastMCP server instance
        permission_manager: Permission manager for access control
        agent_model: Optional model name for agent tool in LiteLLM format
        agent_max_tokens: Optional maximum tokens for agent responses
        agent_api_key: Optional API key for the LLM provider
        agent_base_url: Optional base URL for the LLM provider API endpoint
        agent_max_iterations: Maximum number of iterations for agent (default: 10)
        agent_max_tool_uses: Maximum number of total tool uses for agent (default: 30)
        enable_agent_tool: Whether to enable the agent tool (default: False)
        disable_write_tools: Whether to disable write tools (default: False)
        disable_search_tools: Whether to disable search tools (default: False)
        enabled_tools: Dictionary of individual tool enable/disable states (default: None)
        vector_config: Vector store configuration (default: None)
    """
    # Dictionary to store all registered tools
    all_tools: dict[str, BaseTool] = {}
    
    # Use individual tool configuration if provided, otherwise fall back to category-level flags
    tool_config = enabled_tools or {}
    
    def is_tool_enabled(tool_name: str, category_enabled: bool = True) -> bool:
        """Check if a specific tool should be enabled."""
        if tool_name in tool_config:
            return tool_config[tool_name]
        return category_enabled

    # Register filesystem tools with individual configuration
    filesystem_enabled = {
        "read": is_tool_enabled("read", True),
        "write": is_tool_enabled("write", not disable_write_tools),
        "edit": is_tool_enabled("edit", not disable_write_tools),
        "multi_edit": is_tool_enabled("multi_edit", not disable_write_tools),
        "directory_tree": is_tool_enabled("directory_tree", True),
        "grep": is_tool_enabled("grep", not disable_search_tools),
        "grep_ast": is_tool_enabled("grep_ast", not disable_search_tools),
        "content_replace": is_tool_enabled("content_replace", not disable_write_tools),
        "unified_search": is_tool_enabled("unified_search", not disable_search_tools),
    }
    
    # Vector tools setup (needed for unified search)
    project_manager = None
    vector_enabled = {
        "vector_index": is_tool_enabled("vector_index", False),
        "vector_search": is_tool_enabled("vector_search", False),
    }
    
    # Create project manager if vector tools or unified search are enabled
    if any(vector_enabled.values()) or filesystem_enabled.get("unified_search", False):
        if vector_config:
            from hanzo_mcp.tools.vector.project_manager import ProjectVectorManager
            search_paths = [str(path) for path in permission_manager.allowed_paths]
            project_manager = ProjectVectorManager(
                global_db_path=vector_config.get("data_path"),
                embedding_model=vector_config.get("embedding_model", "text-embedding-3-small"),
                dimension=vector_config.get("dimension", 1536),
            )
            # Auto-detect projects from search paths
            detected_projects = project_manager.detect_projects(search_paths)
            print(f"Detected {len(detected_projects)} projects with LLM.md files")
    
    filesystem_tools = register_filesystem_tools(
        mcp_server, 
        permission_manager, 
        enabled_tools=filesystem_enabled,
        project_manager=project_manager,
    )
    for tool in filesystem_tools:
        all_tools[tool.name] = tool

    # Register jupyter tools if enabled
    jupyter_enabled = {
        "notebook_read": is_tool_enabled("notebook_read", True),
        "notebook_edit": is_tool_enabled("notebook_edit", True),
    }
    
    if any(jupyter_enabled.values()):
        jupyter_tools = register_jupyter_tools(mcp_server, permission_manager, enabled_tools=jupyter_enabled)
        for tool in jupyter_tools:
            all_tools[tool.name] = tool

    # Register shell tools if enabled
    if is_tool_enabled("run_command", True):
        shell_tools = register_shell_tools(mcp_server, permission_manager)
        for tool in shell_tools:
            all_tools[tool.name] = tool

    # Register agent tools if enabled
    agent_enabled = enable_agent_tool or is_tool_enabled("dispatch_agent", False)
    if agent_enabled:
        agent_tools = register_agent_tools(
            mcp_server,
            permission_manager,
            agent_model=agent_model,
            agent_max_tokens=agent_max_tokens,
            agent_api_key=agent_api_key,
            agent_base_url=agent_base_url,
            agent_max_iterations=agent_max_iterations,
            agent_max_tool_uses=agent_max_tool_uses,
        )
        for tool in agent_tools:
            all_tools[tool.name] = tool

    # Register todo tools if enabled
    todo_enabled = {
        "todo_read": is_tool_enabled("todo_read", True),
        "todo_write": is_tool_enabled("todo_write", True),
    }
    
    if any(todo_enabled.values()):
        todo_tools = register_todo_tools(mcp_server, enabled_tools=todo_enabled)
        for tool in todo_tools:
            all_tools[tool.name] = tool

    # Register thinking tool if enabled
    if is_tool_enabled("think", True):
        thinking_tool = register_thinking_tool(mcp_server)
        for tool in thinking_tool:
            all_tools[tool.name] = tool

    # Register vector tools if enabled (reuse project_manager if available)
    if any(vector_enabled.values()) and project_manager:
        vector_tools = register_vector_tools(
            mcp_server, 
            permission_manager, 
            vector_config=vector_config,
            enabled_tools=vector_enabled,
            project_manager=project_manager,
        )
        for tool in vector_tools:
            all_tools[tool.name] = tool

    # Register batch tool if enabled (batch tool is typically always enabled)
    if is_tool_enabled("batch", True):
        register_batch_tool(mcp_server, all_tools)
