"""Tools package for Hanzo AI.

This package contains all the tools for the Hanzo AI server.
It provides a interface for registering all tools with an MCP server.

This includes a "think" tool implementation based on Anthropic's research showing
improved performance for complex tool-based interactions when Claude has a dedicated
space for structured thinking. It also includes an "agent" tool that enables Claude
to delegate tasks to sub-agents for concurrent execution and specialized processing.
"""

from mcp.server import FastMCP

from hanzo_mcp.tools.agent import register_agent_tools
from hanzo_mcp.tools.common import register_batch_tool, register_thinking_tool, register_critic_tool
from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.common.tool_enable import ToolEnableTool
from hanzo_mcp.tools.common.tool_disable import ToolDisableTool
from hanzo_mcp.tools.common.tool_list import ToolListTool
from hanzo_mcp.tools.common.stats import StatsTool
from hanzo_mcp.tools.filesystem import register_filesystem_tools
from hanzo_mcp.tools.jupyter import register_jupyter_tools
from hanzo_mcp.tools.shell import register_shell_tools
from hanzo_mcp.tools.todo import register_todo_tools
from hanzo_mcp.tools.vector import register_vector_tools
from hanzo_mcp.tools.database import register_database_tools, DatabaseManager
from hanzo_mcp.tools.mcp import MCPTool, McpAddTool, McpRemoveTool, McpStatsTool
from hanzo_mcp.tools.editor import NeovimEditTool, NeovimCommandTool, NeovimSessionTool
from hanzo_mcp.tools.llm import LLMTool, LLMTool, ConsensusTool, LLMManageTool, create_provider_tools
from hanzo_mcp.tools.config.mode_tool import mode_tool
from hanzo_mcp.tools.common.mode_loader import ModeLoader
from hanzo_mcp.tools.common.mode import activate_mode_from_env
from hanzo_mcp.tools.common.plugin_loader import load_user_plugins


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
    use_mode: bool = True,
    force_mode: str | None = None,
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
        use_mode: Whether to use mode system for tool configuration (default: True)
        force_mode: Force a specific mode to be active (default: None)
    """
    # Dictionary to store all registered tools
    all_tools: dict[str, BaseTool] = {}
    
    # Load user plugins early
    try:
        plugins = load_user_plugins()
        import logging
        logger = logging.getLogger(__name__)
        if plugins:
            logger.info(f"Loaded {len(plugins)} user plugin tools: {', '.join(plugins.keys())}")
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.warning(f"Failed to load user plugins: {e}")
        plugins = {}
    
    # Apply mode configuration if enabled
    if use_mode:
        # First check for mode activation from environment
        activate_mode_from_env()
        
        tool_config = ModeLoader.get_enabled_tools_from_mode(
            base_enabled_tools=enabled_tools,
            force_mode=force_mode
        )
        # Apply mode environment variables
        ModeLoader.apply_environment_from_mode()
    else:
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
        "symbols": is_tool_enabled("symbols", not disable_search_tools),
        "git_search": is_tool_enabled("git_search", not disable_search_tools),
        "content_replace": is_tool_enabled("content_replace", not disable_write_tools),
        "batch_search": is_tool_enabled("batch_search", not disable_search_tools),
        "find_files": is_tool_enabled("find_files", True),
        "rules": is_tool_enabled("rules", True),
        "search": is_tool_enabled("search", not disable_search_tools),
    }
    
    # Vector tools setup (needed for search)
    project_manager = None
    vector_enabled = {
        "vector_index": is_tool_enabled("vector_index", False),
        "vector_search": is_tool_enabled("vector_search", False),
    }
    
    # Create project manager if vector tools, batch_search, or unified_search are enabled
    if any(vector_enabled.values()) or filesystem_enabled.get("batch_search", False) or filesystem_enabled.get("search", False):
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
            import logging
            logger = logging.getLogger(__name__)
            logger.info(f"Detected {len(detected_projects)} projects with LLM.md files")
    
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
    agent_enabled = enable_agent_tool or is_tool_enabled("agent", False) or is_tool_enabled("dispatch_agent", False)
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
        "todo": is_tool_enabled("todo", True),
        # Backward compatibility - if old names are used, enable the unified tool
        "todo_read": is_tool_enabled("todo_read", True),
        "todo_write": is_tool_enabled("todo_write", True),
    }
    
    # Enable unified todo if any of the todo tools are enabled
    if any(todo_enabled.values()):
        todo_tools = register_todo_tools(mcp_server, enabled_tools={"todo": True})
        for tool in todo_tools:
            all_tools[tool.name] = tool

    # Register thinking tool if enabled
    if is_tool_enabled("think", True):
        thinking_tool = register_thinking_tool(mcp_server)
        for tool in thinking_tool:
            all_tools[tool.name] = tool
    
    # Register critic tool if enabled
    if is_tool_enabled("critic", True):
        critic_tools = register_critic_tool(mcp_server)
        for tool in critic_tools:
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
    
    # Register database tools if enabled
    db_manager = None
    database_enabled = {
        "sql_query": is_tool_enabled("sql_query", True),
        "sql_search": is_tool_enabled("sql_search", True),
        "sql_stats": is_tool_enabled("sql_stats", True),
        "graph_add": is_tool_enabled("graph_add", True),
        "graph_remove": is_tool_enabled("graph_remove", True),
        "graph_query": is_tool_enabled("graph_query", True),
        "graph_search": is_tool_enabled("graph_search", True),
        "graph_stats": is_tool_enabled("graph_stats", True),
    }
    
    if any(database_enabled.values()):
        db_manager = DatabaseManager(permission_manager)
        database_tools = register_database_tools(
            mcp_server,
            permission_manager,
            db_manager=db_manager,
        )
        # Filter based on enabled state
        for tool in database_tools:
            if database_enabled.get(tool.name, True):
                all_tools[tool.name] = tool
    
    # Register unified MCP tool if enabled
    if is_tool_enabled("mcp", True):
        tool = MCPTool()
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    # Register legacy MCP tools if explicitly enabled (disabled by default)
    legacy_mcp_enabled = {
        "mcp_add": is_tool_enabled("mcp_add", False),
        "mcp_remove": is_tool_enabled("mcp_remove", False),
        "mcp_stats": is_tool_enabled("mcp_stats", False),
    }
    
    if legacy_mcp_enabled.get("mcp_add", False):
        tool = McpAddTool()
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    if legacy_mcp_enabled.get("mcp_remove", False):
        tool = McpRemoveTool()
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    if legacy_mcp_enabled.get("mcp_stats", False):
        tool = McpStatsTool()
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    # Register system tools (always enabled)
    # Tool enable/disable tools
    tool_enable = ToolEnableTool()
    tool_enable.register(mcp_server)
    all_tools[tool_enable.name] = tool_enable
    
    tool_disable = ToolDisableTool()
    tool_disable.register(mcp_server)
    all_tools[tool_disable.name] = tool_disable
    
    tool_list = ToolListTool()
    tool_list.register(mcp_server)
    all_tools[tool_list.name] = tool_list
    
    # Stats tool
    stats_tool = StatsTool(db_manager=db_manager)
    stats_tool.register(mcp_server)
    all_tools[stats_tool.name] = stats_tool
    
    # Mode tool (always enabled for managing tool sets)
    mode_tool.register(mcp_server)
    all_tools[mode_tool.name] = mode_tool
    
    # Register editor tools if enabled
    editor_enabled = {
        "neovim_edit": is_tool_enabled("neovim_edit", True),
        "neovim_command": is_tool_enabled("neovim_command", True),
        "neovim_session": is_tool_enabled("neovim_session", True),
    }
    
    if editor_enabled.get("neovim_edit", True):
        tool = NeovimEditTool(permission_manager)
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    if editor_enabled.get("neovim_command", True):
        tool = NeovimCommandTool(permission_manager)
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    if editor_enabled.get("neovim_session", True):
        tool = NeovimSessionTool()
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    # Register unified LLM tool if enabled
    if is_tool_enabled("llm", True):
        tool = LLMTool()
        if tool.available_providers:  # Only register if API keys found
            tool.register(mcp_server)
            all_tools[tool.name] = tool
    
    # Register consensus tool if enabled (enabled by default)
    if is_tool_enabled("consensus", True):
        tool = ConsensusTool()
        if tool.llm_tool.available_providers:
            tool.register(mcp_server)
            all_tools[tool.name] = tool

    # Register legacy LLM tools if explicitly enabled (disabled by default)
    legacy_llm_enabled = {
        "llm_legacy": is_tool_enabled("llm_legacy", False),
        "consensus": is_tool_enabled("consensus", False),
        "llm_manage": is_tool_enabled("llm_manage", False),
    }
    
    if legacy_llm_enabled.get("llm_legacy", False):
        tool = LLMTool()
        if tool.available_providers:
            tool.register(mcp_server)
            all_tools["llm_legacy"] = tool
    
    if legacy_llm_enabled.get("consensus", False):
        tool = ConsensusTool()
        if tool.llm_tool.available_providers:
            tool.register(mcp_server)
            all_tools[tool.name] = tool
    
    if legacy_llm_enabled.get("llm_manage", False):
        tool = LLMManageTool()
        tool.register(mcp_server)
        all_tools[tool.name] = tool
    
    # Register provider-specific LLM tools (disabled by default)
    if is_tool_enabled("provider_specific_llm", False):
        provider_tools = create_provider_tools()
        for tool in provider_tools:
            if is_tool_enabled(tool.name, False):
                tool.register(mcp_server)
                all_tools[tool.name] = tool
    
    # Register user plugins last (so they can override built-in tools)
    for plugin_name, plugin in plugins.items():
        if is_tool_enabled(plugin_name, True):
            try:
                tool = plugin.tool_class()
                tool.register(mcp_server)
                all_tools[tool.name] = tool
                logger.info(f"Registered plugin tool: {plugin_name}")
            except Exception as e:
                logger.error(f"Failed to register plugin tool {plugin_name}: {e}")
