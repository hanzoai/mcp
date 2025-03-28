"""Command-line tool for managing external MCP servers."""

import argparse
import asyncio
import sys
from typing import List, Optional

from hanzo_mcp.external.config_manager import MCPServerConfig
from hanzo_mcp.external.mcp_manager import ExternalMCPServerManager
from hanzo_mcp.external.registry import MCPServerRegistry


def list_servers(config: MCPServerConfig) -> None:
    """List all configured MCP servers.

    Args:
        config: The MCP server configuration
    """
    servers = config.get_all_servers()
    if not servers:
        print("No MCP servers configured.")
        return

    print("Configured MCP servers:")
    print("======================")
    for name, server_config in servers.items():
        enabled = server_config.get("enabled", True)
        description = server_config.get("description", "")
        print(f"{name}: {'Enabled' if enabled else 'Disabled'} - {description}")


def enable_server(config: MCPServerConfig, name: str) -> None:
    """Enable an MCP server.

    Args:
        config: The MCP server configuration
        name: The name of the server to enable
    """
    if config.enable_server(name):
        print(f"Server '{name}' has been enabled.")
    else:
        print(f"Failed to enable server '{name}'.")


def disable_server(config: MCPServerConfig, name: str) -> None:
    """Disable an MCP server.

    Args:
        config: The MCP server configuration
        name: The name of the server to disable
    """
    if config.disable_server(name):
        print(f"Server '{name}' has been disabled.")
    else:
        print(f"Failed to disable server '{name}'.")


def set_auto_detect(config: MCPServerConfig, enabled: bool) -> None:
    """Set auto-detection of MCP servers.

    Args:
        config: The MCP server configuration
        enabled: Whether to enable auto-detection
    """
    if config.set_auto_detect(enabled):
        print(f"Auto-detection has been {'enabled' if enabled else 'disabled'}.")
    else:
        print(f"Failed to {'enable' if enabled else 'disable'} auto-detection.")


def search_registry(registry: MCPServerRegistry, query: Optional[str] = None) -> None:
    """Search the registry for MCP servers.
    
    Args:
        registry: The MCP server registry
        query: Optional search query
    """
    servers = registry.search_servers(query or "")
    
    if not servers:
        print("No servers found in registry matching your query.")
        print("Try updating with 'registry update' or search with a different term.")
        return
    
    print("Available MCP servers:")
    print("=====================")
    
    for server_id, info in servers.items():
        print(f"{server_id}: {info.get('description', '')}")
        command_str = info.get('command', 'N/A')
        if 'args' in info and info['args']:
            command_str += f" {' '.join(info['args'])}"
        print(f"  Command: {command_str}")
        if 'homepage' in info:
            print(f"  Homepage: {info['homepage']}")
        print()


def update_registry(registry: MCPServerRegistry) -> None:
    """Update the server registry.
    
    Args:
        registry: The MCP server registry
    """
    print("Updating MCP server registry...")
    result = asyncio.run(registry.fetch_registry())
    
    if "error" in result:
        print(f"Error updating registry: {result['error']}")
    else:
        print(f"Registry updated: {len(registry.get_servers())} servers available")


def install_from_registry(registry: MCPServerRegistry, config: MCPServerConfig, server_id: str) -> None:
    """Install a server from the registry.
    
    Args:
        registry: The MCP server registry
        config: The MCP server configuration
        server_id: The ID of the server to install
    """
    print(f"Installing {server_id} from registry...")
    success = asyncio.run(registry.install_server(server_id, config))
    
    if success:
        print(f"Successfully installed {server_id}")
    else:
        print(f"Failed to install {server_id}")


def detect_servers() -> None:
    """Detect available MCP servers."""
    manager = ExternalMCPServerManager()
    enabled_servers = manager.get_enabled_servers()
    
    if not enabled_servers:
        print("No MCP servers detected.")
        return
        
    print("Detected MCP servers:")
    print("====================")
    for server in enabled_servers:
        print(f"{server.name}: {server.description}")
        print(f"  Command: {server.command}")
        print(f"  Enabled: {'Yes' if server.enabled else 'No'}")
        print()


def launch_ui() -> None:
    """Launch the MCP server management UI."""
    try:
        from hanzo_mcp.external.ui import run_management_ui
        run_management_ui()
    except ImportError as e:
        print(f"Error: Could not launch UI - {str(e)}")
        print("Make sure you have tkinter installed for your Python environment.")


def main(args: Optional[List[str]] = None) -> int:
    """Run the MCP server management tool.

    Args:
        args: Command-line arguments

    Returns:
        Exit code
    """
    parser = argparse.ArgumentParser(
        description="Manage external MCP servers for Hanzo MCP"
    )
    
    # Create subparsers for commands
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # List servers command
    list_parser = subparsers.add_parser("list", help="List configured MCP servers")
    
    # Enable server command
    enable_parser = subparsers.add_parser("enable", help="Enable an MCP server")
    enable_parser.add_argument("name", help="Name of the server to enable")
    
    # Disable server command
    disable_parser = subparsers.add_parser("disable", help="Disable an MCP server")
    disable_parser.add_argument("name", help="Name of the server to disable")
    
    # Set auto-detect command
    auto_detect_parser = subparsers.add_parser(
        "auto-detect", help="Set auto-detection of MCP servers"
    )
    auto_detect_parser.add_argument(
        "enabled",
        choices=["true", "false"],
        help="Whether to enable auto-detection",
    )
    
    # Detect servers command
    detect_parser = subparsers.add_parser("detect", help="Detect available MCP servers")
    
    # Registry commands
    registry_parser = subparsers.add_parser("registry", help="Manage MCP server registry")
    registry_subparsers = registry_parser.add_subparsers(dest="registry_command", help="Registry command")
    
    # Search registry command
    search_parser = registry_subparsers.add_parser("search", help="Search for MCP servers in the registry")
    search_parser.add_argument("query", nargs="?", help="Search query")
    
    # Update registry command
    update_parser = registry_subparsers.add_parser("update", help="Update the MCP server registry")
    
    # Install registry command
    install_parser = registry_subparsers.add_parser("install", help="Install an MCP server from the registry")
    install_parser.add_argument("server_id", help="ID of the server to install")
    
    # UI command
    ui_parser = subparsers.add_parser("ui", help="Launch the MCP server management UI")
    
    # Parse arguments
    parsed_args = parser.parse_args(args)
    
    # Create configuration
    config = MCPServerConfig()
    
    # Execute the command
    if parsed_args.command == "list":
        list_servers(config)
    elif parsed_args.command == "enable":
        enable_server(config, parsed_args.name)
    elif parsed_args.command == "disable":
        disable_server(config, parsed_args.name)
    elif parsed_args.command == "auto-detect":
        set_auto_detect(config, parsed_args.enabled == "true")
    elif parsed_args.command == "detect":
        detect_servers()
    elif parsed_args.command == "registry":
        registry = MCPServerRegistry()
        if parsed_args.registry_command == "search":
            search_registry(registry, parsed_args.query)
        elif parsed_args.registry_command == "update":
            update_registry(registry)
        elif parsed_args.registry_command == "install":
            install_from_registry(registry, config, parsed_args.server_id)
        else:
            registry_parser.print_help()
            return 1
    elif parsed_args.command == "ui":
        launch_ui()
    else:
        parser.print_help()
        return 1
        
    return 0


if __name__ == "__main__":
    sys.exit(main())
