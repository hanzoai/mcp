"""Enhanced command-line interface for the Hanzo MCP server with full tool configuration."""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, cast

from hanzo_mcp.config import HanzoMCPSettings, load_settings, save_settings, TOOL_REGISTRY
from hanzo_mcp.server import HanzoMCPServer


def create_parser() -> argparse.ArgumentParser:
    """Create the argument parser with all tool configuration options."""
    parser = argparse.ArgumentParser(
        description="Hanzo MCP server with comprehensive tool configuration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Tool Configuration:
  Each tool can be individually enabled/disabled using CLI flags.
  Use --list-tools to see all available tools and their current status.
  
Configuration Files:
  Global: ~/.config/hanzo/mcp-settings.json
  Project: ./.hanzo-mcp.json or ./.hanzo/mcp-settings.json
  
Examples:
  # Start server with only read tools
  hanzo-mcp --disable-write --disable-edit --disable-multi-edit
  
  # Enable agent tool with custom model
  hanzo-mcp --enable-dispatch-agent --agent-model anthropic/claude-3-sonnet
  
  # Save current configuration
  hanzo-mcp --save-config
        """
    )

    # Basic server options
    server_group = parser.add_argument_group("Server Configuration")
    server_group.add_argument(
        "--name",
        default="hanzo-mcp",
        help="Name of the MCP server (default: hanzo-mcp)",
    )
    server_group.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)",
    )
    server_group.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host for SSE server (default: 127.0.0.1)",
    )
    server_group.add_argument(
        "--port",
        type=int,
        default=3000,
        help="Port for SSE server (default: 3000)",
    )
    server_group.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Logging level (default: INFO)",
    )
    server_group.add_argument(
        "--command-timeout",
        type=float,
        default=120.0,
        help="Default timeout for command execution in seconds (default: 120.0)",
    )

    # Path configuration
    path_group = parser.add_argument_group("Path Configuration")
    path_group.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)",
    )
    path_group.add_argument(
        "--project",
        action="append", 
        dest="project_paths",
        help="Add a project path (can be specified multiple times)",
    )
    path_group.add_argument(
        "--project-dir",
        help="Single project directory (added to both allowed and project paths)",
    )

    # Individual tool configuration
    tool_group = parser.add_argument_group("Individual Tool Configuration")
    
    # Add CLI flags for each tool
    for tool_name, tool_config in TOOL_REGISTRY.items():
        flag_name = tool_config.cli_flag.lstrip('-')
        help_text = f"{tool_config.description}"
        
        if tool_config.enabled:
            # Tool is enabled by default, add disable flag
            tool_group.add_argument(
                f"--disable-{tool_name.replace('_', '-')}",
                action="store_true",
                help=f"Disable {tool_name} tool: {help_text}",
            )
        else:
            # Tool is disabled by default, add enable flag  
            tool_group.add_argument(
                f"--enable-{tool_name.replace('_', '-')}",
                action="store_true",
                help=f"Enable {tool_name} tool: {help_text}",
            )

    # Category-level tool configuration (for backward compatibility)
    category_group = parser.add_argument_group("Category-level Tool Configuration")
    category_group.add_argument(
        "--disable-write-tools",
        action="store_true",
        help="Disable all write tools (write, edit, multi_edit, content_replace)",
    )
    category_group.add_argument(
        "--disable-search-tools", 
        action="store_true",
        help="Disable all search tools (grep, grep_ast)",
    )
    category_group.add_argument(
        "--disable-filesystem-tools",
        action="store_true",
        help="Disable all filesystem tools",
    )
    category_group.add_argument(
        "--disable-jupyter-tools",
        action="store_true",
        help="Disable all Jupyter notebook tools",
    )
    category_group.add_argument(
        "--disable-shell-tools",
        action="store_true", 
        help="Disable shell command execution tools",
    )
    category_group.add_argument(
        "--disable-todo-tools",
        action="store_true",
        help="Disable todo management tools",
    )

    # Agent configuration
    agent_group = parser.add_argument_group("Agent Tool Configuration")
    agent_group.add_argument(
        "--agent-model",
        help="Model name in LiteLLM format (e.g., 'openai/gpt-4o', 'anthropic/claude-3-sonnet')",
    )
    agent_group.add_argument(
        "--agent-max-tokens",
        type=int,
        help="Maximum tokens for agent responses",
    )
    agent_group.add_argument(
        "--agent-api-key",
        help="API key for the LLM provider",
    )
    agent_group.add_argument(
        "--agent-base-url",
        help="Base URL for the LLM provider API endpoint",
    )
    agent_group.add_argument(
        "--agent-max-iterations",
        type=int,
        default=10,
        help="Maximum iterations for agent (default: 10)",
    )
    agent_group.add_argument(
        "--agent-max-tool-uses",
        type=int,
        default=30,
        help="Maximum tool uses for agent (default: 30)",
    )

    # Vector store configuration
    vector_group = parser.add_argument_group("Vector Store Configuration")
    vector_group.add_argument(
        "--enable-vector-store",
        action="store_true",
        help="Enable local vector store (Infinity database)",
    )
    vector_group.add_argument(
        "--vector-store-path",
        help="Path for vector store data (default: ~/.config/hanzo/vector-store)",
    )
    vector_group.add_argument(
        "--embedding-model",
        default="text-embedding-3-small",
        help="Embedding model for vector store (default: text-embedding-3-small)",
    )

    # Configuration management
    config_group = parser.add_argument_group("Configuration Management")
    config_group.add_argument(
        "--config-file",
        help="Load configuration from specific file",
    )
    config_group.add_argument(
        "--save-config",
        action="store_true",
        help="Save current configuration to global config file",
    )
    config_group.add_argument(
        "--save-project-config",
        action="store_true", 
        help="Save current configuration to project config file",
    )
    config_group.add_argument(
        "--list-tools",
        action="store_true",
        help="List all available tools and their status",
    )

    # Installation
    install_group = parser.add_argument_group("Installation")
    install_group.add_argument(
        "--install",
        action="store_true",
        help="Install server configuration in Claude Desktop",
    )

    return parser


def apply_cli_overrides(args: argparse.Namespace) -> Dict[str, Any]:
    """Convert CLI arguments to configuration overrides."""
    overrides = {}

    # Server configuration
    server_config = {}
    if hasattr(args, 'name') and args.name != "hanzo-mcp":
        server_config["name"] = args.name
    if hasattr(args, 'host') and args.host != "127.0.0.1":
        server_config["host"] = args.host
    if hasattr(args, 'port') and args.port != 3000:
        server_config["port"] = args.port
    if hasattr(args, 'transport') and args.transport != "stdio":
        server_config["transport"] = args.transport
    if hasattr(args, 'log_level') and args.log_level != "INFO":
        server_config["log_level"] = args.log_level
    if hasattr(args, 'command_timeout') and args.command_timeout != 120.0:
        server_config["command_timeout"] = args.command_timeout
    
    if server_config:
        overrides["server"] = server_config

    # Path configuration
    if hasattr(args, 'allowed_paths') and args.allowed_paths:
        overrides["allowed_paths"] = args.allowed_paths
    if hasattr(args, 'project_paths') and args.project_paths:
        overrides["project_paths"] = args.project_paths  
    if hasattr(args, 'project_dir') and args.project_dir:
        overrides["project_dir"] = args.project_dir

    # Tool configuration
    enabled_tools = {}
    
    # Handle individual tool flags
    for tool_name, tool_config in TOOL_REGISTRY.items():
        flag_name = tool_name.replace('_', '-')
        
        if tool_config.enabled:
            # Check for disable flag
            disable_flag = f"disable_{tool_name}"
            if hasattr(args, disable_flag) and getattr(args, disable_flag):
                enabled_tools[tool_name] = False
        else:
            # Check for enable flag
            enable_flag = f"enable_{tool_name}"
            if hasattr(args, enable_flag) and getattr(args, enable_flag):
                enabled_tools[tool_name] = True

    # Handle category-level disables
    if hasattr(args, 'disable_write_tools') and args.disable_write_tools:
        for tool_name in ["write", "edit", "multi_edit", "content_replace"]:
            enabled_tools[tool_name] = False
    
    if hasattr(args, 'disable_search_tools') and args.disable_search_tools:
        for tool_name in ["grep", "grep_ast"]:
            enabled_tools[tool_name] = False
    
    if hasattr(args, 'disable_filesystem_tools') and args.disable_filesystem_tools:
        filesystem_tools = ["read", "write", "edit", "multi_edit", "directory_tree", 
                          "grep", "grep_ast", "content_replace"]
        for tool_name in filesystem_tools:
            enabled_tools[tool_name] = False
    
    if hasattr(args, 'disable_jupyter_tools') and args.disable_jupyter_tools:
        for tool_name in ["notebook_read", "notebook_edit"]:
            enabled_tools[tool_name] = False
    
    if hasattr(args, 'disable_shell_tools') and args.disable_shell_tools:
        enabled_tools["run_command"] = False
    
    if hasattr(args, 'disable_todo_tools') and args.disable_todo_tools:
        for tool_name in ["todo_read", "todo_write"]:
            enabled_tools[tool_name] = False

    if enabled_tools:
        overrides["enabled_tools"] = enabled_tools

    # Agent configuration
    agent_config = {}
    if hasattr(args, 'agent_model') and args.agent_model:
        agent_config["model"] = args.agent_model
        agent_config["enabled"] = True
    if hasattr(args, 'agent_api_key') and args.agent_api_key:
        agent_config["api_key"] = args.agent_api_key
    if hasattr(args, 'agent_base_url') and args.agent_base_url:
        agent_config["base_url"] = args.agent_base_url
    if hasattr(args, 'agent_max_tokens') and args.agent_max_tokens:
        agent_config["max_tokens"] = args.agent_max_tokens
    if hasattr(args, 'agent_max_iterations') and args.agent_max_iterations != 10:
        agent_config["max_iterations"] = args.agent_max_iterations
    if hasattr(args, 'agent_max_tool_uses') and args.agent_max_tool_uses != 30:
        agent_config["max_tool_uses"] = args.agent_max_tool_uses
    
    if agent_config:
        overrides["agent"] = agent_config

    # Vector store configuration
    vector_config = {}
    if hasattr(args, 'enable_vector_store') and args.enable_vector_store:
        vector_config["enabled"] = True
    if hasattr(args, 'vector_store_path') and args.vector_store_path:
        vector_config["data_path"] = args.vector_store_path
    if hasattr(args, 'embedding_model') and args.embedding_model != "text-embedding-3-small":
        vector_config["embedding_model"] = args.embedding_model
    
    if vector_config:
        overrides["vector_store"] = vector_config

    return overrides


def list_tools(settings: HanzoMCPSettings) -> None:
    """List all tools and their current status."""
    print("Hanzo MCP Tools Status:")
    print("=" * 50)
    
    categories = {}
    for tool_name, tool_config in TOOL_REGISTRY.items():
        category = tool_config.category.value
        if category not in categories:
            categories[category] = []
        
        enabled = settings.is_tool_enabled(tool_name)
        status = "✅ ENABLED " if enabled else "❌ DISABLED"
        categories[category].append((tool_name, status, tool_config.description))
    
    for category, tools in categories.items():
        print(f"\n{category.upper()} TOOLS:")
        print("-" * 30)
        for tool_name, status, description in tools:
            print(f"  {status} {tool_name:<15} - {description}")
    
    print(f"\nTotal: {len(TOOL_REGISTRY)} tools")
    enabled_count = len(settings.get_enabled_tools())
    print(f"Enabled: {enabled_count}, Disabled: {len(TOOL_REGISTRY) - enabled_count}")


def main() -> None:
    """Run the enhanced CLI for the Hanzo MCP server."""
    parser = create_parser()
    args = parser.parse_args()

    # Handle list tools command
    if hasattr(args, 'list_tools') and args.list_tools:
        settings = load_settings()
        list_tools(settings)
        return

    # Load configuration with CLI overrides
    config_overrides = apply_cli_overrides(args)
    project_dir = getattr(args, 'project_dir', None)
    settings = load_settings(project_dir=project_dir, config_overrides=config_overrides)

    # Handle configuration saving
    if hasattr(args, 'save_config') and args.save_config:
        saved_path = save_settings(settings, global_config=True)
        print(f"Configuration saved to: {saved_path}")
        return
    
    if hasattr(args, 'save_project_config') and args.save_project_config:
        saved_path = save_settings(settings, global_config=False)
        print(f"Project configuration saved to: {saved_path}")
        return

    # Handle installation
    if hasattr(args, 'install') and args.install:
        from hanzo_mcp.cli import install_claude_desktop_config
        install_claude_desktop_config(
            settings.server.name,
            settings.allowed_paths,
        )
        return

    # Set up allowed paths
    allowed_paths = settings.allowed_paths[:]
    if settings.project_dir and settings.project_dir not in allowed_paths:
        allowed_paths.append(settings.project_dir)
    
    if not allowed_paths:
        allowed_paths = [os.getcwd()]

    # Create and run server
    server = HanzoMCPServer(
        name=settings.server.name,
        allowed_paths=allowed_paths,
        project_dir=settings.project_dir,
        agent_model=settings.agent.model,
        agent_max_tokens=settings.agent.max_tokens,
        agent_api_key=settings.agent.api_key,
        agent_base_url=settings.agent.base_url,
        agent_max_iterations=settings.agent.max_iterations,
        agent_max_tool_uses=settings.agent.max_tool_uses,
        enable_agent_tool=settings.agent.enabled or settings.is_tool_enabled("dispatch_agent"),
        disable_write_tools=not any(settings.is_tool_enabled(t) for t in ["write", "edit", "multi_edit", "content_replace"]),
        disable_search_tools=not any(settings.is_tool_enabled(t) for t in ["grep", "grep_ast"]),
        host=settings.server.host,
        port=settings.server.port,
        enabled_tools=settings.enabled_tools,  # Pass individual tool configuration
    )
    
    server.run(transport=settings.server.transport)


if __name__ == "__main__":
    main()